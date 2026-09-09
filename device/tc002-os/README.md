# TC002 OS — 替换官方固件的系统固件

面向 Ulanzi TC002（52×16 RGB LED）的完整系统固件：一页一项的旋钮式菜单、
自带 WiFi 配网、频道 / 音乐 / 游戏 / VIBE / 设置统一入口，以及可从 Pixel Studio 控制台
直接控制与实时镜像的设备画面。

与已有的两套侧载固件（`../tc002-lyrics-player` 音乐播放器、`../tc002-arcade` 游戏厅）
互斥共存，共用同一条 `/tmp` 加载路径与 `/tmp/tc002-sideload.id` 会话标识（ADR 0004）。

> **当前进度**：开机动画、Shell / 两级菜单、七款游戏、音乐页、VIBE 页、设置页、
> 控制台链路（长轮询 + 帧包 + 画面镜像）、音量 / 亮度、夜间息屏、配网页面均已就位。
> **尚未实现：热点（SoftAP）**；改变链路的那一半锁在守卫文件后面，见下方「WiFi 与配网」。

## 唯一的架构铁律

**Screen 只往 Surface 里画，永远不碰 SPI；全工程只有 `platform/Presenter` 写 LED 总线。**

时间以参数 `nowMs` 传入，Screen 必须是 `(state, nowMs)` 的纯函数——同样的一对输入
必须产出同样的像素。这条铁律不是洁癖，它换来三件事：

1. **UI 可在 Mac 上验证。** `ui/`、`core/Surface|Ease` 不含任何 FlyThings 头文件，
   `mise run os-hostcheck` 用 clang++ 直接编译并断言像素。LED 总线是只写的，
   `/dev/fb0` 与面板无关（见 `docs/research/tc002-device-probe.md`），
   真机上根本读不回一帧——不在 host 上断言，UI 回归就没有任何地方能被发现。
2. **镜像功能只有一个接入点。** 画面合成收口在一处，后续把帧 tee 给控制台是加一行。
3. **不重演 arcade 的两个缺陷。** 那边 4 个页面各自从 `PageBase` 调 `sendLedData`，
   一把静态锁横跨整帧写入（含强制的 15 ms 帧间隔），任何别的线程都要等满一帧。

## 目录

```
app/src/core/     Surface, Shell, RingModel, Transitions, Text, Ease  ← 全部 host 可编译
app/src/ui/       Screen 接口与各页面, LevelOverlay/LevelControl,
                  图标, ZOS 字标                                      ← 同上
app/src/net/      HostLink, StateDoc, FrameBundle, HttpClient/Server,
                  WpaCtrl, WifiPolicy, SetupPortal, PortalService     ← 纯逻辑部分同上
app/src/platform/ Presenter, Sfx, DeviceControls, NetInfo,
                  DeviceProvisioning                                  ← 唯一的设备侧
app/src/visual/   Glyphs.cpp                    ← 唯一允许 include 字模表的翻译单元
                  VibeIcons.h                   ← 生成物：厂商标记点阵
                  PixelFont.h                   ← 游戏 HUD 用的 ASCII 小字模
app/src/games/    七款游戏引擎                    ← 原样来自已退役的 arcade 固件，host 可编译
app/src/utils/    Surface.h                     ← 桥接头：引擎 include 的路径 → core/Surface.h
app/src/managers/ KeyManager, McuManager        ← 沿用 arcade 已验证实现
app/src/uart/     串口 / MCU 协议                ← 同上
app/src/activity/ FlyThings Activity 外壳        ← 精简版，无 ZK 控件
app/src/logic/    osLogic.cc                    ← 组合根与渲染循环，被 activity include
hostcheck/        selfcheck.cpp, games-selfcheck.cpp, link-audit.sh
sideload/os       侧载启动脚本
```

游戏引擎是从 arcade 固件**整体搬来**而不是移植的（[ADR 0014](../../docs/adr/0014-two-tiers-official-and-zos.md)）：
它们已在真机验证，物理常数照抄网页版，`hostcheck/games-selfcheck.cpp` 逐帧断言全部七款；
连 include 路径都没改，`utils/Surface.h` 是为此留的桥接头。改它们的任何一行都得先过这份自检。

## 输入

旋钮顺时针 / 逆时针，加旋钮键（`0x67`）与左 / 中 / 右三键（`0x6C` / `0x69` / `0x6A`）。
`KeyManager` 在自己的事件线程上回调，`osLogic.cc` 只入队，UI tick 再取出——
屏幕状态只在一个线程上变更。

| 输入 | 行为 |
|---|---|
| 旋钮左右 | 当前环内翻页；音乐页上一首 / 下一首；VIBE 页翻代理；游戏内直达引擎 |
| 旋钮键 / 中键短按 | 进入 / 确认；频道页暂停继续；音乐页播放暂停；VIBE 页切已用 / 剩余 |
| 任意键长按 600ms | 返回上一层（未被页面消费的 `kInputHold` 由 Shell 统一 pop） |
| 侧键短按 | 音量 ±1（0–6，与官方固件同刻度；mixer 上限实测为 50） |
| 侧键长按 | 亮度 ±1（10 档） |

游戏页是唯一要求「原始按键边沿」的页面（`wantsRawButtons()`）：引擎需要知道方向键被按住
了多久，所以侧键在游戏内不再是音量 / 亮度。长按在任何阶段都能退出游戏。

侧键、控制台注入的按键、控制台的音量 / 亮度滑块，三条路都收口在 `ui/LevelControl.cpp`，
`osLogic.cc` 里只剩一个把它接到两个单例上的适配器。原因很实际：`osLogic.cc` 是被 activity
`#include` 的，不是独立翻译单元，任何 host 自检都编不到它——这套规则曾经写在那里，
于是「只改音量」画出了亮度条，而自检里那份手抄副本照样全绿。`mise run os-hostcheck`
现在直接链接这个文件，并额外守一条：全树只有它能出现 `LevelOverlay::kVolume/kBrightness`。

## 菜单

