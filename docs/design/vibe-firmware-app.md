# VIBE 升格为 ZOS 固件级 App(与音乐同级)

- 状态:已实施(2026-08-14 真机验证:侧载新固件后根环出现 VIBE,七个代理数字正常)
- 日期:2026-08-14
- 设计:Claude Fable
- 背景:VIBE 数据层已落地(见 [ADR 0010](../adr/0010-vibe-native-usage-collection.md) 与
  [vibe-usage.md](vibe-usage.md));本文只改「它长在哪儿」。

## 1. 为什么不是频道

现状是两个内容类型(`tools:vibe-duo` / `tools:vibe-agent`),布置成频道后落在 ZOS 的「轮播」环里。
频道这条路给不了 VIBE 真正需要的东西:

- **频道是定时轮播的一帧动画**。设备把一段 GIF 拉下来循环播,`ttl` 到了再拉一次。用量数字要
  「刚才变了就立刻看到」,而联动提醒(会话打到 90%、额度重置、本机 vibe coding 状态变化)
  更是**推送**语义——一段缓存的 GIF 表达不了。
- **频道没有输入**。旋钮在轮播环里是「换频道」,进不到「换代理」;按键也传不进一帧图片。
- **频道与用户内容争位置**。十个代理会把用户自己的行情、时钟挤出那个一次只显示一项的环。

所以 VIBE 和音乐一样,是**根环上的一个目的地**:自己的 Screen、自己的输入、自己的数据键。
固件原生绘制而不是拉服务端渲染的帧——这也是后续做实时提醒的唯一可行底座。

## 2. 根环与图标

`osLogic.cc` 的根环是固件内硬编码的四项(音乐/游戏/轮播/设置),频道只填「轮播」子环。改为五项:

```
音乐 → 游戏 → 轮播 → VIBE → 设置
```

放在「轮播」之后、「设置」之前:前三项的肌肉记忆不动,设置仍在末位。

`LauncherScreen::Icon` 增 `kIconVibe`,与其它根图标一样**程序化动画绘制**(12×12,无资源管线):
一条流动的波形——VIBE 就是振动。最初画的是三根涨落的竖条(用量计),换掉了:`kIconChannel`
本来就是三根竖条的均衡器,12px 下两个「房间」戴同一张脸。

它是**唯一一个不吃卡片单色强调的家族图标**:自己跑品红→紫→青的色扫。这是有意的——强调色的
作用是让卡片说明「这是哪个房间」,而这个房间的性格就是最骚的那个;游戏图标本来就是多色的,
先例在。仍守着这里的铁律:靠**位移**而不是靠亮度,波峰每周期走满 12px。

色扫用三个关键色插值而不是完整 HSV 旋转:后者有三分之一的行程落在黄绿区,而黄绿在这个环上
已经是「频道」的意思——最新的 App 每个周期都会有一瞬间长得像最老的那个。

## 3. 数据通道(协议)

### 3.1 铁律:只加新键,绝不给旧键加字段

`src/os-link.ts` 的注释写得很清楚:已部署固件对 `item` 做 `n == 4` 的**严格 arity 检查**,
多一个字段会让它整条丢弃、连频道环都没了。而未知**键**是被静默忽略的。所以 VIBE 的数据全部
走新键,且每条记录自带 agent id(不依赖行序)。

### 3.2 键定义(服务端 `OsLinkHub.serialize()` 增补)

```
vibe\t<count>\t<seq>                    # 有几个代理;seq 在载荷变化时自增
vibea\t<id>\t<label>\t<plan>            # 每个代理一行,目录序
vibes\t<id>\t<0|1>                      # stale:1 = 正在顶上一次的好数据
vibem\t<id>\t<label>\t<used>\t<limit>\t<resetSec>   # 指标行,每代理 ≤2 行(星标那两个)
```

- `used`/`limit` 是整数百分比(非 percent 单位的指标在服务端换算好再发,设备不做单位逻辑);
  没有 limit 的余额型指标发 `limit` 为 `0`,设备按纯数值渲染。
- `resetSec` 是**相对秒数**,不是绝对时间戳:设备的墙钟可能没同步,而「6 天后重置」不需要它。
  没有重置时间发 `-1`。
