# Pixel Playground v2:一步到位总体设计(除固件全量)

- 状态:v2 定稿,实施中
- 日期:2026-08-10(v1 同日;v2 修订:不分期一步到位、live 推送修正、固件项全部移除)
- 设计:Claude Fable;实施:多 agent(按难度 fable / opus);审核:Claude Fable

## 0. v2 修订背景

v1 的 P1 已交付:CJK 服务端字模、`/api/notify`、离线真频谱(**保留,不动**)、live 通道与打砖块。
真机验收发现打砖块**设备端卡顿且像素错乱**。定量归因(2026-08-10 真机实验):

| 模式 | 5 秒实际帧数 | 超预算率 | 结论 |
| --- | --- | --- | --- |
| 单帧流 30ms(v1 游戏方式) | 29 帧 | 29/29 | 链路单次 ~170ms → 设备 ~6fps,帧亮 30ms 停 140ms |
| 单帧流 100ms | 36 帧 | 20/36 | 仍跟不上 |
| 批 4 帧×30ms / 120ms | 132 帧 | 14/42 | 120ms < 链路耗时,偶发脱节 |
| **批 5 帧×40ms / 200ms** | **125 帧** | **1/25** | **25fps 连续动画,批间无缝** |

链路 170ms 的大头是服务端每次设备写 `Bun.spawn` 一个 curl 子进程(裸 fetch 直连仅 16ms)。
两个正交修复:**传输换 fetch** + **推送改录制回放批帧**。固件相关工作(v1 的 P5)全部移除。

## 1. 范围(本轮一次交付)

- **live v2**:传输修复 + 批帧协议(§2)
- **游戏厅**:统一 GameShell 框架 + UI 重设计(§3);打砖块重做、Flappy、贪吃蛇、双人 Pong(§4);排行榜(§5);WS 手柄(§6)
- **涂鸦墙**:多端协作画板直播上屏(§7)
- **视频转像素导入**(§8)
- **注册表六件**:生命游戏、烟花、天气粒子、番茄钟、日出日落色温钟、倒数日(§9)
- 已交付且保留:CJK、notify、真频谱、`/api/live/frames` 端点本体
- 明确不做:固件内任何改动;AI 每日像素画(依赖付费生成 API,违背项目免 key 哲学)

## 2. live v2:传输与批帧

### 2.1 传输修复(服务端)

`service.ts` 的 `live.push/clear`(以及 notify 的推送)改走 **Bun 原生 fetch**:
`pushClockPayloadNamed(config, app, payload, fetch)` —— `clock-client.ts` 本就支持 fetcher 注入,
传 `fetch` 即可绕过 curl 子进程。频道推送(WorkspaceController)**保持 curl 不动**(它不追延迟,
且承担 `CLOCK_HTTP_PROXY` 场景)。文档标注:live/notify 通道不经过 `CLOCK_HTTP_PROXY`。
目标:live 单批链路 <50ms。

### 2.2 批帧协议(前端,录制回放)

游戏在浏览器本地以 rAF 全速运行(预览零延迟)。上屏采用**录制回放**,不做预测:

- GameShell 以 `LIVE_FRAME_MS = 25`(40fps)节奏把当前画面录进环形缓冲;
- 每 `LIVE_BATCH = 4` 帧(100ms)打包一批 `frames:[{delayMs:25,...}×4]` 经 latest-task-runner
  单飞推 `/api/live/frames`;
- 设备显示为恒定 ~150-200ms 延迟的连续动画,批间衔接、无替换撕裂;
- 两常量集中在 `web/src/lib/live-screen.ts`(见 §3),真机可调。

## 3. 游戏厅框架与 UI 规范

### 3.1 GameEngine 接口契约(定死,供并行实施)

新文件 `web/src/lib/games/engine.ts`:

```ts
export interface GameInput {
  pointerX: number | null;      // 0..52 连续坐标(挡板/移动类),null = 无指针
  pressed: boolean;             // 主动作键当前是否按下(跳/发球)
  pressedEdge: boolean;         // 本 tick 内发生过按下沿(消费后由 shell 清零)
  direction: "up" | "down" | "left" | "right" | null;  // 离散方向(snake)
  p2PointerY: number | null;    // 0..16,双人游戏第二玩家(WS 手柄注入)
}

export type GamePhase = "ready" | "playing" | "game-over";

export interface GameHud {
  score: number;
  lives?: number;
  level?: number;
  phase: GamePhase;
  message?: string;             // 状态短句,如 "按空格开始"
}

export interface PixelDrawContext {                  // 52×16,与 CanvasRenderingContext2D 兼容子集
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

export interface GameEngine {
  readonly meta: {
    id: string;                 // "breakout" | "flappy" | "snake" | "pong"
    title: string;              // 中文名
    hint: string;               // 操作提示一句话
    twoPlayers?: boolean;
  };
  tick(dtMs: number, input: GameInput): void;   // 内部固定步长累积,dt 需 clamp ≤250ms
  render(ctx: PixelDrawContext): void;          // 纯画当前状态,含 ready/game-over 画面
  hud(): GameHud;
  restart(): void;
}
```