主菜单固定五项：**音乐 / 游戏 / 轮播 / VIBE / 设置**，一页一项、满幅显示。频道在
「轮播」下一层，七款游戏在「游戏」下一层——频道是内容不是目的地，十个频道会把另外四项
挤出这个一次只显示一项的环。频道页**没有图标也没有名字**：画面是服务端排好的内容，名字
只在帧还没下载完时出现。各入口有各自的进场动画（CRT / 均衡器 / 卡带 / 抽屉），退出是同一
段动画倒放；「VIBE」复用均衡器——按下去的那张卡就是三根往上涨的竖条，进场是同一个动作
的延续。`Shell::kMaxEntryStyles` 是 8，现已用掉 7，第八个目的地必须先把这个常量调大，
溢出是静默降级不是报错。

「VIBE」的位置在「轮播」之后、「设置」之前：前三项的肌肉记忆不动，设置仍在末位。

音效是合成的（方波 / 三角波 / 噪声 + 频率扫描 + 衰减包络，直接写 `base::AudioPlayer`），
不带任何 .wav——采样要经 MediaPlayer 解码，会拖进约 1.1MB .text + 856KB .bss 的 ffmpeg。
Shell 的三声（tick / confirm / back）全局统一，七款游戏各有自己的开始 / 得分 / 结束音色。

## VIBE

各家 AI 编码代理还剩多少额度。**固件原生绘制，不是频道**：额度数字要「刚才变了就立刻看到」，
而频道是服务端排好、按 ttl 拉一次的一段 GIF；长轮询能在一个局域网往返内把变化推到面板，
只有自己画数字的页面用得上这条通道（见 `docs/design/vibe-firmware-app.md`）。

页面是一个环：第 0 页是总览（前两个代理并排），第 1..N 页每个代理一页。旋钮翻页并绕回，
按下在**已用 / 剩余**之间切换（记在 prefs 的 `vibe.showLeft`），长按照常返回上一层。
侧键不接管——音量和亮度是用户随时要用的，一页数字没有理由抢。

排版沿用 LED 频道版那套已在真机上读过的：总览每格 10px 厂商标记 + 数值列，详情页 **16×16 彩色
厂商标记**（x=0..15、y=0..15）+ 单字符指标标签 + 14px 进度条 + 右对齐数值；白 → 80% 琥珀 →
90% 红；数据是上一轮的好数据顶着（厂商这轮拒了）时右上角 (51,0) 点一颗琥珀像素。重置倒计时和
数值**分时共用同一格**——进度条占 x=21..34、三位数值占 x=37..51，行里没有第三个位置了；相位以
翻页为锚，所以走进一页永远先看到数字。

厂商标记来自 `visual/VibeIcons.h`，由 `scripts/gen-vibe-icons.ts` 从控制台用的同一份点阵生成，
`test/vibe-icons-parity.test.ts` 逐位比对两侧。两套并存：总览页仍用单色 `s10`（两个 16×16 标记
加数值放不进 52px，而且 16→10 不是整数倍，缩放会毁掉像素画），详情页用 `ColorMark` 的 16×16
彩色点阵，一格一 LED、不缩放。彩色标记**不染页面的严重度色**——那是采样自品牌的颜色，用红色盖
掉它就跟给照片上色一样。厂商没有 16×16 图时回落到单色 12px 标记（居中于同一列，按严重度点亮）。
数字用一张 `ui/VibeScreen.cpp` 私有的 3×5 字模：`visual/Glyphs.h` 只有 12px 一档，而 16px 的
面板放得下 12px 的**一行**，这个页面要两行。

线协议是四个新键（`vibe` / `vibea` / `vibes` / `vibem`），全部新增、不给旧键加字段——已部署固件
对 `item` 做 `n == 4` 的严格 arity 检查，多一列会让它整条丢弃。`kProtocol` 不动：加键不是破坏性
变更，这正是那个字段承诺的语义。

## 夜间息屏

设一个夜间时段，时段内长时间无人操作就息屏；在时钟上或在控制台上操作一下，倒计时归零。
默认**关闭**，窗口预填 23:00–07:00、等待 5 分钟——这套固件会刷进一台已经在用的机器，一次
更新之后面板开始自己变黑，是这个功能最不该产生的支持电话。

**用户看到的字是「息屏」不是「休眠」**：中文里 休眠 是 hibernate（机器断电），在一台唯一
恢复手段就是断电的设备上这正是劝退用户的联想；prefs 和线协议的键仍然是 `sleep.*`。

设置里两行，都是「按一下换下一档」，紧跟在 亮度 后面：

| 行 | 按下去依次是 |
|---|---|
| **夜间息屏** | `关闭` → `22-07` → `23-07` → `00-08` → `关闭` …（有自定义窗口时它排在 `00-08` 与 `关闭` 之间） |
| **息屏等待** | `1分钟` → `3分钟` → `5分钟` → `10分钟` → `30分钟` → `1分钟` … |

- **旋钮上没有 `全天`。**它是唯一没有「到点自己亮回来」的模式，而那是整套安全论证的支点；
  它曾经就排在 `00-08` 之后一档，两下就能把夜间息屏变成全天屏保。固件照常执行控制台设的
  `全天`，也照常把它显示成 `全天`——只是按不出来。
- **`关闭` 保留窗口**（配置里、遥测里都还在，控制台一次 `{enabled:true}` 就能恢复），但它
  是环上的一站而不是开关：从 `关闭` 再按一下是 `22-07`，不是回到原来的窗口。
- **控制台设的自定义窗口排在环的最后一站**，所以离开它的那一按落在 `关闭`——窗口没丢，还能
  恢复；**再按一下才会真正换掉它**，而且新值当场显示在行上（`revealValue`）。配置里只有一个
  窗口槽位，一行旋钮能给的最强保证就到这里。旋钮上不提供分钟级输入（每个端点 1440 个档位），
  控制台通过 `PUT /api/os/sleep` 可以给任意分钟。
