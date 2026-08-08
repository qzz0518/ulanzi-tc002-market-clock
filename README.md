# Ulanzi TC002 Pixel Studio

[English](README.en.md) | 简体中文

一个使用 Bun 运行的 TC002 多频道内容工作室。它不再把时钟限制成固定的行情轮播：市场、通知、计时器、视觉动画和画板都通过同一套内容注册表生成 52×16 像素帧，再由统一调度器组合、编码和推送。

![Ulanzi TC002 多频道内容工作室控制台](docs/images/tc002-control-panel.png)

## 两层内容模型

- **频道 = 时钟上的一个 Custom App**。不同频道使用不同 `appName`，因此可以直接用 TC002 旋钮切换。
- **内容项 = 频道内部的一段内容**。一个频道只有一项时是独立内容；有多项时会合成一个按顺序播放的 GIF 轮播。

例如，可以建立三个旋钮项目：

1. `markets`：BTC → 黄金 → AAPL 的组合轮播。
2. `timer`：独立计时柱。
3. `fire`：独立火焰动画。

内容渲染器只产生帧，不允许直接写设备或创建自己的后台循环。统一控制器负责行情缓存、帧数上限、GIF 编码、串行设备写入、失败隔离和刷新调度。详细决策见 [ADR 0001](docs/adr/0001-extensible-content-channels.md)。

## 已内置内容

| 分类 | 内容 |
| --- | --- |
| 市场 | BTC、ETH、BNB、SOL、黄金、USD/CNY、AAPL、MSFT、NVDA、GOOGL |
| 工具 | 通知板、计时柱 |
| 视觉 | 兰顿蚂蚁、鱼缸、火焰、翻页钟、数字雨时钟、走迷宫、像素宠物、落沙、星空穿梭 |
| 创作 | 52×16 画板；通过独立素材库按需导入 Ulanzi 官方社区像素素材（PNG / GIF） |

四个美股使用 Yahoo Finance 的公开 Chart 接口，显示常规市场最新价和前收盘涨跌。股票图标保留了 PixDeck 原始 16×16 PNG 的完整字节和像素布局；来源、固定提交与哈希见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

画板支持画笔、橡皮、自定义颜色、网格、撤销/重做、ASCII 像素文字、图片等比像素化和 PNG 导出。画布会作为普通内容项保存，因此既能加入轮播，也能创建成独立旋钮项目。

顶部“素材库”是与“内容”“画板”并列的独立宽版页面，可以浏览、搜索、分类，或粘贴 `ugc.ulanzistudio.com/contentView/...` 链接导入官方社区的公开像素素材。左侧频道列表用于选择“加入频道”的目标，也可以把任意作品直接设为独立 App。

官方作品列表没有写死：每次进入素材库、刷新页面、切换分类/分页或搜索时都会重新请求官方接口，因此上游新增、下架或调整的作品会在下一次请求时同步。已经导入的素材则是本地稳定快照，不会被上游改动静默替换。素材会最近邻还原到 52×16，GIF 会保留帧与时长，并保存到本机 `.runtime/pixel-assets`；之后的预览和推送不依赖官方站点在线。导入接口只会加入频道或创建独立 App，不会绕过既有频道链路直接写设备；后续交付仍遵循项目原有的频道调度与手动推送策略。社区作品没有随本项目打包，界面会保留作者与官方来源。

## 控制台

服务启动后打开：

```text
http://127.0.0.1:43820/
```

控制台包含：

- 左侧频道列表，对应时钟旋钮上的 Custom App。
- 中间频道编辑器，可排序内容、设置每项时长、预览和单独推送。
- 右侧按“市场 / 工具 / 视觉 / 创作”分类的内容市场。
- 顶部“内容 / 画板 / 素材库 / 音乐”四个一级视图；素材库与音乐使用独立宽版布局。
- 右上角“常规设置”弹窗直接读取和写入设备的亮度、音量、翻页、滚动、时区、日期、星期与低电量休眠设置；标题栏手机图标会按需展开访问二维码、当前地址和复制按钮，不再占用设置首屏。

手机竖屏将“频道编排”和“添加内容”拆成两个同级工作区：内容市场不再堆在页面最底部，加入内容后会自动回到刚添加的播放项。频道设置与设备大图默认折叠，播放顺序和推送入口优先进入首屏；底部导航、横向频道选择和单列表单都针对触控重新排布。画板会提示切换横屏，避免 52×16 画布与工具栏被压缩到无法准确落点。桌面三栏布局不受手机断点影响。

<p align="center">
  <img src="docs/images/tc002-mobile-content.png" width="390" alt="Ulanzi TC002 Pixel Studio 手机端频道编排界面">
</p>

页面已提供 Web App Manifest、主屏幕图标、独立窗口元数据和离线静态壳。手机浏览器支持时，可从菜单“添加到主屏幕”获得接近原生 App 的操作方式。浏览器的完整 PWA 安装与 Service Worker 离线缓存要求可信 HTTPS；直接使用局域网 HTTP 时，仍可使用响应式控制台和浏览器提供的主屏幕快捷方式。

