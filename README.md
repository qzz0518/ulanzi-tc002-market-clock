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
- 顶部“内容 / 画板 / 素材库”三个一级视图；素材库使用独立宽版三列布局。

前端使用 React、Cladd UI 和 Tailwind CSS v4。Cladd 负责按钮、表单、Tabs、Select、删除确认、Tooltip、Toast 与可拖拽数值输入的统一交互；页面仍保留本项目原有的黑白绿 Pixel Market 视觉语言，并对动效启用 `prefers-reduced-motion` 降级。

设置保存在 `.runtime/workspace.json`。旧版 `.runtime/settings.json` 会在首次启动时原子迁移为一个市场频道，保留已选资产和轮播时间；原文件不会被覆盖。

禁用、删除频道或修改 `appName` 时，服务会向旧 Custom App 名发送空对象进行清理。设备离线时清理失败只记录为降级状态，不回滚已经保存的新工作区。

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

macOS 默认只监听 `127.0.0.1`。Docker 容器内部监听 `0.0.0.0`，但 Compose 仅把控制端口发布到宿主机 `127.0.0.1`。两种安装方式不要同时占用同一个 43820 端口。

主要环境变量：

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `CLOCK_HOST` | 无，必填 | TC002 的局域网 IP 或主机名，不带协议和端口 |
| `APP_NAME` | `btc` | 仅用于旧配置首次迁移时的默认频道名 |
| `REQUEST_TIMEOUT_MS` | `5000` | 行情和设备请求超时 |
| `SOURCE_STALE_MS` | `120000` | 行情失败时允许复用缓存的时间 |
| `DISPLAY_DURATION_SECONDS` | `90` | Custom App 在设备上的最短有效时间 |
| `HEALTH_PORT` | `43820` | 控制台、API 和健康检查端口 |

## 本地 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/catalog` | 内容分类、选项定义和默认值 |
| `GET` / `PUT` | `/api/workspace` | 读取或原子保存全部频道 |
| `POST` | `/api/channels/preview` | 预览已保存频道或未保存的频道草稿 |
| `POST` | `/api/channels/push` | 推送一个频道 |
| `POST` | `/api/push` | 推送全部启用频道 |
| `GET` | `/api/state`、`/health` | 设备、频道、行情和清理状态 |
| `GET` | `/api/presets` | 兼容旧客户端的市场预设 |
| `GET` / `PUT` | `/api/settings` | 兼容旧版单市场轮播设置 |
| `GET` | `/api/library/ulanzi/pixel-assets` | 查询官方社区素材、分类、搜索和分页 |
| `GET` | `/api/library/ulanzi/media` | 安全代理官方素材缩略图 |
| `POST` | `/api/library/ulanzi/import` | 校验并导入官方 `contentView` 链接或作品 ID |
| `GET` | `/api/library/ulanzi/imported/:ref` | 读取已归一化的本地素材快照 |

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