- **`23-07` 而不是 `23:00-07:00`**：完整写法 66 px，行内可见宽度 50 px，会走马灯；而值要在
  1100 ms 的标签停留之后才出现，扫一眼就得花约 3 秒。只有端点不在整点时才显示分钟。
- **开着但时钟不可信时，这一行显示 `23-07 等待校时`**——**并排，不是替换**。替换过一版，结果
  是四个窗口在一台没校过时的机器上渲染成同一个字符串，行变成只写不读；而那正是一台刚刷完、
  还没连上 Wi-Fi 的机器的状态。并排会走马灯，这是异常状态下换来两个事实都在的代价。
- `start == end` 表示**全天**：零长度的窗口没有用处，而全天屏保是唯一不等到半夜就能试这个
  功能的办法。跨零点（23:00→07:00）是**常态**，不是边界情况。

四个值存在 `/data/zos-prefs.ini`（`sleep.enabled` / `sleep.startMin` / `sleep.endMin` /
`sleep.idleSec`），和音量、亮度、主题共用 `DeviceControls::flushIfDue` 的防抖提交——`/data` 是
raw NAND 上的 jffs2，一次擦除绝不能落在输入路径上。

**面板靠主动写黑帧变暗，不是停止渲染。** MCU 会保持最后一帧（README 上面那条「面板停在 MCU
自己的开机画面」就是证据），所以「不写」等于「画面定格」。黑帧按 1 Hz 重绘：`spi.write()` 会
失败，一帧丢掉的黑帧会让面板亮一整夜。20 ms 的 tick 不降频——它是唯一在决定唤醒的东西。

**每一种时间上的不确定都解析为一块亮着的面板**：从未校时、同步早于 26 小时、prefs 损坏、
单调时钟回绕、低电量关机倒计时挂起，全部 100% 亮着。这条不是洁癖：这台设备在 TimeSync 之前
实测停在 1970-01-01 00:00，而那个时刻**就在 23:00→07:00 里面**。理由与全部九条恢复路径见
[ADR 0009](../../docs/adr/0009-night-sleep.md)。

**息屏后的第一次输入唤醒面板，并且被吞掉。** 凌晨两点转旋钮是为了看时间，如果那一下同时翻了
频道，用户就得摸黑把它调回来。按下与抬起成对吞（游戏引擎读的是原始按键边沿，只吞下按下会让
它收到一次没有按下的抬起）；淡出期间**不吞**——屏幕还看得见，那时忽略用户就是面板在跟人抬杠。

**看不等于操作。** 只有按键事件、以及**序列上升**的控制台请求（`/api/os/input`、
`/api/os/settings`、`/api/os/display`、`/api/os/sleep`）会重置倒计时。`/api/os/pull`（设备每
≤8 秒的心跳）、`/api/os/mirror`（控制台开着标签页时每 250 ms）、`/api/os/state`、以及内容刷新
带来的每一次 `seq` 变化都**不算**——否则倒计时永远不会到期，而这个功能对最可能配置它的那个人
恰好完全失效。

**控制台的写入是逐字段的，序列变小当作服务重启。** 文档里缺一行的意思是「这一项别动」，所以
只改超时的一次 `PUT` 不会顺手把窗口和开关一起改掉（服务侧只发写过的字段，设备侧
`if (request.on >= 0)` 才有意义）。而 hub 的序列是 Bun 进程里的普通实例状态，服务一重启就回到
1——设备把**比已采纳值小**的序列当成新计数器而不是重放，否则凌晨两点那次 `{enabled:false}`
会安静地什么都不做。这两条对音量/亮度同样成立（`applyConsoleSettings`）。

**`asleep` 翻转时立刻补发一次遥测**，不等 10 秒周期：控制台是照着这个标志清空画布并写「已息屏」
的，停在 `true` 就意味着用户自己按醒的面板还被画成一块空白，而接下来那一下按键**不再被吞**，
会直接翻频道——正好是吞按键要防的那件事，只是搬到了控制台上。

**息屏期间游戏引擎不走**（`GameScreen::render` 才是 tick 引擎的地方，而那一支被换成了写黑帧），
音乐照放（`AudioPlayer` 不在渲染路径上）。醒来那一帧 `dt` 被夹在 250 ms，所以八小时空档不会
把球瞬移穿墙。**别把 `shell().render()` 提到 `repaintDue` 之外去「修」它。**

规则本身全部在 `app/src/ui/SleepPolicy.cpp`：`mise run os-hostcheck` 直接链接它，并额外守一条
——全树只有 `ui/SleepPolicy.{h,cpp}` 能出现 `insideSleepWindow`。和音量/亮度那条守卫同一个理由：
`osLogic.cc` 是被 activity `#include` 的，任何 host 自检都编不到它，而一条**能把面板抹黑**的
规则是最不该写在那里的。`osLogic.cc` 只读 `decideSleep()` 的四个字段，自己不做任何时间运算。
控制台一侧的完整契约（能力探测、`describeMirror` 的 `sleeping` 阶段、文案、预设）在
[`docs/design/zos-night-sleep-console.md`](../../docs/design/zos-night-sleep-console.md)。

## 控制台链路

设备主动拉：`GET /api/os/pull`（8 秒长轮询，行式 `KEY\tVALUE`）、
`GET /api/os/frames?app=`（`TCF1` 原始 RGB 帧包）、`POST /api/os/report`（10 秒遥测）、
`POST /api/os/mirror`（10fps 回传面板实拍帧，仅在控制台在看时）。两条线程：长轮询会挂住
连接最多 8 秒，一个线程做不了两件事，而 8 秒才更新一次的镜像不叫镜像。UI tick 从不阻塞在
任何一条上——它取一份 snapshot，帧包用 vector swap 交接。协议细节见 `docs/reference.md`。