前端使用 React、Cladd UI 和 Tailwind CSS v4。Cladd 负责按钮、表单、Tabs、Select、删除确认、Tooltip、Toast 与可拖拽数值输入的统一交互；页面仍保留本项目原有的黑白绿 Pixel Market 视觉语言，并对动效启用 `prefers-reduced-motion` 降级。

设置保存在 `.runtime/workspace.json`。旧版 `.runtime/settings.json` 会在首次启动时原子迁移为一个市场频道，保留已选资产和轮播时间；原文件不会被覆盖。

禁用、删除频道或修改 `appName` 时，服务会向旧 Custom App 名发送空对象进行清理。设备离线时清理失败只记录为降级状态，不回滚已经保存的新工作区。

## 音乐歌词播放器

顶部“音乐”是一个完整的音乐工作台：网易云音乐扫码登录、搜索（20 首/页翻页）、
登录后的歌单、逐行歌词（含翻译）、同源音频代理和 52×16 像素歌词预览。登录
Cookie 只保存在本机 `.runtime/music-session.json`（权限 `0600`），浏览器和
TC002 都不会拿到原始凭据；登出会删除该文件。歌曲是否能播放仍受账号、会员、
版权和地区限制，界面不会把 45 秒试听片段显示成完整歌曲。

预览与设备共用同一套主题系统：四种显示形式（走带 / 天际 / 聚光 / 升降）×
四套配色（信号绿 / 磁带橙 / 蓝晒 / 街机红），另可用取色器覆盖自定义主色。

设备侧有两条互补的上屏路径：

- **设备同屏（官方固件，不刷机）**：把渲染好的 52×16 歌词帧（最多 60 帧、约
  15fps）通过官方固件的 Custom App 通道推到时钟显示；声音由浏览器播放。
- **原生音乐固件（非持久化旁载）**：仓库内含完整的 FlyThings C++ 播放器
  （Docker 交叉编译，无需 Windows IDE），在真机上下载音频、扬声器播放、
  毫秒级进度跳转，并用离线光栅化的 12×12 中日文字模直接驱动 LED。网页与
  固件通过控制序列 + 心跳协议**双向实时同步**：网页选歌/暂停/换主题/拖进度
  2 秒内落到设备；设备按键（播放/切句/切主题）即时回流网页，预览动画锚定真机
  播放头。此模式下网页静音，仅作遥控器。固件在线时界面自动切换，无需手动选择。

旁载始终是非持久化的：TC002 平时运行官方固件，会话只把播放器推到设备内存盘
临时运行；结束会话或断电重启即自动恢复，flash 从不被写入。启动会话前仍需三重
确认：旁载包与发布清单逐文件 SHA-256 一致、官方 HTTP 接口与 Wi-Fi ADB 双重
确认真机、用户勾选已知恢复方式。固件源码、协议、构建与部署详见
[device/tc002-lyrics-player](device/tc002-lyrics-player/README.md)，架构边界见
[ADR 0002](docs/adr/0002-native-music-player-boundary.md)。

这项功能不能只靠 MQTT 完成：MQTT 适合传控制消息，但官方固件没有把这些消息
解码为网络音频的播放器；扬声器出声必须由设备端应用调用 `AudioManager` /
`MediaPlayer`，这正是旁载固件所做的事。

## HTTP 与 MQTT

当前仍使用 TC002 原生的 `POST /api/custom?name=...` HTTP 接口。对本项目这种“本机生成完整帧并直接推送到同一台局域网时钟”的模式，HTTP 有三个优势：无需 Broker、一次请求就是一个完整 Custom App、删除旧旋钮项目也有明确语义。

内容框架与传输已经解耦：`WorkspaceController` 通过注入的 `pushPayload(appName, payload)` 写设备。未来若要接 Home Assistant、跨网络消息总线或多个订阅设备，可以新增 MQTT 传输适配器，不需要改任何市场、工具或视觉渲染器；目前没有为了协议兼容而引入 Broker 依赖。

## 开发与运行

项目通过 `mise.toml` 固定 Bun 1.3.14：

```bash
mise install
mise run test
mise run typecheck
mise run build
CLOCK_HOST=192.168.1.50 bun start
```

也可以直接执行：

```bash
bun install
bun test
bun run typecheck
bun run build
```

生成每个频道的设备图和前 12 帧预览：

```bash
bun run preview
```

产物位于 `.runtime/previews/`。查看服务状态：

```bash
bun run status
```

## 安装

macOS LaunchAgent：

```bash
bash scripts/install.sh --host 192.168.1.50
```

Docker Compose：

```bash
bash scripts/install-docker.sh --host 192.168.1.50
```

macOS 安装默认监听 `0.0.0.0`，以便同一局域网中的手机访问；打开右上角“常规设置”，点击标题栏手机图标即可扫码或复制与时钟同网段的当前 IP 与端口。只希望本机访问时，可传入 `--control-host 127.0.0.1`。Docker 容器内部监听 `0.0.0.0`，但 Compose 仍只把控制端口发布到宿主机 `127.0.0.1`。两种安装方式不要同时占用同一个 43820 端口。