约束:引擎零 DOM、可 `bun test` 直测;`ready` 阶段渲染吸引画面(attract),`pressedEdge` 开始;
`game-over` 由引擎渲染结算画面(GameShell 不再另画,v1 的 renderGameOver 移入打砖块引擎)。

### 3.2 GameShell(`web/src/components/game/game-shell.tsx`)

职责:游戏选择、rAF 主循环、输入采集(Pointer/键盘/WS 手柄)、上屏录制批推(§2.2,封装为
`web/src/lib/live-screen.ts` 的 `createLiveScreen(app: string)`,涂鸦墙复用)、HUD 桥接、
排行榜(§5)、清屏语义(暂停/切页/game-over 结算后 DELETE,沿用 v1 的 generation 竞态补偿,
该逻辑抽进 live-screen.ts)。

### 3.3 UI 规范(重做 v1 界面)

v1 问题:布局松散、控件与内容层级不清。v2 采用三段式舞台布局(与音乐页同族):

- **顶栏**:左 = 游戏切换(cladd `ToggleGroup`/Segmented,四游戏图标+名);右 = 「上屏」`Switch`
  与连接状态 `Chip`。
- **舞台**:LED 屏居中,52:16 比例撑满可用宽(桌面 max-width ≈ 720px),沿用
  `.pixel-lyric-screen` 的 LED 网格质感;屏下一条像素风 HUD(分数/生命/关卡/最高分,等宽数字)。
- **控制台**:`Surface` 内一行——开始/暂停、重开、难度(游戏自定义 options 区)、双人游戏的
  「邀请手柄」按钮(弹出二维码 Dialog,§6)。
- **排行榜**:桌面右侧 `Surface` 列表(List);≤52rem 折叠为舞台下方可展开区。
- 尺寸一律 cladd token(默认 md),**禁止 min-height 硬撑**;手机横屏:舞台优先撑满,控制台
  收成浮动条;竖屏保留 v1 横屏 gate。cladd 组件文档可经 MCP 或
  `curl http://127.0.0.1:*/`(cladd MCP HTTP JSON-RPC)查询。

## 4. 四个游戏

| 游戏 | 输入 | 要点 | 难度/归属 |
| --- | --- | --- | --- |
| **打砖块**(重做) | pointerX + ←→ | 沿用 v1 引擎物理(已验证),接入 GameEngine 契约;ready/结算画面入引擎;时间数字砖保留 | fable |
| **Flappy** | pressedEdge 跳 | 小鸟 x 固定 ≈12,重力 42px/s²,跳冲量 -18px/s;管道宽 3、间隙 7→5(随分),间距 18px,速度 14px/s 起每 5 分 +6%;碰撞即结算 | opus |
| **贪吃蛇** | direction(键盘/滑动) | 12 格/s 起步逐级加速;食物闪烁 1px;蛇身渐变色;撞墙/自身结算;彩蛋:食物偶尔为 3×5 数字形状加分 | opus |
| **双人 Pong** | 左板 pointerX 映射 y;右板 p2PointerY(WS 手柄)或 AI | 板高 4,球速 20px/s 起每回合 +5%;9 分制;无手柄接入时右板 AI(限速追踪);中线虚线、比分 3×5 数字 | 引擎 opus,WS 集成 fable |

## 5. 排行榜

- 存储 `.runtime/game-scores.json`:`{ [gameId]: [{name, score, at}] }`,每游戏保留 top 20,
  原子写(temp+rename,与 workspace 同模式)。
- API(`control-api.ts`):`GET /api/game/scores?game=<id>`;
  `POST /api/game/scores` body `{game, name, score}` —— name 1..12 字符(CJK 计 1)、score 为
  非负安全整数、game ∈ 四游戏;同源;沿用令牌桶思路限流(10s/6)。
- UI:game-over 时若进榜,弹名字输入(localStorage 记住上次名字);榜单显示名次/名字/分数。

## 6. WS 手柄(双人 Pong)

- `service.ts` 的 `Bun.serve` 加 `websocket` handler;升级路径
  `GET /api/game/socket?room=<4位码>&role=host|pad`。
- 服务端纯中继 + 房间管理:host 创建房间(游戏页生成随机 4 位码),≤1 host + ≤2 pad,
  10 分钟无消息回收;消息 JSON:pad→host `{type:"input", y:0..1}`(服务端转发,不解析语义),
  host→pad `{type:"state", phase, score}`(可选回显)。无鉴权(局域网信任边界,与全站一致)。