**控制台跑了怎么办：局域网信标**（`net/ConsoleDiscovery.*`）。上面那个地址来自
`/data/zos-host`，**记一次，轮询一辈子**——而控制台是笔记本上的一个 Bun 进程，拿的是 DHCP
租约。租约从 `.108` 挪到 `.114` 那天，时钟就一直敲 `.108`：面板照常报时，遥测断了，控制台
看不见它，OTA 请求永远到不了，**两头都是静默的**，最后靠插线 `adb push` 才修好。

控制台现在每 10 秒往本网段的定向广播地址（端口 43821）喊一行
`ZOSCON1\t<host>\t<port>\n`（结尾换行是帧边界，少了就是截断，拒收）。设备第三个线程收它——
但这是**提示**不是命令，改写 `/data/zos-host` 是这套固件能被指使去做的最敏感的事，所以四道闸
一个都不能少：

1. **已经走丢**：`Snapshot::lastPullMonoMs` 距今 ≥ 60 秒。还在跟控制台说话的时钟**连解析都不
   解析**——`runListener` 里的判断在 `recvfrom` 之前，报文只是被排空丢掉。
2. **同一个 /24**：跟 wlan0 现在的地址比（`platform/NetInfo`）。
3. **跟正在用的地址不同**：两边都先过 `ble::consoleUrl` 归一，否则每收一个信标就白重启一次
   拉取循环。
4. **对面真是控制台**：写文件**之前**发**一次** `GET /health`，要求 200 且正文含
   `"service":"ulanzi-tc002-content-hub"`。在网上喊一嗓子的不算控制台。

采纳走的是 BLE 那条路已有的 `adoptConsoleHost`（临时文件 + fsync + rename + 重启拉取循环），
**不另写第二份**——那是一个断电时刻会决定这台设备还能不能被找回的写操作。记录进
`ProvisionLog`：`host-discover from=<旧> to=<新> outcome=adopt|not-a-console`，拒收也记；本机
禁 logcat，那个文件就是「设备为什么自己换了控制台」的全部证据。

判断逻辑全部在 `net/ConsoleDiscovery.cpp` 的**纯静态函数**里，`logic/osLogic.cc` 只负责喂三个
字段、取一次信箱——这个文件被 `activity/*.cpp` `#include`，任何 host check 都编不到它，写在
这里的闸就是没人断言的闸。四道闸连同一台真的 `net::HttpServer` 的第 4 闸，都在
`checkConsoleDiscovery()` 里跑。

**没有密钥也没有 HMAC，是想清楚的**：控制台的写接口只有同源检查，而同源检查挡浏览器不挡
`curl`，今天任何已经在这个局域网里的人都能给时钟推固件。局域网本来就已经是信任边界，这个
功能没有拓宽它。蓝牙那个六位验证码防的是**另一个**攻击者——人在蓝牙范围内、但不在这个 WiFi
上——那条规则一个字没动。控制台侧可用 `CONSOLE_DISCOVERY=off` 整体关闭。

## 构建与验证

```bash
mise run os-hostcheck    # clang++ 编译 UI 并断言像素，不需要设备
mise run os-build        # Docker 交叉编译 → libzkgui-os.so（ELF32 ARM，已 strip）
mise run os-linkaudit    # 链接审计，见下

# 出固件镜像还有中间一步，别跳：os-image 打的是 release/bundle/，不是编译产物
rm -rf .runtime/os-stage && cp -R device/tc002-os/release/bundle .runtime/os-stage
cp device/flythings-build/libzkgui-os.so .runtime/os-stage/libzkgui.so
bun run scripts/create-os-release.ts -- "$PWD/.runtime/os-stage" <版本> os
mise run os-image        # 打包成可刷的 update.img
```

**为什么要专门写这一句**：跳掉中间那步，`os-build` → `os-image` 会照常打印每一行成功信息，
产出的却是**上一个 build** 的容器。它能装、装完重启、回来跑的还是原来那个固件——`build id`
纹丝不动，看着就像「升级链装不上」。为此翻过厂商升级器的反汇编，而镜像里根本没有新东西。
现在 `pack-image.ts` 会逐字节比对 bundle 里的 `libzkgui.so` 与编译产物，不一致直接拒绝打包。

`os-linkaudit` 拦的是唯一一种「推上去才发现」的故障：加载器对缺符号只会报一句
`initLib error: undefined symbol`，面板全黑，不告诉你缺哪个库哪个符号。它做四件事：

- **NEEDED 必须是可满足集合的子集。** 基准取 `libzkgui-arcade.so`——那个固件在真机上
  跑通过，它的 NEEDED 集合是经验上成立的。设备内存映射（`device-dump/maps-baseline.txt`）
  只用来扩大集合，不单独作为判据：它反映的是官方 app **加载过**什么，而不是设备上
  **有**什么（`libzkmedia` 就是存在但未被官方 app 加载的例子）。
- **零个未定义的 `av_*` / `sws_*` / `swr_*` 符号。** 链了 audio-utility 却没有 ffmpeg
  会留下约 38 个未定义符号，而设备根本不带 `libav*`。
- **零个 FlyThings 网络管理器符号。** 这是**安全闸门**不是洁癖：`NetManager` /
  `WifiManager` / `SoftApManager` 掌管无线的电源路径，会对着这台机器上并不存在的模块目录
  调 rmmod/insmod，走进那个分支 `wlan0` 就没了，而 adb 正骑在这条链路上——只能物理断电
  恢复。管理器类是 C++ 的，一旦有人 `#include <net/NetManager.h>`，改写后的符号名就会留在
  未定义符号里，构建在这里失败而不是在台架上失败。详见
  [ADR 0006](../../docs/adr/0006-no-flythings-network-managers.md)。
- **体积上限 1,400,000 字节。** 包会被推进 tmpfs（即内存），36 MB 的机器上未 strip 的 .so
  曾经把设备直接 OOM 重启。最初的 600 KB 是设计目标而非硬件上限：arcade 在真机上是
  1,766,760 字节、音乐固件 1,840,452 字节，而声音本身要 ~438 KB。这个上限仍拦得住真正
  要命的那次失手——把整条 ffmpeg 解码路径链进来，实测约 1.9 MB。
  这个数字**故意不是整 MiB**：原先取 1.2 MiB（1,258,291）时二进制正好 1,255,160，看着还剩
  3 KB，其实一点都不剩——链接器给只读段补页，**文件大小只按 4,096 字节一跳**，下一档
  1,259,256 就已经超了 965 字节。任何一个功能都会被这条线拦下，词级歌词时间轴就是这么撞上去的。