- `label` 是厂商自己的行标签(Session / Weekly / Credits …),与控制台、LED 完全一致。
- 一个代理都没有时只发 `vibe\t0\t<seq>`,设备画「未登录」页。

体积:七个代理各两行指标 ≈ 七行 `vibea` + 七行 `vibes` + 十四行 `vibem` ≈ 1.2 KB,
相对文档现有体量可忽略。

### 3.3 设备侧解析(`net/StateDoc.{h,cpp}`)

新增 `struct VibeAgent { std::string id, label, plan; bool stale; std::vector<VibeMetric> metrics; }`
与 `std::vector<VibeAgent> mVibe; int mVibeSeq;`。解析走既有 if-else 链,严格按各键 arity 收窄,
字段不对就跳过该行(不是整份文档)。`kProtocol` **不动**——加键不是破坏性变更,这正是该字段
承诺的语义。

### 3.4 服务端何时发

`service.ts` 在既有的 `publishOsMenu()` 旁加 `publishOsVibe()`:从
`controller.getVibeUsage(false)` 取快照(命中控制器缓存,不额外打厂商),折成上面的行,
`osLink.setVibe(...)` 幂等——载荷没变不 bump seq,不会惊动 parked 长轮询。

触发时机:①启动后首次采集完成;②每次 `onSettingsChanged`(星标改了要立刻反映);
③一个五分钟的定时器,与采集下限(`VIBE_MIN_REFRESH_MS`)同拍。设备侧不需要额外轮询——
它本来就在长轮询这份文档。

## 4. 固件 App:`VibeScreen`

### 4.1 结构

`app/src/ui/VibeScreen.{h,cpp}`,`public Screen`,遵守既有铁律:**纯 (state, nowMs) → 像素**,
不碰 SPI、不自己取时间,因此可在主机 clang++ 自检里逐帧断言。

页面是一个环:

```
页 0:总览(两个代理并排,与 LED 频道版同排版)
页 1..N:每个代理一页(12px 图标 + ≤2 条指标 + 进度条 + 重置倒计时)
```

- **旋钮左右**:翻页(环形,与频道环一致的手感)。
- **按下**:在「已用 %」与「剩余 %」之间切换(OpenUsage 也有这个切换;免费的、有用的、
  不需要新数据)。切换状态记在 `prefs`(`vibe.showLeft`),与音乐记 mode/skin 同法。
- **长按**:返回根环(全固件一致)。
- **侧键不接管**:音量/亮度是用户随时要用的,一个看数字的页面没有理由抢。

### 4.2 排版(52×16)

总览页与详情页沿用已定稿的 LED 版排版(见 [vibe-usage.md](vibe-usage.md) §3),
因为那套排版已在真机上验证过可读:

- 总览:每格 10px 图标 + 2px 间隙 + 数值列(两行 3×5 或单行 5×7),整体居中,溢出降级阶梯照搬。
- 详情:12px 图标(x=0..11)+ 行区 x=15..51,行 1 y=2..6 / 行 2 y=9..13;单字符指标标签 +
  14px 进度条 + 右对齐数值。
- 严重度配色沿用 80%/90% 两档(蓝/琥珀/红),与控制台、LED 一致。
- `stale` 的代理在右上角点一颗琥珀像素——与频道版同一约定。

### 4.3 图标:一份位图,两处消费

设备要画十个厂商的 12×12 标记。仓库已有先例:CJK 字模由离线脚本同时喂固件头文件与网页预览,
`test/pixel-glyphs.test.ts` 逐位比对两侧。VIBE 图标照此办理:

`scripts/gen-vibe-icons.ts` 增一路输出 `device/tc002-os/app/src/visual/VibeIcons.h`
(每图标 12 行 × uint16 位掩码,`bit11` 为最左),新增 `test/vibe-icons-parity.test.ts`
断言它与 `src/vibe/vibe-icons.ts` 逐位一致。这样「LED 上是什么样,面板上就是什么样」是被测试
钉住的事实,而不是巧合。

10px 那档设备用不到(总览页也用 12px 图标吗?——不,总览格宽不够,仍用 10px),所以两档都生成。

