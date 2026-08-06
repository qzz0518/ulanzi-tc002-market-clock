# Ulanzi TC002 Pixel Market

[English](README.en.md) | 简体中文

一个由 zerah 维护、使用 Bun 运行的多资产像素行情看板。它从公开、免密钥的数据源获取行情，生成原生 52×16 像素 GIF，并通过 TC002 官方 Custom App HTTP 接口推送到时钟。服务提供 macOS 原生 LaunchAgent 和 Docker Compose 两种部署方式。

## 本机控制台

服务启动后打开：

```text
http://127.0.0.1:43820/
```

控制台可以：

- 多选 BTC、ETH、BNB、SOL、黄金和 USD/CNY，并按固定顺序轮播。
- 设置价格页、涨跌页停留时间，以及行情刷新下限。
- 开关涨跌页，实时查看与 52×16 灯珠一致的像素预览。
- 仅保存设置，或“保存并推送”立即更新时钟。
- 查看设备版本、推送时间、数据源和降级状态。

![Ulanzi TC002 像素行情控制台](docs/images/tc002-control-panel.png)

设置保存在被 Git 忽略的 `.runtime/settings.json`，重启后仍会生效。macOS 原生服务只监听 `127.0.0.1`；Docker 容器内部监听所有接口以便端口转发，但 Compose 只发布到宿主机 `127.0.0.1`。两种方式都不会默认把 GUI 与 API 暴露到局域网或公网。

## 资产预设与数据口径

| 资产 | 价格来源 | 涨跌口径 | 像素图标 |
| --- | --- | --- | --- |
| BTC/USD | Coinbase，Kraken 备用 | 24H | 比特币圆标 |
| ETH/USD | Coinbase，Kraken 备用 | 24H | 灰色圆底与以太坊钻石 |
| BNB/USD | Coinbase，Kraken 备用 | 24H | 黄色圆底与白色立方体 |
| SOL/USD | Coinbase，Kraken 备用 | 24H | Solana 三色条纹 |
| XAU/USD | Gold API | 不显示 | 三面斜放金条 |
| USD/CNY | Frankfurter | 1D 参考价变化 | USD / CNY 双行标识 |

黄金的免费实时接口没有可靠的 24H 开盘字段，因此程序只显示实时参考价格，不伪造涨跌数据。USD/CNY 是 Frankfurter 汇总的央行日参考汇率，不是逐笔外汇报价。

## 轮播与刷新

默认设置：

- 价格页 12.5 秒。
- 涨跌页 2.5 秒。
- 行情刷新下限 15 秒。
- 默认只启用 BTC/USD。

多选资产后，完整轮播会变长。程序的实际刷新周期为“用户设置的刷新下限”和“完整轮播时长”中的较大值，避免新推送提前重置 GIF、导致队列后面的资产永远无法显示。

所有背景像素使用严格的 RGB `[0, 0, 0]`，对应灯珠完全关闭。主要数字使用 2 像素粗笔画与受控亮度，降低 TC002 面罩造成的泛光。

## 开发与运行

项目使用 `mise.toml` 固定 Bun 1.3.14。已经安装 mise 时可执行：

```bash
mise install
mise run test
mise run typecheck
mise run build
```

也可以直接使用项目声明的 Bun 版本：

```bash
bun install
bun test
bun run typecheck
bun run build
CLOCK_HOST=192.168.1.50 bun start
```

`bun run build` 会在被 Git 忽略的 `dist/` 中生成服务、状态命令和预览命令的 Bun bundle。

生成当前配置的 GIF、逐帧预览和六图标总览：

```bash
bun run preview
```

查看运行状态：

```bash
bun run status
```

## macOS 原生安装

安装脚本会安装依赖、生成 bundle、写入仅当前用户可读的 `.runtime/service.env`，然后安装并启动 LaunchAgent。存在 mise 时，脚本会使用 `mise.toml` 固定的 Bun 版本；没有 mise 时，仅接受 Bun 1.3.14，避免使用未经验证的版本构建后台服务。