工具链在 `device/flythings-build/`，几个 app 共用同一个构建目录，因此 `BUILD_DIR` 按 app 隔离——否则切换 `APP` 而不
`make clean` 会把上一个 app 的 .o 静默链进来：能编、能加载、跑的是另一个固件。

## 侧载与恢复

侧载全程只写 tmpfs，闪存一次都不碰。**断电即恢复官方固件**：`/tmp` 被清空，
框架回落到 `/res/etc/EasyUI.cfg`，官方 app 连同它自带的 WiFi 配置网页一起回来。
这是这套固件出任何问题时的通用救砖手段，也正是固化（写 `/res`）会删掉的那张安全网
（[ADR 0006](../../docs/adr/0006-no-flythings-network-managers.md)）。

服务端走与另外两套固件同一个参数化安装器（`/api/os/device-app/*`，确认口令
`START_TC002_OS_SESSION`，ADR 0004）；控制台目前还没有 ZOS 的侧载面板，这四条路由要自己调。

比另外两套多一步：**包里要放一个 `host` 文件写上控制台地址**。局域网里没有任何东西会广播
这个服务——它是某台笔记本上的一个 Bun 进程，不是有名字的路由器服务，所以只能告诉它。
启动脚本把它移到 `/tmp/zos-host`，固件启动时读（也接受 push 后原地的 `/tmp/tc002-os/host`），
三种写法都认：`http://192.168.8.185:43820`、`192.168.8.185:43820`、`192.168.8.185`
（后两种分别补 `http://` 和 `:43820`）。文件缺失不是错误：固件照常独立运行，只是没有频道
也没有镜像——启动脚本对它的搬移带条件判断，否则 `set -e` 会把「没配控制台」变成一次失败
的启动和一块黑屏。

## WiFi 与配网

替换官方 app 就等于删掉它的 `/settings/*` 网页，包括自带的 WiFi 配置页，所以这套固件必须
自带一条配网路径。目前：

- **已经能用**：固件自带 HTTP 服务，在**设备正常地址的 8080 端口**提供配网页——`GET /`
  页面（完全自包含，无 CDN / 无 web 字体 / 无外部样式表）、`GET /scan`（wpa_supplicant 控制
  套接字的 `SCAN_RESULTS`，即上一次扫描的缓存，读它不会触发新扫描；按信号排序去重）、
  `GET /status`、`POST /connect`。设置页里能看到这个地址。选 8080 不选 80，是因为绑特权
  端口要求那一刻还是 root。服务跑在自己的线程上，`serveOnce` 阻塞对 25fps 的 UI tick 不能接受。
- **已经能用**：蓝牙配网（`net/BleProvisionSession`）。控制台的网页蓝牙页面直接跟设备说话，
  station 射频全程不动，所以时钟能一边应答一边扫描和关联——这是一台完全没上过网的设备唯一
  能走通的路。**面板上的六位验证码按能力收费，不按流程收费**：`scan` 不要（它只列出本来就在
  空中广播的名字），只带 `ssid`/`psk` 的 `join` 也不要（这正是原厂固件的权限，而原厂连验证码、
  PIN、二维码都没有，`BT_SECURITY_LOW` 不配对，靠的就是「人在旁边」）。**只有一种情况要**：
  `join` 带的 `host` 与设备**已经采纳的控制台不同**——原厂的 join 顶多换个 WiFi，我们的还会
  改写 `/data/zos-host`，也就是时钟余生要轮询的地址。收陌生人的 WiFi 是麻烦，收陌生人的控制台
  地址是交出设备，所以只在这一处要求证明在场。比较对象是 `HostLink::baseUrl`（正在轮询的那个
  地址，每轮喂给会话），不是开机时的副本；被拒时回 `err=host-code` 且什么都不改，控制台验证完
  把同一条 join 原样再发。凭据校验（`ssidIsSafe` / `pskIsSafe`）与守卫文件都不受这条规则影响。
- **故意还没通**：真正改变链路的那一半锁在守卫文件 `/tmp/zos-allow-link` 后面。执行器
  （`platform/DeviceWifi.h`）沿这条线一刀切开——只读的一半永远可用，会改变的一半（拉起
  supplicant、关联、请求 DHCP、起停热点、发起扫描）现查守卫文件，不存在就拒绝；配网页的
  提交同样，并在**拒绝的当下**回报 `link-locked`，而不是先假装成功。安装器不创建这个文件，
  所以正常安装下这段代码编进去了、UI 能走到、物理上不做事。
  `adb shell touch /tmp/zos-allow-link` 武装一次实验，断电自动解除。
- **还没实现**：热点（SoftAP）。`startSoftAp()` / `stopSoftAp()` 目前只写一行日志就返回；
  配方是知道的（停 wpa_supplicant、写 hostapd.conf、起 hostapd、发地址），但每一步都动 adb
  所骑的那条链路，而 `SoftApManager` 正是 ADR 0006 禁止链接的东西。因此**一台没有存储凭据
  的设备现在还不能由 ZOS 自己配网**；`docs/design/tc002-os-provisioning.md` 那套四屏热点
  流程仍是设计。

`wpa_supplicant` 在 `/etc/init.rc` 里是 `disabled` + `oneshot`：开机没人拉它，它死了 init
也不重启。官方 app 通过 `libzknet` 干这件事，我们顶替了它，这份责任就是我们的——
`WifiPolicy` 负责 `ctl.start`、轮询 `init.svc.wpa_supplicant`、进程消失就重启，并把重启次数
报给设置页。关联本身不带地址，因此每次连上都要显式请求一次 DHCP 租约，且必须异步发出：
`NetUtils::dhcpRequestIp` 会阻塞数秒，内联调用会把整块面板冻住一次租约协商那么久。