### 4.4 主机自检

`hostcheck/selfcheck.cpp` 增一组 VibeScreen 断言,与既有 screen 测试同规格:
空状态(未登录)、单代理、七代理翻页、`stale` 角标、严重度配色边界(79/80/89/90)、
「已用/剩余」切换、以及**溢出不越界**(三位数百分比 + 长标签)。

## 5. 去掉频道那条路

- `src/content-registry.ts`:删掉 `tools:vibe-duo` / `tools:vibe-agent` 两个定义
  (定义数 36 → 34,测试断言同步)。`src/vibe/vibe-render.ts` 随之删除——固件原生绘制后
  服务端不再需要渲染这两页。**注意**:`renderVibeOffline` 等函数一并删除。
- `web/src/lib/vibe.ts`:删 `buildVibeChannels` / `stripVibeChannels` / `vibePreviewChannel`
  与相关常量;`web/src/components/vibe/vibe-placement.tsx`、`vibe-preview.tsx` 删除。
- **迁移**:用户可能已经布置过 `vibe` / `vibe_<id>` 频道。服务端在启动时做一次性清理——
  `WorkspaceController` 加载后,若存在 appName 为 `vibe` 或 `vibe_<目录id>` **且**其 items
  全是 `tools:vibe-*` 的频道,静默移除并落盘(留一行日志)。理由:那两个 contentId 已经不在
  注册表里,不清理的话整个 workspace 校验会失败、服务起不来——这不是可选项。
- 控制台 VIBE 页保留:代理与指标列表、星标、API 密钥、状态条。**「频道布置」区换成「上屏」区**:
  说明 VIBE 现在是时钟上的独立 App(旋钮进「VIBE」),并给一个 `PUT /api/os/display`
  的「在时钟上打开」按钮(ZOS 已有 focus 语义)。非 ZOS 固件下该区显示「需要 ZOS 系统固件」。
- 屏幕预览保留:控制台仍要能看这两页长什么样。改为**前端画**(web 已有 52×16 canvas 与像素
  字体的全套设施,见 music mirror / game 的做法),而不是请求服务端渲染帧。

## 6. 非 ZOS 固件

官方固件与两个侧载固件(音乐/游戏)上 **VIBE 不存在**——它是 ZOS 的 App,和「轮播」「设置」
一样。控制台据 `firmwareMode` 如实说明,不做半吊子降级:把用量塞回频道正是本次要去掉的东西。

## 7. 实施分工

- **Agent F(固件)**:`ui/VibeScreen.{h,cpp}`、`ui/LauncherScreen.{h,cpp}`(新图标)、
  `logic/osLogic.cc`(根环第五项 + 路由 + 数据接线)、`net/StateDoc.{h,cpp}`(新键)、
  `visual/VibeIcons.h`(生成物)、`hostcheck/selfcheck.cpp`(断言)。验收:
  `mise run os-hostcheck`(或等价的 clang++ 自检)全绿。
- **Agent S(服务端)**:`src/os-link.ts`(`setVibe` + 序列化)、`src/service.ts`
  (`publishOsVibe` + 定时器)、`src/content-registry.ts`(删两个定义)、
  删 `src/vibe/vibe-render.ts`、`src/workspace-controller.ts`(启动期频道迁移)、
  `scripts/gen-vibe-icons.ts`(增出固件头)、相关测试。
- **Agent W(控制台)**:`web/src/lib/vibe.ts`(删频道构建)、删 placement/preview 组件、
  新「上屏」区、前端自绘预览、测试。
- 集成、真机验收、文档(reference 双语 + README 双语 + 本文状态 + 新 ADR):主会话。

## 8. 验收

1. `bun test` / `bun run typecheck` / `bun run build` 全绿;固件主机自检全绿。
2. `curl /api/os/pull` 的文档里能看到 `vibe*` 键,内容与 `/api/vibe/status` 一致。
3. 控制台改星标 → 文档 seq 前进 → 设备页面随之变。
4. 真机:根环出现「VIBE」,进去能翻页看到七个代理的真实数字,长按返回。
5. 旧的 `vibe` / `vibe_*` 频道在升级后自动消失,workspace 校验不报错。