- `/pad` 手柄页:极简全屏触控条(独立轻页面,与主 App 同 bundle 路由或独立 HTML 由
  control-api 直出),显示房间连接状态;游戏页「邀请手柄」Dialog 展示
  `http://<lan-host>:43820/pad?room=xxxx` 二维码(`qrcode.react` 已有)。

## 7. 涂鸦墙

- 画板增加「直播」开关:开启后画布变化经 `createLiveScreen("draw")` 上屏(单帧批、300ms
  节流即可,静态内容不追帧率)。
- 协作:复用 §6 WS 基建,room 固定 `draw`;访客页 `/draw`——全屏 52×16 触控画布 + 12 色
  调色板 + 橡皮,笔画消息 `{type:"stroke", x, y, color|null}` 广播给所有端;服务端持有权威
  画布(832 项数组,内存 + 30s 防抖落盘 `.runtime/doodle.json`),新连接先收全量快照。
- 主画板(画板页)在直播开启时实时合并访客笔画。

## 8. 视频转像素导入

- 素材库新增「导入视频」:上传(`POST /api/library/video/import`,multipart,≤100MB 专属上限)
  → 服务端临时文件(scratch 目录)→ `ffmpeg` 抽帧(`fps=min(12,源fps)`,`scale=52:16` 提供
  cover/contain 两种适配选项,总帧 ≤360 超出则按时长均匀抽)→ 量化编码 GIF → 存入
  `pixel-asset-store`(与 Ulanzi 社区导入同构,进频道、预览、推送全部复用)。
- `ffmpeg` 探测:启动时 `which ffmpeg`;不存在则该端点 501 + UI 提示安装命令。上传文件用完
  即删;ffmpeg 进程 120s 超时杀。

## 9. 注册表六件(全部 ContentDefinition 增量)

| 内容 | 类别 | options | 要点 |
| --- | --- | --- | --- |
| 生命游戏 | visual | speed;开局 = `digits`(当前时间 HH:MM 注入)/`soup` | 环面边界,120 帧,静死/循环检测则重播种 |
| 烟花 | visual | speed、密度 | 上升尾迹+爆散粒子+重力衰减,随机色相 |
| 天气粒子 | visual | lat/lon(text)、样式自动 | Open-Meteo 免 key;晴=太阳光晕/雨=下落粒子強度随降水/雪=慢速飘落/云=灰度云层;数据走 `ContentRenderContext.getWeather()`(client 照 `DynamicMarketDataClient` 形状,10 分钟最小刷新;**注入行不改 service.ts,由集成者统一接线**) |
| 番茄钟 | tools | 工作/休息分钟、running/startedAtMs(hidden) | 复用 timer 无状态外推范式;相位环 + 剩余分钟大数字;完成帧全屏闪 |
| 日出日落色温钟 | visual | lat/lon | 太阳高度角简化算法(NOAA 近似);背景整屏色温按高度角插值(夜蓝→晨橙→日白→暮红),前景时间数字;10s 刷新 |
| 倒数日 | tools | 目标日期(YYYY-MM-DD text)、标题(CJK) | 标题 12×12 CJK + 天数大字;当天全屏庆祝帧 |

## 10. 实施编排(Workflow,按难度分配)

| 阶段 | 任务 | 模型 | 文件域(防冲突) |
| --- | --- | --- | --- |
| P1 并行 | **A** live v2 传输+live-screen.ts+GameShell+UI 重做+打砖块接入+排行榜全栈 | fable max | service.ts、control-api.ts、web/game/*、app.tsx、globals.css |
| P1 并行 | **B** 三引擎(Flappy/Snake/Pong)+单测 | opus max | web/src/lib/games/*(纯新文件) |
| P1 并行 | **C** 注册表六件+weather client+单测(不碰 service.ts) | opus max | visual-effects.ts、tool-renderers.ts、content-registry.ts、workspace-controller.ts、src/weather/* |
| P2 并行 | **E** WS 基建+双人 Pong 集成+涂鸦墙(依赖 A、B) | fable max | service.ts(websocket)、web pad/draw、canvas-workspace |
| P2 并行 | **D** 视频导入(依赖无,错峰避开 control-api 冲突) | fable | control-api.ts(library 路由)、src/video-import.ts、web library 组件 |
| P3 | 全量集成扫描 verify + 终审 + 真机 | opus max + 主会话 | — |

验收:`mise run test/typecheck/build` 全绿;真机四项(游戏流畅度、双人 Pong 手机手柄、
涂鸦墙多端、视频导入 Bad Apple 试片)由用户肉眼确认。