## 侧载会掩盖的一整类 bug

ZOS 侧载时，官方应用**已经跑过**，硬件是它初始化好的。ZOS 白捡了这些状态却不自知，
于是「忘记初始化某个硬件」这类错误在侧载下**结构上不可能被发现**——只有当 ZOS 成为
这台机器上唯一跑过的应用（即固化）时才会现形。

已经栽过两次，都是同一个根因：

| 缺失 | 现象 |
|---|---|
| `McuManager::initialize(new McuParse("/dev/ttyS1", 1500000))` | 无 |
| 紧随其后的**阻塞式** `queryMcuVersion()` | 面板停在 MCU 自己的开机画面 |

第二条是真凶，而它极难看出来：**SPI 写返回成功、GPIO_35 正常翻转、渲染循环 25 fps
在跑、音频输入网络全部正常**——只有面板不动。因为打开串口不等于握过手：MCU 要先
确认主机在，才肯把面板交给 SPI 帧。街机固件的注释里写着「No blocking MCU query
here」，那正是它侧载时能白捡、固化时会失效的原因。

**参照物要选对。** `apps/flythings/pixel-pet-display` 是官方仓库里唯一一个为**独立
部署**写的第三方 app，它的 `onUI_init` 是已知可用的最小启动集。官方 demo 和我们自己
的街机/歌词固件都默认脚下有人，不能当权威。

判断新代码有没有这个毛病，问一句就够了：**「这个东西，是我初始化的，还是我捡来的？」**

## 固化到 flash

侧载是临时的：断电即回官方固件。固化把 ZOS 写进 `mtd3 res`，重启后仍在。

### 打包

```bash
mise run os-image            # → .runtime/tc002-os/update.img
mise run os-restore-image    # → .runtime/tc002-stock/restore-live.img（还原点）
```

容器格式是 `ZKSWEV1.0` 头 + squashfs 载荷，**没有签名**——只有一个覆盖 `file[0:568]`
的 CRC-32 和一个内嵌 MD5，两者都由打包器重算。`os-image` 每次先把库存
`update.img` 逐字节重建一遍，不一致就拒绝出包；572 字节头部无一字节抄自原文件
（含那 509 字节填充，实为 MSVC `rand()`、种子 `0x14e4a39e`）。没有这道关卡，
刷进去的就是一个猜测。

### 上传：不打包也能装

镜像不一定得是这台机器打出来的。控制台 **常规设置 → 04 固件 → 选择镜像文件** 会把一份
`.img` 交给服务（`POST /api/os/firmware`，multipart，同源）。服务在**落盘之前**逐项校验，
用的就是打包器那份实现（`release/zkswe-image.ts`，两边同一个模块，不会各自漂）：

| 拒绝 | 是什么 |
| --- | --- |
| `magic` | 开头不是 `ZKSWEV1.0`——一张图片、一个 zip、一个没套容器的 squashfs |
| `too-short` | 装不下一个容器头，多半是下载被截断 |
| `too-long` | 超过 `res` 分区的 8 MiB（正文上限再加 768 字节容器头） |
| `malformed` | 头部算术对不上、ei 块截断、平台号不符、头部 CRC-32 不符 |
| `digest` | 每项内嵌的 MD5 与载荷对不上——文件在路上坏了 |
| `partition` | **刷写目标不是 type 3 `res`** |

最后一条是这里唯一一条不是在挑「文件坏没坏」的：设备的更新器是照分区类型走位掩码的，
一个各方面都合法、只是瞄准了 `boot` 或 `system` 的容器会**装得干干净净**，然后这台钟就
不再启动了。前面几条挡的是失败的安装（设备自己也会校验 CRC 和 MD5，擦之前就停），这一条
挡的是砖。任何一条不过都**什么都不写盘**，上一份选中的镜像原样还在。

存哪儿，为什么：

```
.runtime/tc002-os/update.img            ← 只有 mise run os-image 写
.runtime/tc002-os/uploaded/update.img   ← 只有 POST /api/os/firmware 写
.runtime/tc002-os/uploaded/upload.json  ← 这份是谁、什么时候传的
```

两个写方，两条路，谁也够不着谁。上传要是落进打包路径，下一次 `os-image` 就会把主人选的
镜像悄悄换成刚编出来的那一版——本仓库已经为它的孪生兄弟（陈旧 bundle 打出上一版、装得
完美、什么都没变）赔过一个晚上了。有上传时以上传为准，同时把本地打包的那一份**明写成
「没有被选中」**，而不是让它悄悄躺着；「移除上传」把选择权还回去，所以这不是一扇单向门。

控制台会把到手的镜像照实摆出来：大小、**整包 MD5**（对自己的文件跑一次 `md5` 就能比）、
写入分区、来源（上传的文件名与时间／本地打包）。版本号那一行通常是**未知**——`ZOS_BUILD_ID`
编在 libzkgui.so 里，隔着一层 xz squashfs，`strings` 扫整个 `update.img` 一无所获（实测）。
读不出来就写「未知」，绝不拿大小、mtime 或摘要凑一个像版本号的东西出来。真正能核对的那条
线索是 squashfs 的 mkfs 时间（打包器把它钉在所打 `.so` 的 mtime 上），所以它作为「系统构建于」
单独列一行。

**上传不是安装。** 这条路一个升级序列都不碰：上传成功和「这就是我要的那一版」是两个说法，
而后者的结局是擦掉 `mtd3`——没有 A/B，没有恢复分区。所以第二步永远要人自己按。

### 安装

**从控制台**（装好 ZOS 之后的常规路径）：常规设置 → **04 固件** → 勾「我知道更新期间会发生
什么」→「安装到时钟」。服务把当前选中的镜像通过 `GET /api/os/firmware` 发给设备，设备下到
`/tmp/zkimg/update.img`（tmpfs；为什么不再是 `/mnt/storage/zkimg/`，见下文「暂存位置已经
从……换到 `/tmp/zkimg/`」那段）后自己发起安装、写 `mtd3`、重启。

