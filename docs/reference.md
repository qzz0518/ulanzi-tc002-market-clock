# 技术参考

[English](reference.en.md) | 简体中文

首页 README 只讲「是什么、怎么装」；这里是完整的配置、数据来源、控制台行为、
架构与本地 API 参考。

## 配置与运行

`mise.toml` 固定 Bun 1.3.14。不用 mise 时直接 `bun install && bun start`。
开发常用命令：

```bash
mise run test && mise run typecheck && mise run build
bun run preview        # 把各频道预览图生成到 .runtime/previews/
bun run status         # 查看服务状态
```

macOS 安装（`scripts/install.sh`）默认监听 `0.0.0.0`，方便同局域网手机访问（常规设置 →
标题栏手机图标可扫码/复制地址）；传 `--control-host 127.0.0.1` 则只留本机。Docker 安装
（`scripts/install-docker.sh`）仅发布到宿主机回环。两者勿同时占用同一个 43820 端口。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLOCK_HOST` | 无，必填 | TC002 的局域网 IP 或主机名，不带协议和端口 |
| `CONTROL_HOST` | macOS 安装为 `0.0.0.0`；直接运行为 `127.0.0.1` | 控制台监听地址；手机访问需要 `0.0.0.0` |
| `HEALTH_PORT` | `43820` | 控制台、API 和健康检查端口 |
| `REQUEST_TIMEOUT_MS` | `5000` | 行情和设备请求超时 |
| `SOURCE_STALE_MS` | `120000` | 行情失败时允许复用缓存的时间 |
| `DISPLAY_DURATION_SECONDS` | `90` | Custom App 在设备上的最短有效时间 |
| `APP_NAME` | `btc` | 全新安装或旧配置首次迁移时的默认频道名 |
| `ADB_BIN` | 安装时自动检测 | `adb` 的绝对路径；LaunchAgent 不继承终端 PATH |
| `CLOCK_HTTP_PROXY` | 无 | 可选，设备请求走的回环 HTTP 代理（不带凭据） |

## 控制台行为

手机竖屏把「频道编排」和「添加内容」拆成两个工作区，底部导航与单列表单针对触控重排，
画板会提示横屏使用。页面自带 Web App Manifest 与离线静态壳，可「添加到主屏幕」；完整
PWA 安装需要可信 HTTPS，纯局域网 HTTP 下响应式控制台不受影响。

设置保存在 `.runtime/workspace.json`；旧版 `.runtime/settings.json` 首次启动时原子迁移为
一个市场频道，原文件不覆盖。禁用、删除频道或修改 `appName` 时，服务向旧 Custom App 名
发送空对象清理；设备离线导致清理失败只记录为降级状态，不回滚已保存的工作区。

## 市场数据

### 搜索添加任意资产（免 key）

内容市场里的「搜索更多资产」支持四类资产，全部走公开接口，无需申请任何 API key：

| 类型 | 来源 | 说明 |
| --- | --- | --- |
| 数字货币 | Coinbase Exchange 公开目录与行情 | 任意可交易产品，24H 涨跌 |
| 股票 / ETF | Yahoo Finance 公开搜索 + Chart 接口 | 美股、港股、A 股、日欧等主要交易所；价格可能延迟，1D 涨跌 |
| 汇率 | Frankfurter（ECB 参考汇率） | 任意 ISO 货币对，央行日参考价而非逐笔报价 |
| 金属 | Gold API | 金、银、铂、钯现货 |

股票搜索只放行报价币种无歧义的交易所（伦敦便士报价、OTC 粉单不出现在结果里），报价端还会
核对实际上市币种，不符即报错，绝不把价格标成错误币种。添加后的资产保存为本地稳定身份；报价
失败时先沿用缓存旧价，缓存过期后跳过该项，频道其余内容不受影响。

### 图标生成

数字货币若能在打包的 CC0 目录（`cryptocurrency-icons@0.18.1`）中通过符号 + 归一化名称
双重匹配，就离线确定性像素化成 16×16 品牌图；匹配不确定或其他资产类型一律使用按身份
生成的程序化像素标识，绝不猜图。内置四只美股沿用 PixDeck 原始图标，来源与哈希见
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

### 内置资产的数据来源

内置 10 资产：加密货币走 Coinbase（Kraken 备用，24H 变化）；黄金用 Gold API（免费接口无
可靠 24H 开盘字段，不伪造涨跌）；USD/CNY 为 Frankfurter/ECB 日参考汇率；四只美股用 Yahoo
Chart（1D 前收盘变化）。搜索添加的运行时资产每类固定单一来源（Coinbase / Yahoo /
Frankfurter / Gold API，无备用路由），报价失败即降级显示。

## 素材库

素材库直连 Ulanzi 官方社区（每次浏览、搜索、翻页都实时请求官方接口，上游增删随时可见），
也可粘贴 `ugc.ulanzistudio.com/contentView/...` 链接导入。导入素材会最近邻还原到 52×16、
保留 GIF 帧时序，快照存于本机 `.runtime/pixel-assets`——之后预览和推送不依赖官方站点在线，
也不会被上游改动静默替换。社区作品不随本仓库分发，界面保留作者与来源。

## 音乐

登录 Cookie 只存本机 `.runtime/music-session.json`（权限 `0600`），浏览器和时钟都拿不到
原始凭据，登出即删除；歌曲能否播放仍受账号、会员、版权和地区限制，45 秒试听不会被显示成
完整歌曲。

预览与设备共用同一套主题系统：四种显示形式（走带 / 天际 / 聚光 / 升降）× 四套配色
（信号绿 / 磁带橙 / 蓝晒 / 街机红），另可用取色器覆盖自定义主色。字模也是同一份：
网页不在运行期光栅化网页字体，而是直接读固件那套离线生成的 12×12 中日文 / 6×12
半宽 ASCII 点阵表，所以预览、推给官方固件的帧、原生固件三者逐像素一致。

两条上屏路径的细节：

- **设备同屏（官方固件，不刷机）**：把渲染好的歌词帧（≤60 帧、约 15fps）推到官方固件的
  Custom App 通道显示；声音由浏览器播放。
- **原生音乐固件（非持久化侧载）**：FlyThings C++ 播放器用 Docker 交叉编译，无需 Windows
  IDE；侧载时服务地址自动写入设备，换网络、换机器都无需重新编译。固件在真机上下载音频、
  扬声器播放、毫秒级进度跳转，用离线光栅化的 12×12 中日文字模直接驱动 LED，并自带六秒
  开机动画与「选择歌曲」待机画面。网页与固件通过控制序列 + 心跳协议双向实时同步：网页
  选歌/暂停/换主题/拖进度 2 秒内落到设备，设备按键即时回流，预览动画锚定真机播放头。
  固件上线数秒内工作台自动切换为遥控模式，并锁定内容/画板/素材库与常规设置（它们走官方
  固件通道，直连期间不可用），恢复官方固件后自动解锁。官方固件没有能解码网络音频的播放
  器，扬声器出声必须由设备端应用调用 `AudioManager`——这正是侧载固件存在的原因（MQTT
  只能传控制消息，替代不了它）。

侧载始终是非持久化的：固件只推进设备内存盘临时运行，点「恢复官方固件」或断电重启即回到
原样，flash 从不被写入。侧载前需三重确认：固件包逐文件 SHA-256 与发布清单一致、官方
HTTP 接口与 Wi-Fi ADB 双重确认真机、用户勾选已知恢复方式。固件源码、协议、构建与部署
详见 [device/tc002-lyrics-player](../device/tc002-lyrics-player/README.md)。

## 架构与扩展

内容渲染器只产生 52×16 帧和延时，不允许写设备或自建后台循环；统一控制器负责行情缓存、
帧数上限、GIF 编码、串行设备写入、失败隔离和刷新调度（决策见
[ADR 0001](adr/0001-extensible-content-channels.md)）。新增可信内置内容就是在
`src/content-registry.ts` 注册一个 `ContentDefinition`；注册表故意不动态加载任意第三方
JavaScript，不受信任的插件应走独立进程协议并另写 ADR。

设备传输当前使用 TC002 原生的 `POST /api/custom?name=...`（无需 Broker，一次请求就是一个
完整 Custom App，删除旧项目语义明确），并通过注入的 `pushPayload(appName, payload)` 与内容
框架解耦——将来接 Home Assistant 或 MQTT 总线只需新增传输适配器，不改任何渲染器。音乐的
架构边界（网页 / 服务端 / 固件各自负责什么）见
[ADR 0002](adr/0002-native-music-player-boundary.md)。

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
| `GET` | `/api/access` | 返回同网段手机访问地址和监听状态 |
| `GET` | `/api/market/search` | 按关键词与类型搜索可添加的市场资产 |
| `GET` / `POST` | `/api/market/instruments` | 列出已添加资产；按候选引用注册新资产 |
| `GET` | `/api/market/icons/:iconRef.png` | 运行时资产的 16×16 像素图标（不可变缓存） |
| `GET` | `/api/presets`、`/api/icons/:id.png` | 兼容旧客户端的市场预设与内置资产图标 |
| `GET` / `PUT` | `/api/settings` | 兼容旧版单市场轮播设置 |
| `POST` | `/api/preview` | 兼容旧版：直接返回渲染的 GIF/PNG 字节 |
| `GET` | `/api/library/ulanzi/pixel-assets` | 查询官方社区素材、分类、搜索和分页 |
| `GET` | `/api/library/ulanzi/media` | 安全代理官方素材缩略图 |
| `POST` | `/api/library/ulanzi/import` | 校验并导入官方 `contentView` 链接或作品 ID |
| `GET` | `/api/library/ulanzi/imported/:ref` | 读取已归一化的本地素材快照 |
| `GET` | `/api/music/session`、`/api/music/avatar` | 脱敏的网易云登录状态与头像代理 |
| `POST` | `/api/music/qr`、`/api/music/qr/check`、`/api/music/logout` | 服务端二维码会话；登出并删除本机凭据 |
| `GET` | `/api/music/search`、`/api/music/playlists`、`/api/music/playlists/:id/tracks` | 搜索歌曲、读取歌单及曲目 |
| `GET` | `/api/music/tracks/:id`、`/api/music/tracks/:id/stream` | 歌曲信息与逐行歌词；同源音频代理（支持 Range） |
| `GET` / `POST` | `/api/music/device-app/*` | 校验固件包、检测真机、侧载固件与恢复官方固件（内存盘会话） |
| `POST` / `DELETE` | `/api/music/mirror` | 把歌词帧（≤60）推到官方固件 Custom App（设备同屏） |
| `POST` | `/api/music/device/select`、`/api/music/device/control` | 网页下发选歌与控制补丁（播放/主题/配色/主色/seek） |
| `GET` | `/api/music/device/state`、`/api/music/device/current` | 音乐固件轮询的纯文本控制状态；兼容的轻量当前曲目查询 |
| `POST` | `/api/music/device/report`、`/api/music/device/heartbeat` | 固件上报按键动作与播放头心跳 |
| `GET` | `/api/music/device/now`、`/api/music/device/audio` | 固件读取当前曲目歌词与下载音频 |

写接口仅接受 JSON 并执行同源检查（设备上报的 `report` / `heartbeat` 除外，它们的调用方是
时钟固件）；请求体上限 256 KiB。工作区最多 24 个频道、每频道 48 项、
每频道最多渲染 360 帧；App 名唯一且限 1–32 个 ASCII 字母、数字、下划线或连字符。