```bash
bash scripts/install.sh
```

脚本会提示输入 TC002 的局域网 IP 或主机名。用于自动化安装时没有交互终端，必须通过 `--host` 或 `CLOCK_HOST` 显式提供：

```bash
bash scripts/install.sh --host 192.168.1.50
```

如果访问 TC002 必须经过本机无认证 HTTP 代理：

```bash
bash scripts/install.sh \
  --host 192.168.1.50 \
  --proxy http://127.0.0.1:6152
```

服务标识为 `com.zerah.ulanzi-market-clock`，登录时自动启动，异常退出后重新拉起。日志位于 `.runtime/service.log` 和 `.runtime/service.error.log`。

```bash
launchctl print gui/$(id -u)/com.zerah.ulanzi-market-clock
bash scripts/uninstall.sh
```

## Docker Compose 安装

Docker 方式不需要宿主机安装 Bun。安装脚本会构建固定 Bun 版本的非 root、只读运行镜像，生成 `.runtime/docker.env`，然后启动 Compose 服务：

```bash
bash scripts/install-docker.sh
```

Docker 安装脚本同样会提示输入 TC002 地址。非交互部署可以使用：

```bash
bash scripts/install-docker.sh --host 192.168.1.50
```

Docker 宿主机必须能够直接路由到这个 TC002 地址。公网 VPS 无法自动发现或访问家庭 NAT 后面的 `192.168.x.x` 时钟；这种场景需要先建立 VPN/私网路由。建议为 TC002 设置 DHCP 地址保留，并优先传入数字局域网 IP。

Compose 把控制台发布为 `http://127.0.0.1:43820/`，不会默认开放公网访问。查看状态和日志：

```bash
docker compose --env-file .runtime/docker.env ps
docker compose --env-file .runtime/docker.env logs -f market-clock
```

重新安装或修改时钟地址时，直接再次执行 `scripts/install-docker.sh`。卸载容器和 Compose 网络：

```bash
bash scripts/uninstall-docker.sh
```

卸载脚本会保留本地镜像、`.runtime/docker.env` 和 `.runtime/settings.json`。macOS 原生服务与 Docker 默认占用同一个控制台端口，不应同时启动。

两种部署方式共用的配置：

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `CLOCK_HOST` | 无，必填 | TC002 地址，不带 `http://` 或端口；安装脚本会提示输入 |
| `APP_NAME` | `btc` | TC002 Custom App 名称 |
| `REQUEST_TIMEOUT_MS` | `5000` | 行情及设备请求超时 |
| `SOURCE_STALE_MS` | `120000` | 可复用缓存行情的最大陈旧时间 |
| `DISPLAY_DURATION_SECONDS` | `90` | Custom App 最短有效时间；长轮播会自动延长 |
| `HEALTH_PORT` | `43820` | 宿主机 GUI、控制 API 与健康状态端口 |

`CLOCK_HTTP_PROXY` 仅用于 macOS 原生安装时访问 TC002；Docker 默认直接访问局域网设备。`CONTROL_HOST` 由安装方式管理：macOS 固定为 `127.0.0.1`，Docker 容器内部固定为 `0.0.0.0`，并由 Compose 限制宿主机发布范围。

## 本地控制 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/presets` | 六个资产预设与数据源说明 |
| `GET` / `PUT` | `/api/settings` | 读取或保存显示设置 |
| `GET` | `/api/state` | 设备、行情和推送状态 |
| `POST` | `/api/preview` | 按草稿设置生成预览，不保存、不推送 |
| `POST` | `/api/push` | 使用已保存设置立即推送 |
| `GET` | `/health` | 与状态脚本兼容的健康信息 |

写操作要求 JSON，并拒绝来自其他 Origin 的浏览器请求。程序不需要交易所密钥，不读取钱包或账户数据，也不刷写 TC002 固件。