下载归 `HostLink` 的 worker 线程（`net/FirmwareUpdate.{h,cpp}`），**不占 UI tick**：
1 MB 的传输放在 20ms 的 tick 里，恰好会在用户最盯着面板的那几秒把它冻住。代价是诚实的
——下载期间镜像与遥测停一下，设备紧接着就重启进新固件了。

控制台这条路落在 tmpfs 上，本来就可写，**不碰 `/mnt/storage`**；只有暂存目录在
`/mnt/storage` 底下时（手推的那条路，以及开机清理扫到它），**固件才自己 remount 成 rw、
写完再 remount 回 ro**，同样不需要人先去开权限。落盘先写 `update.img.part`，**收满服务端
声明的最后一个字节才 rename** 成 `update.img` 并 `sync`：断线只会留下一个被删掉的 `.part`，绝不会在升级器要读的位置留下
一个截断的镜像。四道闸门都在写 flash 之前：非 200 拒、无 `Content-Length` 拒（没有长度
就没法判断收全了没有）、比容器头（572 字节）短或比分区（8 MiB）大拒、开头不是
`ZKSWEV1.0` 拒——最后这条挡的是「服务端 200 返回一页 HTML」。**任何一条不过就不叫升级器。**

面板上看得见：下载中是 `更新NN%`，底行进度条随字节走、未填满的部分有一颗像素在扫（
停住的传输和死机要能分辨）；镜像收全是 `安装中`，present 一帧之后才交给厂商升级链；
失败是 `更新失败`，停 8 秒后面板变回时钟。失败**不会自动重试**——重试就是在控制台再按
一次（序号变了才会重新下载）。`/data/zos-provision.log` 里每个阶段一行 `UPGRADE`，
因为成功会重启进另一套固件、失败时多半没人在看，这个文件是唯一的记录。

**从命令行**（首次安装，或控制台不可用时）：

```bash
adb shell mount -o remount,rw /mnt/storage
adb shell mkdir -p /mnt/storage/zkimg
adb push .runtime/tc002-os/update.img /mnt/storage/zkimg/update.img
adb shell sync
# 然后请求安装：控制台按钮，或 curl -X POST 服务的 /api/os/upgrade
# （手推的这条路绕开了上面那套校验——分区类型是自己看的，`adb push` 不会替你看）
```

`/mnt/storage/zkimg/` 仍是 `upgradeEntryPoint()` 的**第二个候选目录**（第一个是控制台用的
`/tmp/zkimg/`），所以这条手推路径照样能装；两个目录按顺序各试一次，谁先交出一个合法镜像就装谁。

手推的镜像装完**务必删掉**（`rm /mnt/storage/zkimg/update.img`）：厂商的升级链不会删它，
留着的话下一次请求会把同一个镜像再装一遍。开机清理确实会把两个目录都扫一遍，但它只在这台
设备**走控制台装过至少一次**之后才动手（否则手工暂存的镜像会在被请求之前就被清掉），所以别
拿它当手推的兜底。走控制台则不必操心：镜像在 tmpfs 上，装完那一次重启就没了。

#### 谁来发起：是**应用**，不是框架

这一条是这套固件最容易丢、丢了最贵的知识（见
[ADR 0012](../../docs/adr/0012-the-app-must-knock-for-upgrades.md)）：

- 写 `mtd3` 的 `zk_upgrade_perform()` 只被 `UpgradeMonitor::threadLoop()` 调用，
  而后者只被 `UpgradeMonitor::startUpgrade()` 启动。
- **`libeasyui.so` 和 `/bin/zkgui` 里没有任何地方主动调用它们。** 框架装着整台机器，
  但从不拧钥匙。
- 原厂 Ulanzi app 自己拧：全设备只有它的 `libzkgui.so` 引用了
  `UpgradeMonitor::getInstance` 和 `::checkUpgradeFile`。

所以那套「push + 四个 setprop + 重启 zkswe」在原厂固件上能刷，而在**已经装好 ZOS 的
机器上什么都不会发生**——门还在，没人敲。ZOS 里对应的一行是
`tcos::upgradeEntryPoint()`（`logic/osLogic.cc`），**删掉它等于让这台设备再也升级不了**。

它**不能放在启动路径上**：放过一次，面板直接卡死——镜像装完不会被自动删除，于是每次开机
都重新进入升级链，app 永远走不到第一个 Screen。触发因此是显式的：拉取文档里的
`upgrade\t<seq>` 键，同一个序号一次开机只认一次。

「一次开机只认一次」不够，因为**装完的结局就是重启**：重启后内存里的计数器归零，而控制台
还在发同一个请求，于是被判成新请求、再装一遍，无限循环。所以设备把装过的请求号写在
`/data/zos-upgrade.seq`（mtd6，刷 mtd3 碰不到），判据是「比装过的**更新**」而不是「不等于」;
请求号由服务端发**纪元秒**而不是自增计数——Bun 进程一重启计数器就回到 1，会和设备已经记下的
号撞车，那台设备就再也叫不动了。配套的另一半是开机时 `FirmwareUpdate::discardStaged()` 清掉
暂存镜像：厂商链不删它，而一个还在原位的镜像就是下一次开机重装的全部理由。

**暂存位置已经从 `/mnt/storage/zkimg/` 换到 `/tmp/zkimg/`**，因为本机那块 UDISK（mtd7，
8.5 MB vfat）在 1 MB 镜像落盘的位置长了坏区。实测证据：暂存好的 `update.img` 两次都在同一个
6% 偏移读失败（`adb pull` 报 `Input/output error`），而同一分区上更老的 2.7 MB
`stock-update.img.bak` 完整读出；读错误立刻触发挂载参数里的 `errors=remount-ro`，于是**之后**
那次下载的 `rename` 和兜底 `unlink` 双双失败（verdict=8 `kWriteFailed`），而厂商升级链拿到一个
读不回来的镜像，面板就永远停在「安装中」。