主要环境变量：

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `CLOCK_HOST` | 无，必填 | TC002 的局域网 IP 或主机名，不带协议和端口 |
| `CONTROL_HOST` | macOS 安装为 `0.0.0.0`；直接运行为 `127.0.0.1` | 控制台监听地址；手机访问需要 `0.0.0.0` |
| `APP_NAME` | `btc` | 仅用于旧配置首次迁移时的默认频道名 |
| `REQUEST_TIMEOUT_MS` | `5000` | 行情和设备请求超时 |
| `SOURCE_STALE_MS` | `120000` | 行情失败时允许复用缓存的时间 |
| `DISPLAY_DURATION_SECONDS` | `90` | Custom App 在设备上的最短有效时间 |
| `HEALTH_PORT` | `43820` | 控制台、API 和健康检查端口 |
| `ADB_BIN` | 安装时自动检测 | `adb` 的绝对路径；macOS LaunchAgent 不继承终端 PATH，因此刷机检测使用此值 |

## 本地 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/catalog` | 内容分类、选项定义和默认值 |
| `GET` / `PUT` | `/api/workspace` | 读取或原子保存全部频道 |
| `POST` | `/api/channels/preview` | 预览已保存频道或未保存的频道草稿 |
| `POST` | `/api/channels/push` | 推送一个频道 |
| `POST` | `/api/push` | 推送全部启用频道 |
| `GET` | `/api/state`、`/health` | 设备、频道、行情和清理状态 |
| `GET` / `PUT` | `/api/device/settings/general` | 读取或写入 TC002 常规设置 |
| `GET` | `/api/access` | 返回与时钟同网段的控制台手机访问地址和监听状态 |
| `GET` | `/api/presets` | 兼容旧客户端的市场预设 |
| `GET` / `PUT` | `/api/settings` | 兼容旧版单市场轮播设置 |
| `GET` | `/api/library/ulanzi/pixel-assets` | 查询官方社区素材、分类、搜索和分页 |
| `GET` | `/api/library/ulanzi/media` | 安全代理官方素材缩略图 |
| `POST` | `/api/library/ulanzi/import` | 校验并导入官方 `contentView` 链接或作品 ID |
| `GET` | `/api/library/ulanzi/imported/:ref` | 读取已归一化的本地素材快照 |
| `GET` | `/api/music/session`、`/api/music/avatar` | 返回脱敏后的网易云登录状态与头像代理 |
| `POST` | `/api/music/qr`、`/api/music/qr/check`、`/api/music/logout` | 创建/确认服务端二维码会话、登出并删除本机凭据 |
| `GET` | `/api/music/search`、`/api/music/playlists`、`/api/music/playlists/:id/tracks` | 搜索歌曲、读取歌单及歌单曲目 |
| `GET` | `/api/music/tracks/:id` | 读取歌曲信息与逐行歌词 |
| `GET` | `/api/music/tracks/:id/stream` | 同源代理允许域名内的网易云音频，支持 Range |
| `GET` / `POST` | `/api/music/device-app/*` | 校验旁载包、检测真机、启动/结束内存盘调试会话 |
| `POST` / `DELETE` | `/api/music/mirror` | 把 52×16 歌词帧（≤60 帧）推送到官方固件的 Custom App 位（设备同屏） |
| `POST` | `/api/music/device/select`、`/api/music/device/control` | 网页下发选歌与控制补丁（播放/主题/配色/主色/seek） |
| `GET` | `/api/music/device/state` | 音乐固件轮询的纯文本控制状态（含序列号与设备实况回显） |
| `POST` | `/api/music/device/report`、`/api/music/device/heartbeat` | 固件上报按键动作与播放头心跳 |
| `GET` | `/api/music/device/now`、`/api/music/device/audio` | 固件读取当前曲目歌词与下载音频 |

写接口仅接受 JSON，并执行同源检查；请求体上限为 256 KiB。工作区最多 24 个频道、每频道 48 项、每频道最多渲染 360 帧。App 名唯一且限制为 1–32 个 ASCII 字母、数字、下划线或连字符。

## 扩展内容

新增可信内置内容时，在 `src/content-registry.ts` 注册一个 `ContentDefinition`。渲染器接收时间、共享行情读取器和内容配置，只返回：

```ts
{
  frames: PixelCanvas[];
  frameDelaysMs: number[];
  label: string;
}
```

不要在渲染器中启动定时器、保留无界历史或直接访问时钟。目前注册表故意不动态加载任意第三方 JavaScript；如果以后需要不受信任插件，应使用独立进程协议并另写 ADR。

## 数据与许可证

- 加密资产：Coinbase，Kraken 备用，24H 变化。
- 黄金：Gold API；免费接口没有可靠 24H 开盘字段，因此不伪造涨跌。
- USD/CNY：Frankfurter 的央行日参考汇率，不是逐笔外汇报价。
- 美股：Yahoo Finance Chart 元数据，1D 前收盘变化。

本项目因迁移和修改 GPL‑3.0 的 PixDeck 内容而采用 **GPL‑3.0-only**。分发源码或二进制前请阅读 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
