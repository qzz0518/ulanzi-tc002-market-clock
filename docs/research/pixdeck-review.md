# PixDeck 源码审查：哪些值得 Ulanzi Clock 学，哪些不要照搬

> 审查日期：2026-08-06
> 上游仓库：<https://github.com/cailurus/PixDeck>
> 固定快照：[`599f712d8ea086ce5b31041130f4353b3816fa0c`](https://github.com/cailurus/PixDeck/tree/599f712d8ea086ce5b31041130f4353b3816fa0c)（2026-07-16）
> 证据边界：只使用该提交的 README、源码、测试、提交历史与本地运行结果；没有把作者描述当成设备实测。本文提到的“本地项目”指当前 `Ulanzi Clock` 工作区。

## 结论先行

PixDeck 最值得学的不是某一段 Python/Vue 代码，而是三个产品方向：

1. **把内容源做成内部插件注册表**：插件声明名称、分类、刷新间隔、参数 schema 和渲染入口，控制台自动生成列表与设置 UI。
2. **把 52×16 像素画布做成一等功能**：绘画、文字、图片像素化、撤销/重做、导出和推送形成了完整的轻量创作闭环。
3. **把设备 payload 与传输方式分离**：同一帧可以经 HTTP 或 MQTT 发送，内容插件不关心链路。

但它目前仍是一个很年轻的个人项目，不适合直接 fork 或拷贝进本地项目。插件是进程内任意代码、运行生命周期缺少强约束；MQTT 是自写的明文 QoS 0 客户端；写 API 没有同源校验；凭据经 URL query 传递并明文落盘；测试集中在纯函数和 MQTT，缺少 HTTP、插件生命周期、组件交互与真机闭环。上游采用 GPL-3.0，复制或改编代码/资产前也必须先决定本地项目的许可策略（[README 许可说明](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/README.md#L49-L51)）。

因此建议：**借鉴架构思想，按本地 Bun/TypeScript 架构重写；保留本地现有的中央调度、原子设置、同源写保护、CSP 和测试基线。**

## 一览：建议级别

| 方向 | PixDeck 做法 | 对本地项目的建议 |
| --- | --- | --- |
| 插件注册 | 扫描 `plugins/*/plugin.py`，从模块常量和函数推导插件 | **学概念，重写实现**：用强类型 manifest + 显式注册表，不动态执行第三方目录 |
| 插播/抢占 | 附属插件通过单调时钟暂时抢占宿主组件 | **值得学**：做成中央调度器的通知优先级/租约，不让插件直接推设备 |
| 设备 payload | `bitmap_frame` 统一 52×16 位图；HTTP/MQTT 共用 JSON | **值得学**：抽出 `FrameTransport`，同时保留本地 GIF/PNG 适配器 |
| MQTT | 自写 MQTT 3.1.1、QoS 0、无 TLS | **不要照搬**：使用成熟库、TLS/鉴权、ACK/错误状态、秘密安全存储 |
| 像素编辑器 | 画笔、橡皮、框选、文字、图片量化、撤销/重做、PNG 导出 | **高价值**：复用本地 `PixelCanvas`，补触控、键盘、工程文件和多帧 |
| Web 安全 | 绑定 loopback、校验 Host 与设备私网 IP | **只学其中一半**：保留本地更强的同源 JSON、CSP、body 限制；补秘密处理 |
| 测试 | 10 个 Python + 19 个前端测试；前端 typecheck/build 可过 | **参考纯函数拆分**，但不要降低本地 36 项跨层测试与打包验证基线 |

## 1. 架构与插件机制

### 值得学习

PixDeck 的插件契约很小：主插件提供 `APP / NAME / GROUP / DESC / DEFAULT_INTERVAL / ITEMS` 和 `frame_for`，复杂插件可覆盖 `run_loop`；附属插件声明 `ATTACH` 并提供 `attach_loop`。契约直接写在核心模块开头，样例又足够多，降低了新增内容的门槛（[插件契约](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_core.py#L2-L23)，[简单股票插件](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/plugins/stock/plugin.py#L13-L62)，[自定义计时循环](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/plugins/timer/plugin.py#L217-L269)）。

更有价值的是“参数 schema 驱动 UI”：后端把 `OPTIONS` 原样放入 runner snapshot，前端按 `text / number / search / choices` 渲染通用字段，新增插件一般不需要再写一套设置页（[后端 option 校验与 snapshot](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_panel.py#L116-L139)，[Runner 暴露 schema](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_panel.py#L142-L232)，[通用 OptionField](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/components/OptionField.vue#L21-L40)）。

附属插件的“租约式抢占”也值得保留：核心用 `time.monotonic()` 记录宿主 app 的抢占到期时间，普通帧在租约内丢弃，附属帧用 `force=True` 注入，到期后宿主自然恢复（[抢占实现](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_core.py#L27-L80)，[提醒插件](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/plugins/reminder/plugin.py#L12-L32)）。这比让“提醒”和“行情”互相覆盖更容易解释。

本地项目已有更稳的中央控制面：`DashboardController.pushNow()` 会串行化重叠推送（`src/controller.ts:155-168`），并统一维护缓存、降级、离线画面和运行状态（`src/controller.ts:171-250`）。因此更合适的本地形态是：

```ts
interface PluginDefinition<Settings> {
  id: string;
  title: string;
  category: "market" | "tool" | "game" | "ambient" | "notification";
  settingsSchema: SettingsSchema<Settings>;
  defaults: Settings;
  render(ctx: PluginContext, settings: Settings): Promise<RenderedFrame>;
}
```

插件只返回帧和下一次更新时间；**调度、抢占、推送、超时、日志和状态都由 controller 管**。第一阶段只支持仓库内置、显式注册的插件，暂不承诺第三方插件 ABI。

### 尚不成熟，不应照搬

- 自动发现会直接 `exec_module()` 执行每个 `plugins/*/plugin.py`，没有 manifest 版本、能力声明、签名、沙箱或进程隔离（[discover 实现](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_core.py#L150-L171)）。它适合“可信内置模块”，不等于安全的第三方插件系统。
- 每个主插件和附属实例各占一个 daemon thread；`running()` 只返回用户意图 `active`，不检查线程是否仍存活。若插件在未捕获异常中退出，UI 仍可能显示“运行中”（[Runner 生命周期](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_panel.py#L142-L182)）。附属停止只 `set()` event，不 join（[Attachment.stop_run](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_panel.py#L296-L300)）。
- 动态插件各自直接推设备，动画 tick 常见为 0.05–0.2 秒；同时开启多个视觉插件时，请求频率会叠加，而核心没有全局速率限制、背压或帧仲裁（例如 [兰顿蚂蚁 0.05s tick](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/plugins/ant/plugin.py#L20-L21)、[天气 0.12s tick](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/plugins/weather/plugin.py#L24-L25)）。真机承载上限没有证据，不能把“线程能跑”当成设备稳定性。
- `ThreadingHTTPServer` 可并发进入 start/stop/set-option，但 runner 生命周期本身没有一把统一锁；插件 options 也由请求线程写、插件线程读。对个人 loopback 工具通常够用，却不是可证明的一致性模型。
- UI 声称插件参数“改动即时生效并保存”（[PluginSettings](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/components/PluginSettings.vue#L23-L25)），实际持久化函数只保存设备和 transport；interval、插件 options、附件及开关均没有写入配置（[配置持久化范围](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_panel.py#L19-L64)）。重启即丢失，产品语义与实现不一致。

## 2. 设备传输：可学的边界与 MQTT 风险

### 值得学习

`bitmap_frame()` 把 832 个行优先像素统一封装成 TC002 的 `db` draw 指令；`push()` 再根据 transport 把同一 JSON POST 给设备或发布到 MQTT topic。这一层次划分很干净（[位图与传输切换](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_core.py#L33-L85)）。面板对设备地址和 broker 地址也做了私网 IPv4、端口及 link-local 约束，明确考虑了 SSRF（[设备/broker 校验](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_panel.py#L76-L110)）。

本地项目目前从 `PixelCanvas` 生成 PNG/GIF（`src/pixel-ui.ts:7-91`），再通过官方 Custom App HTTP payload 推送（`src/display.ts:13-28`、`src/clock-client.ts:161-185`）。建议新增接口而不是替换现有链路：

```ts
interface FrameTransport {
  push(app: string, payload: ClockPayload, signal?: AbortSignal): Promise<PushReceipt>;
}
```

- `HttpClockTransport` 继续复用现在有超时、HTTP 状态校验的实现。
- 单帧画布可新增 `db` bitmap adapter，动画仍保留现有 GIF pipeline。
- 如确有跨网需求，再加 `MqttClockTransport`；transport 是注入 controller 的实例，不用进程级可变全局。

### MQTT 实现不要照搬

当前 MQTT 客户端只实现 MQTT 3.1.1 CONNECT/PUBLISH、QoS 0、无 keepalive、无 TLS（[协议能力](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_mqtt.py#L28-L51)，[Publisher](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_mqtt.py#L88-L137)）。此外：

- `_connect_locked()` 只检查收到的是 CONNACK，不检查返回码是否为 0（[L106-L113](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_mqtt.py#L106-L113)）。实测 stub broker 返回 `CONNACK return code 5`（拒绝）后，`publish()` 仍返回成功。
- QoS 0 没有发布 ACK；TCP `sendall()` 成功不等于 broker 或设备消费成功。故它不能提供与本地 HTTP 2xx 检查等价的送达语义。
- 设置页把 MQTT 用户名和密码放进 POST URL query（[前端 API](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/api.ts#L3-L10)），后端再把密码明文写入 `.pixbar.json`（[保存逻辑](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_panel.py#L49-L73)）。在当前 macOS 默认 umask 下实测文件模式为 `0644`。本地实现绝不能沿用这一秘密处理方式。
- transport 是进程全局字典，重配时在没有跨层锁的情况下关闭旧 publisher（[全局 transport](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_core.py#L33-L49)），可能和正在推送的插件线程竞争。

若本地项目加入 MQTT，应使用维护中的库，至少覆盖 TLS、唯一 client id、CONNACK 返回码、断线/重连、QoS 语义、topic 校验、超时与可观测 receipt；密码走环境变量、0600 文件或系统安全存储，永远不进 URL、日志或状态 API。

## 3. 前端像素编辑器

### 值得学习

画布核心和 Vue 组件拆得相对清楚：`Grid` 固定为 `[y][x]` 的 16×52 数组，`flatten()` 明确转成行优先的 832 个 `0xRRGGBB` 值（[grid.ts](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/canvas/grid.ts#L1-L29)）；状态层提供最多 50 步撤销/重做、落字、落图、推送和 PNG 导出（[useCanvas](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/canvas/useCanvas.ts#L16-L107)）；图片只在浏览器本地解码，没有上传到服务端（[ImagePanel](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/components/ImagePanel.vue#L13-L45)）。后端又验证 body 大小、像素数量、数值和 duration（[canvas push 校验](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_panel.py#L481-L503)）。

这套闭环非常适合本地项目，但不需要为了它整体引入 Vue。可以复用现有 `PixelCanvas`（`src/pixel-ui.ts:59-91`）并把编辑状态拆成独立 TypeScript 模块，再嵌入当前 `src/web-ui.ts`。尤其应直接复用本地已有的 TC002 实机外框预览和 52×16 像素遮罩（`src/web-ui.ts:281-337`），让“编辑预览”和现有行情预览使用同一渲染真相源。

建议本地 MVP 包含：

1. 画笔、橡皮、选区移动、撤销/重做；
2. 共用本地字体与 palette 的文字工具；
3. 本地图片导入、裁切、量化、亮度上限和纯黑背景；
4. 导出 PNG，同时导入/导出可继续编辑的版本化 JSON 工程文件；
5. 从第一天支持 Pointer Events、触控、键盘导航和可访问名称；
6. 数据模型预留多帧和每帧 duration，避免以后从单帧结构重做 GIF 编辑器。

### 当前画板的具体不足

- 交互只监听 `MouseEvent` 和 `mousedown/mousemove`，没有 Pointer/Touch/键盘编辑；颜色项还是可点击 `<span>`，没有按钮语义或名称（[CanvasStage 事件](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/components/CanvasStage.vue#L56-L115)，[颜色 swatch](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/components/CanvasControls.vue#L22-L31)）。
- 响应式缩放有坐标 bug：canvas backing width 是 728，但 `cellAt()` 始终用 CSS 位移除以固定 `CELL=14`；CSS 又允许 `max-width:100%` 缩小画布（[计算与样式](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/components/CanvasStage.vue#L6-L20)，[L118-L132](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/components/CanvasStage.vue#L118-L132)）。实测 390px viewport 下 CSS 宽 366、backing 宽 728，比例约 1.989；右半屏点击会落到错误列。
- UI 提供“最近邻”和“平滑”两个选项，但实现中二者落入同一分支，都只取采样块中心像素；测试也没有区分二者（[pixelize 分支](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/canvas/pixelize.ts#L61-L79)，[UI 选项](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/components/ImagePanel.vue#L56-L63)，[现有测试](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/__tests__/pixelize.test.ts#L12-L27)）。
- 编辑状态是模块级内存单例，没有工程保存/恢复；PNG 导出后无法无损继续编辑，也没有多帧/动画模型（[状态与导出](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/canvas/useCanvas.ts#L16-L34)，[L94-L107](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/canvas/useCanvas.ts#L94-L107)）。
- 上传图没有文件大小或像素尺寸上限，直接按原图尺寸分配 canvas；超大图片可能造成明显内存峰值（[ImagePanel L17-L40](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/components/ImagePanel.vue#L17-L40)）。

## 4. 测试、运行验证与安全

### 本次实际验证

在固定提交、Python 3.14.5、Node 26.0.0、npm 11.12.1 下：

| 验证 | 结果 |
| --- | --- |
| `python3 -m unittest tests.test_mqtt` | 10/10 通过 |
| `python3 -m unittest -v` | **0 tests**；默认发现并不会跑到现有测试 |
| `npm ci --ignore-scripts --no-audit --no-fund` | 成功 |
| `npm test` | 7 files、19/19 通过 |
| `npm run build` | typecheck + Vite build 通过；构建后 `git status` 仍干净 |
| `python3 pixbar_panel.py --port 18080` | 无设备也能启动；控制台与画板可打开 |
| 带 `Origin: https://example.com` 的 POST `/api/device?...` | **HTTP 200**；服务端未执行同源拒绝 |
| MQTT broker 返回拒绝 CONNACK | `publish()` 仍返回成功 |
| 390px 窄屏画布 | backing/CSS 宽度比约 1.989，源码坐标未乘该比例 |

Python 测试实际上只有一个文件，覆盖 codec、stub broker、transport 路由和两项地址/配置行为（[tests/test_mqtt.py](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/tests/test_mqtt.py#L1-L176)）。前端测试主要覆盖 grid、字体、像素化、状态分组、URL 拼装与撤销/重做（[前端 tests 目录](https://github.com/cailurus/PixDeck/tree/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/__tests__)）。固定快照中未见 CI workflow、panel HTTP 集成测试、插件逐个渲染测试、Runner/Attachment 并发测试、Vue 组件交互/E2E 或真机验收脚本（[仓库根目录](https://github.com/cailurus/PixDeck/tree/599f712d8ea086ce5b31041130f4353b3816fa0c)）。

相较之下，本地项目本次 `mise run test` 为 36/36 通过，`mise run typecheck` 通过；覆盖行情降级、controller、设置原子持久化、安装打包、设备 HTTP、控制 API 与像素输出。尤其应保留：

- 写接口的同源校验、JSON Content-Type 与 64 KiB body 上限（`src/control-api.ts:48-77`）；
- CSP、`frame-ancestors 'none'`、`form-action 'self'`、nosniff 和 no-referrer（`src/control-api.ts:86-105`）；
- 设置的严格 schema、迁移与临时文件 rename 原子写（`src/settings.ts:65-95`、`src/settings.ts:105-132`）；
- 重叠 push 的中央串行化和失败状态（`src/controller.ts:155-215`）。

### PixDeck 安全上可取与不可取之处

可取：面板固定绑定 `127.0.0.1`；静态文件用 realpath/commonpath 防目录穿越；设备与 broker 地址限制为私网 IPv4（[绑定与静态文件](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_panel.py#L411-L453)，[server bind](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_panel.py#L562-L584)）。

不可取：

- 所有写操作只检查 Host，没有检查 Origin/Referer，也不要求 JSON；动作和参数大多在 query string（[POST 入口](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_panel.py#L455-L480)，[前端 API](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/web/src/api.ts#L3-L22)）。实测任意 Origin 被接受。浏览器端能否从公网页面发到 loopback 还受具体浏览器 Private Network Access 策略影响，但服务端本身没有建立同源边界。
- `sysmon` 的 remote option 只是 300 字符文本，插件会据此发任意 HTTP 请求；它绕过了设备/broker 的私网校验（[通用 text 接受规则](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/pixbar_panel.py#L116-L139)，[remote fetch](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/plugins/sysmon/plugin.py#L80-L103)）。和缺少同源保护组合后，风险比单看其中一处更高。
- 远程监控探针默认监听 `0.0.0.0`、无鉴权、允许任意 Origin（[agent server](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/plugins/sysmon/agent.py#L76-L94)）；文档还建议 `curl | sudo sh`、`--pid=host` 与只读挂载宿主根目录（[部署说明](https://github.com/cailurus/PixDeck/blob/599f712d8ea086ce5b31041130f4353b3816fa0c/plugins/sysmon/README.md#L17-L45)）。即便指标低敏感，也不应把这种部署方式纳入本地项目默认路径。

## 5. 推荐的本地落地顺序

### P0：先做架构接口，不改现有行为

- 新增强类型 `PluginDefinition`、`SettingsSchema`、`RenderedFrame`、`FrameTransport`。
- 把现有市场看板注册为第一个 built-in plugin，但仍由现有 `DashboardController` 调度和串行推送。
- 为 manifest 唯一 id、默认设置、schema migration、调度抢占和错误隔离写测试。

### P1：做一个比 PixDeck 更稳的画板 MVP

- 复用 `PixelCanvas` 和现有 TC002 外框预览；不重复实现第二套坐标/颜色真相源。
- 支持 Pointer Events，并用 `canvas.width / rect.width`、`canvas.height / rect.height` 换算坐标。
- 所有工具都有键盘路径、focus ring、可访问名称；颜色使用真实 button。
- 图片先限制文件体积和最大解码尺寸，再做裁切/量化；“最近邻”和“平滑”必须有不同实现和 golden tests。
- 同时保存可编辑 JSON，而非只有 PNG；数据结构从一开始支持 frames + durations。

### P2：按真实需求决定是否加入 MQTT

只有当 HTTP 直连确实不能覆盖部署拓扑时再做。使用成熟 MQTT 库和依赖注入；先定义送达/重试/retain 的产品语义，再写代码。秘密不进 URL，broker/topic/client id 全部验证；测试至少包含拒绝 CONNACK、断线、重连、QoS、TLS 和重复 client id。

### P3：验收门槛

- 单元：manifest、frame packing、字体、量化、undo/redo、调度与抢占。
- 集成：控制 API 的同源/body/错误码，HTTP/MQTT stub，设置迁移与原子写。
- UI：鼠标、触控、键盘、窄屏、屏幕阅读器语义、超大图片。
- 设备：至少一台真实 TC002 验证单帧、动画、并发切换、离线恢复、长时间运行；源码测试通过不能替代这一步。

## 最终判断

PixDeck 很适合当“产品灵感和内部插件原型”的参考：它证明了 TC002 不只可以做固定行情页，还能成为可扩展内容面板和像素创作工具。对当前本地项目，最高回报是**强类型插件注册表 + 共用渲染核心的画板 + 中央抢占调度**。

不建议直接引入它的 Python 运行时、动态插件加载、自写 MQTT、线程模型、凭据配置或 sysmon 部署脚本。当前本地项目在可靠性、安全边界、设置持久化、打包和测试上已经更扎实；后续扩展应建立在这些优势上，而不是为了功能数量倒退。