换成 tmpfs 之后，原来反对它的理由变成了支持它的理由：镜像只有 1 MB，`/tmp` 有 16.5 MB、
可用内存 17 MB，而且它只在「下载完」到「几秒后安装」之间存在——**重启清空 tmpfs，正好就是
「装完必须删镜像」那一条**，不用再靠代码保证。`/mnt/storage/zkimg/` 保留为 `upgradeEntryPoint()`
的第二个候选目录，手工 push 的镜像照样能装；开机清理会把两个目录都扫一遍。

两条曾被当成解释、实测为假的说法，记在这里免得重查：升级**不经** `UpgradeActivity`
（它的布局 `zkupgrade.ftu` 在本机任何 `/res` 里都不存在，原厂也没有）；type-3 `res`
**不走** u-boot 交接（反汇编显示是直接写 MTD 字符设备，`zk_upgrade_ready()` 也不设置
`perform()` 会读的任何状态）。另一条路（`zkdaemon` → `/bin/zkupgradebin`）确实是死的，
那个二进制在本机不存在。

### 为什么刷 `res` 拿不走 adb

这是动手前唯一需要相信的事，它有两条独立证据：

1. **分区隔离**。`/bin/zkgui`、`/lib/libeasyui.so`、`/lib/libzknet.so`、
   `/bin/wpa_supplicant`、`/bin/adbd` 全部位于 `/`（`mtd2 rootfs`，squashfs 只读）；
   WiFi 凭据在 `/data`（`mtd6`）。刷 `mtd3` 一个都碰不到。
2. **启动顺序**。`/bin/zkgui` 的 `main` 里，`NetManager::start()` 在
   `EasyUIContext::initEasyUI()` **之前**（0x10f94 对 0x10f9c，连续指令、中间无分支），
   而应用的 `.so` 是 `initEasyUI` 才加载的。所以即使 `/res` 完全损坏，网络照样起来。

因此一次失败的刷写最坏是「面板不亮但 adb 还在」，可以再刷一次。

### 触发前后能观测什么

这台机器不能开 logcat（会卡死 adbd），所以观测点只有这三个，都在 `libzkupgrade.so`
的字符串里，用真机 pull 下来的库核对过（注意别用 `adb shell cat` 导二进制，会损坏）：

| 观测点 | 含义 |
|---|---|
| `getprop sys.zkupgrade.state` | 升级状态；本机当前为空 |
| `/data/.zkupgraderec` | 升级记录，持久分区；本机当前**不存在** |
| `/tmp/EasyUI.cfg` 被清空 | 升级路径会执行 `echo {} > /tmp/EasyUI.cfg`，即**触发升级会拆掉正在跑的侧载会话** |

前两项为空/不存在，说明**本机从未执行过升级流程**——所以整条链是否点火尚未在硬件上
证实，只证实了它存在。

镜像搜索路径不止 `/tmp`：库里还有 `/mnt/storage/zkimg/update.img`、`/mnt/extsd`、
`/mnt/usb1`、`/mnt/mmc`，以及 `sys.zkupgrade.force` / `.umount` / `zkrebootdelay`。

### 尺寸不合会在擦除之前退出

这是「先拿还原镜像试链路」之所以安全的依据，取自真机 `libzkupgrade.so` 的反汇编：

```
5b64: ldr r4,[r5,#8]          ; 镜像声明的尺寸
5b6c: bl  Mtd::getSize()      ; 分区尺寸
5b70: cmp r4, r0
5b74: bls 5b9c                ; 装得下 → 继续
5b94: bl  __android_log_print ; 装不下 → 打日志
5b98: b   5e00                ; 退出
5b9c: ...
5ba8: bl  Mtd::erase(0, r4)   ; 擦除只在「装得下」这条路上
```

### 恢复

**没有 recovery 分区**（`/proc/mtd` 里 BOOT0/KERNEL/rootfs/res/config/MISC/data/UDISK，
无 A/B 对），**也没有 TF 卡通道**（`mmc0` 上挂的是 aic8800 WiFi 的 SDIO 功能
`mmc0:a9b3:1/2`，不是卡槽），USB 也不行（官方文档：带 Wi-Fi 的机型 USB 连接无效）。

Ulanzi 不提供可下载的 TC002 固件包，所以唯一的还原源是从本机取下的副本。设备
UDISK 上那份 `update.img` 比机器实际运行的版本**旧**，拿它「恢复」是静默降级；
`mise run os-restore-image` 从**现役** `/res` 打包，才是真正的还原点。

**在控制台里还原。** 有还原点时，设置 → 固件 里会多出「还原官方固件」一行：点一下把
它放进待装位，页面上那份镜像的身份随之变成 `restore-live.img`，同意栏的文案也换成
「我知道这会把 ZOS 从时钟上抹掉」，最后那颗按钮变成「还原官方固件」。走的是和上传
镜像完全同一条路——**装填与安装仍是两件事**，而且装填之后「移除上传」照样能把 ZOS
换回来，所以放进待装位不是单向门。服务端读的是组合根里写死的路径
（`.runtime/tc002-stock/restore-live.img`），请求里的任何东西都挪不动它。

> **这份还原点是不可再生的，而且不在版本库里。** 它必须在刷入 ZOS **之前**从设备
> 现役 `/res` 取下；现在闪存里跑的是 ZOS，此刻再跑 `mise run os-restore-image`
> 只会把 ZOS 打包一遍，得到一个名字叫「还原」的假还原点。它躺在 `.runtime/` 下，
> 而 `.runtime/` 是 gitignore 的——清掉它，这台设备就再也回不到官方固件了。
> 想留一份保险，就把 `restore-live.img` 复制到仓库之外的地方。

> **切勿按住任何按键超过 5 秒。** `/bin/zkdaemon` 的按键线程在 5000 ms 后执行
> `rm -rf /data/*`，会连同 WiFi 凭据一起删除，把设备推进「无网 + 无 adb」——
> 那不是恢复键。
