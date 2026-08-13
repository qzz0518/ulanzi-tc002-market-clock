# VIBE:AI 编码代理用量频道与控制台标签页设计

- 状态:定稿,待实施
- 日期:2026-08-14
- 设计:Claude Fable(基于四线调研:OpenUsage 语义 / web 视图接入 / 服务端内容管线 / 旋钮与 App 映射)
- 实施:Opus 5 双代理(S=服务端,W=web),分工见 §9

## 1. 定位与数据源决策

把 Claude Code、Codex 等 AI 编码代理的额度用量搬上 52×16 LED:一页「双格总览」(两个代理并排,
对齐 OpenUsage 菜单栏 strip),外加每个代理一页详情;旋钮翻页。控制台新增顶级视图 **VIBE**,
设置交互对齐 OpenUsage 的 Customize(Provider 列表 + 星标)。

**数据源:OpenUsage 本地只读 API(`http://127.0.0.1:6736`),不移植 10 个 Swift Provider。**
理由(→ ADR 0010):

- OpenUsage 明确把该 API 定位为本地集成入口(`docs/local-http-api.md`),`/v1/limits` 是稳定契约
  (`schema: openusage.limits.v1`),数值与用户菜单栏所见**永远一致**;
- 直接移植要复刻 Keychain 读取、OAuth token 刷新、10 家私有接口——上游一变就烂,OpenUsage 升级
  即我们的维护;
- launchd 的 LAN 限制不影响 loopback(实测本机拿到 claude/codex/grok 真数据);
- 「抄 OpenUsage」落在语义层:Provider 目录、指标键/标签、默认星标、缺数据即隐藏、staleness
  规则、图标、菜单栏排版比例、设置交互,全部对齐。

前置条件:OpenUsage 在本机运行(菜单栏常驻应用)。不可达时**宁缺毋假**:LED 渲染 OFFLINE 提示帧
(weather「未配置」模式),GUI 显示安装引导。

商标注:provider 图标是第三方品牌标识,指称性使用(与 OpenUsage 同等暴露);不使用 OpenUsage
自身的名称/徽标做品牌(TRADEMARK.md 限制),GUI 仅以文字注明数据源。

## 2. 数据层(Agent S)

### 2.1 静态目录 `src/vibe/vibe-catalog.ts`

10 个 Provider,顺序与 OpenUsage ProviderCatalog 一致(前三固定,其余按显示名字母序):

| id | displayName | percent 指标(limits key → UI 标签) | 默认星标(≤2) |
|---|---|---|---|
| claude | Claude | session→Session, weekly→Weekly, sonnet→Sonnet, fable→Fable;另 extraUsage→Extra Usage(usd) | session, weekly |
| codex | Codex | session→Session, weekly→Weekly, spark→Spark, sparkWeekly→Spark Weekly;另 credits/creditValue→Credits(balance), rateLimitResets→Rate Limit Resets(balance) | session, weekly |
| cursor | Cursor | totalUsage→Total Usage, autoUsage→Auto Usage, apiUsage→API Usage;另 onDemand→Extra Usage(usd), requests→Requests(count), credits→Credits(balance) | autoUsage, apiUsage |
| antigravity | Antigravity | geminiSession→Session, geminiWeekly→Weekly, nonGeminiSession→Claude, nonGeminiWeekly→Claude Weekly | geminiSession, geminiWeekly |
| copilot | Copilot | premiumCredits→Credits;另 extraUsage(count), orgCredits, orgSpend, chat, completions | premiumCredits |
| devin | Devin | daily→Daily, weekly→Weekly;另 extraUsageBalance→Extra Balance(balance) | daily, weekly |
| grok | Grok | weekly→Weekly | weekly |
| opencode | OpenCode | session→Session, weekly→Weekly, monthly→Monthly | session, weekly |
| openrouter | OpenRouter | credits→Credits(usd);另 balance(balance), keyLimit(usd) | credits |
| zai | Z.ai | session→Session, weekly→Weekly;另 webSearches(count) | session, weekly |

默认星标即 OpenUsage `DefaultLayout.pinnedMetricIDs`(菜单栏默认);grok/devin/opencode 不在其默认
表中,按同精神取各自的主 percent 指标。目录还带单字符 LED 标签映射(详情页行首):

```
session/geminiSession→"S"  weekly/geminiWeekly→"W"  monthly→"M"  daily→"D"
sonnet→"N"  fable→"F"  spark→"K"  sparkWeekly→"X"  totalUsage→"T"  autoUsage→"A"
apiUsage→"P"  premiumCredits/credits→"C"  nonGeminiSession→"C"  nonGeminiWeekly→"L"
extraUsage/extraUsageBalance/onDemand→"E"  balance→"B"  keyLimit→"K"  requests→"R"
rateLimitResets→"R"  creditValue→"V"  webSearches→"Q"  orgCredits→"O"  orgSpend→"G"
chat→"H"  completions→"I"
```

### 2.2 `src/vibe/openusage-client.ts`

```ts
export interface VibeMetric {
  key: string;                       // limits resource key
  label: string;                     // OpenUsage UI 标签(目录映射,未知 key 用原 key)
  kind: "consumption" | "balance";
  unit: string;                      // "percent" | "usd" | "credits" | "requests" | ...
  used?: number; limit?: number; remaining?: number; utilization?: number;  // consumption
  available?: number;                // balance
  resetsAt?: string; windowSeconds?: number;
}
export interface VibeProviderUsage {
  id: string; displayName: string; plan?: string;
  fetchedAt: string; stale: boolean;
  metrics: VibeMetric[];             // 按目录 percent 序,目录外 key 排后
  spendLines: { label: string; value: string }[];  // /v1/usage 的 text 行(Today/Yesterday/Last 30 Days 等)
}
export interface VibeUsageSnapshot {
  fetchedAt: string;                 // 本服务抓取时刻
  generatedAt: string;               // 上游 generatedAt
  providers: VibeProviderUsage[];    // 目录序;上游没给的 provider 不出现(缺数据即隐藏)
  errors: { providerId: string; message: string }[];
}
export class VibeUnavailableError extends Error {}

export interface VibeUsageClientOptions {
  baseUrl?: string;                  // 默认 http://127.0.0.1:6736
  timeoutMs?: number;                // 默认 3000(AbortController)
  fetcher?: FetchLike;               // 测试缝,同 price.ts
  now?: () => number;
}
export class VibeUsageClient { fetchSnapshot(): Promise<VibeUsageSnapshot>; }
```

- 并发 GET `/v1/limits` + `/v1/usage`;limits 是主契约(providers/resources/plan/fetchedAt/stale/
  errors),usage 仅取 `lines[].type === "text"` 做 spendLines(label/value 原样透传)。usage 失败不
  致命(spendLines 为空);limits 失败/连接拒绝 → 抛 `VibeUnavailableError`。
- 逐字段收窄校验(`asRecord` 风格,quotes.ts 范式):数值非有限数即丢弃该字段;percent 的 used
  clamp 到 0–100;结构不对的 provider 条目整个跳过并计入 errors。**绝不编数**。

### 2.3 控制器缓存(改 `src/workspace-controller.ts` + `src/content-registry.ts`)

- `ContentRenderContext` 增加 `getVibeUsage(forceRefresh: boolean): Promise<VibeUsageView>`,其中
  `VibeUsageView = { snapshot: VibeUsageSnapshot; starred: Record<string, string[]> }`(starred 已
  与目录默认合并,渲染器不再碰 store)。
- `WorkspaceControllerOptions` 增加 `vibeClient?: VibeUsageClient` 与 `vibeStarred?: () => Record<string, string[]>`。
- 控制器新增 `vibeCache?: VibeUsageSnapshot` + `getVibeUsage(forceRefresh)`,语义照抄 `getMarket`
  (447-463):有缓存且非 forceRefresh 直接回;抓取失败时缓存未过期则降级返回,过期则抛。
  **staleMs 用常量 `VIBE_STALE_MS = 15 * 60_000`**(OpenUsage 固定 5 分钟刷新,×3 容忍;不复用
  `sourceStaleMs`,其 120s 默认对 5 分钟节奏的源必然误伤)。无 vibeClient → 抛 `VibeUnavailableError`。
- 快照数值**不进** `renderInputsKey`/`channelContentRevision`(既有约束,易变数据不入 key)。

### 2.4 `src/vibe/vibe-store.ts`(`.runtime/vibe.json`)

LyricThemeStore 范式全套:randomUUID 临时文件 + rename、写操作链式排队、signature 去重、坏文件
容忍、`settled()` 测试缝;非机密,**不用 0600**。形状:

```json
{ "version": 1, "starred": { "claude": ["session", "weekly"], "grok": ["weekly"] } }
```

`setStarred(providerId, keys)`:校验 provider 在目录、keys ≤2 且去重;键不做白名单硬校验(上游
可能新增 resource),但长度 ≤32、`[A-Za-z]` 开头。`getStarred()` 返回与目录默认合并后的完整表。

### 2.5 配置(改 `src/config.ts`)

`OPENUSAGE_URL`,默认 `http://127.0.0.1:6736`,进 `AppConfig`。loopback 走 Bun 原生 fetch,
与 CLOCK_HTTP_PROXY 无关。

## 3. LED 渲染(Agent S,`src/vibe/vibe-render.ts` + content-registry 注册两个定义)

图标数据已生成:`src/vibe/vibe-icons.ts`(10px/12px,"."/"*"/"x" 行编码;由
`scripts/gen-vibe-icons.ts` 从 `src/assets/vibe-icons/*.svg` 离线生成,已落库)。绘制:"x" 用
指定色全亮,"*" 用 55% 亮度(×140/255)。

**字形补齐**(先做):`src/pixel-font.ts` 3×5 加 `"$"`:`[".##","##.",".#.",".##","##."]`;
`web/src/lib/pixel-font-5x7.ts` 加 `"%"`:`["##..#","##..#","...#.","..#..",".#...","#..##","#..##"]`
(5×7 表是 server/web 共享真源,server 侧 drawPixelText5x7 自动受益)。

通用约定:背景纯黑;单帧,`frameDelaysMs = [item.durationMs]`;数值文本色 = 白
`[255,255,255]`,`utilization ≥ 0.8` 变琥珀 `[255,204,0]`,`≥ 0.9` 变红 `[255,69,58]`
(OpenUsage 绝对档位 80%/90%,live-pace 预测 v1 不做);快照龄 > 10 分钟(OpenUsage "Outdated"
阈值)在 (51,0) 画 1 颗琥珀像素。

### 3.1 `tools:vibe-duo` —— 双格总览(对齐菜单栏 Text 风格)

- 选项:`agentA` select(10 provider,默认 `claude`)、`agentB` select(10 + `none`,默认
  `codex`)。标题「AI 用量总览」,描述「两个 AI 编码代理的额度并排显示,数据来自本机 OpenUsage。」
  category `tools`,defaultDurationMs 15_000,preferredRefreshIntervalMs 60_000。
- 每格 = 10px 图标 + 2px 间隙 + 数值列(取该 provider 星标指标,≤2):
  - **2 个指标**:3×5 字体两行右对齐(OpenUsage 两行 trailing 堆叠),行 y=2..6 与 y=9..13;
    图标 y=3..12。
  - **1 个指标**:5×7 字体单行,y=4..10;图标同上。
- 数值格式:percent → `"93%"`;usd → `"$"+四舍五入整数`(紧凑,如 `$33`);count → 整数;
  balance 同理取 `available`。指标无数据(字段缺失)→ 跳过该指标;该格星标全无数据 → **整格
  消失(含图标)**,另一格独占居中——OpenUsage strip 语义,绝不画 "—"。
- 排版:`total = wA + gap + wB`,gap 初始 5;水平居中 `x0 = floor((52-total)/2)`。溢出时依次:
  gap 降为 3 → 4 字符 percent 去掉 `%`(`100%`→`100`)→ 仍溢出则从右格起砍第二行指标。确定性
  顺序,测试覆盖双格双指标全 `100%` 的最坏情形。
- 双格全无数据 → openusage 10px 图标 + 右侧 3×5 `"NO DATA"`(灰 `[150,150,150]`)。
- `getVibeUsage` 抛 `VibeUnavailableError` → 提示帧:3×5 居中两行 `"OPENUSAGE"`(y=2,灰)/
  `"OFFLINE"`(y=9,琥珀);其他错误照常 throw(频道错误路径)。
- label:`"VIBE · Claude + Codex"`(displayName 拼接;单格时不带加号)。

### 3.2 `tools:vibe-agent` —— 单代理详情

- 选项:`agent` select(10,默认 `claude`)、`metricA`/`metricB` select(`auto` + 目录 percent
  键并集去重,默认 `auto`)。标题「AI 用量详情」,描述「单个 AI 编码代理的额度与重置进度,数据
  来自本机 OpenUsage。」其余同上。
- `auto` 解析为该 provider 星标第 1/2 项;显式 key 在该 provider 无数据时回落 `auto` 序列的下一
  个可用项。
- 布局:12px 图标 x=0..11、y=2..13;行区 x=15..51(37px):
  - 行 1 y=2..6,行 2 y=9..13;只有一行数据时单行居中 y=5..9。
  - **consumption 行**:单字符标签(§2.1 映射,3×5,soft 灰 `[130,140,155]`)x=15;进度条
    x=19..32(14px 宽 ×5px 高):轨道 `[40,44,52]`,填充 `round(utilization×14)`,色 = 正常蓝
    `[10,132,255]` / ≥0.8 琥珀 / ≥0.9 红(OpenUsage meter 三色);数值右对齐至 x=51,3×5。
  - **balance / usd 行**:无进度条,标签 + 右对齐数值(带 `$`,两位小数如 `$32.84`;credits/
    count 取整)。
- provider 无任何可用指标 → 12px 图标 + `"NO DATA"`;离线帧同 3.1。
- label:`"VIBE · Claude"`。

### 3.3 注册与既有约束

- 追加进 `CONTENT_DEFINITIONS`;`test/content-registry.test.ts` 的 `toHaveLength(34)` → **36**,
  两处 fixture context 补 `getVibeUsage` 桩。
- 渲染器纯函数,不碰设备不开循环;`availableInMarket: true`(也可从内容集市手动添加,选项均为
  标准 select,GUI 选项编辑器零改动)。
- `scripts/preview.ts` 注入真实 `VibeUsageClient`(一行;OpenUsage 不在跑时自然渲染 OFFLINE 帧,
  preview 仍零失败)。

## 4. 频道映射与旋钮(既有机制,零新协议)

- appName 约定:双格总览 → `vibe`;详情 → `vibe_claude`、`vibe_codex`…(`vibe_` **不加**
  RESERVED——这些是常规 workspace 频道,旋钮才认识)。频道 `refreshIntervalMs: 60_000`。
- 官方固件:每频道即一个 Custom App,旋钮直接翻;ZOS:自动进「轮播」环。均为既有行为。
- 「布置频道」在 **web 端**做 read-modify-write(与控制台一致):GET `/api/workspace` → 按
  appName upsert `vibe` + 每个勾选 provider 的 `vibe_<id>`(保序:已存在的原位更新,新增追加
  尾部;不动用户频道)→ PUT `/api/workspace`。超 24 频道上限:toast 报错并列出放不下的项。
  「移除」= 过滤掉 `vibe`/`vibe_<目录id>` 频道后 PUT(至少保 1 频道的校验由服务端兜底,web 端
  在只剩 vibe 频道时禁用移除并提示)。**不新增服务端布置路由**(勿增实体)。

## 5. HTTP API(Agent S,`src/control-api.ts` + `src/service.ts` 接线)

```
GET /api/vibe/status[?refresh=1]        # 免同源(只读)
→ 200 {
    catalog: [{ id, displayName, order, percentKeys: [...], defaultStarred: [...],
                metricLabels: { key: label } }],
    starred: { providerId: [keys] },              # 与默认合并后的完整表
    baseUrl: "http://127.0.0.1:6736",
    snapshot: VibeUsageSnapshot | null,           # 不可达时 null
    error: string | null                          # 不可达原因
  }
```

`refresh=1` → `controller.getVibeUsage(true)`;默认走缓存(无缓存则抓一次)。快照不可达不算
HTTP 错误(200 + `snapshot: null`),GUI 据此渲染安装引导。

```
PUT /api/vibe/starred                    # assertSameOrigin + readJson
body { providerId: "claude", starred: ["session","weekly"] }
→ 200 { starred: {...完整表} }            # 校验失败 SettingsValidationError → 400
```

接线(service.ts):`VibeUsageClient` 在数据客户端区构造(baseUrl 取 config);`VibeStore` 在
handler 构造前 load;controller options 传 `vibeClient` + `vibeStarred: () => store.getStarred()`;
`createControlHandler` options 增 `vibe: { status(refresh), setStarred(providerId, keys) }`。

## 6. 控制台 VIBE 标签页(Agent W)

视图接入(r2 调研 12 步清单,逐条执行):

1. `web/src/types.ts:305` `StudioView` 加 `"vibe"`。
2. `studio-header.tsx` 主导航加 `<Tab value="vibe" disabled={firmwareLocked}><Gauge />VIBE</Tab>`
   (lucide `Gauge`;放在「游戏」与「系统」之间)。
3. `changeView` 允许清单不改(vibe 编辑 workspace,侧载固件在线时与 console 一样锁)。
4. `pageCopy` 分支:kicker `"TC002 VIBE USAGE"`,title 「VIBE 用量」,description
   「把 Claude Code、Codex 等 AI 编码代理的额度搬上像素屏,数据来自本机 OpenUsage。」
5. `pageClassName` 加 `is-vibe-page`;6. `layoutClassName` 加 `is-vibe`。
7. 侧边栏条件加 `&& view !== "vibe"`(全宽视图,同 music/game/zos)。
8. 视图三元链加 `: view === "vibe" ? (<VibePanel />)`(零 props,自管数据,ZosPanel 先例)。
9. 新组件目录 `web/src/components/vibe/`。
10. `globals.css`:`.studio-layout.is-vibe { display:block; min-height:0; overflow-y:auto }`;
    ≤52rem block 列表加 `is-vibe`(1212 行);**两处 `repeat(6, minmax(0,1fr))` → 7**
    (1187 与 1445);移动端无横屏门(如 zos 直接纵向 reflow)。
11. `bun run build` + `bun run typecheck`。
12. `test/mini-player.test.ts:72` views 数组补 `"vibe"`。

### 6.1 `vibe-panel.tsx` 结构(zos-panel 骨架 + firmware-panel 分区惯例)

`<main className="vibe-shell">` → `Surface variant="solid" outline` 单面板,四区:

1. **状态条**:`Chip` 数据源状态(在线 brand 色 / 离线 red)+ 上游 `generatedAt` 相对时间 +
   「刷新」`Button`(`GET /api/vibe/status?refresh=1`)。离线时显示安装引导块:说明 + 外链
   `https://github.com/robinebers/openusage`(`target="_blank" rel="noreferrer"`)。
2. **Provider 列表**(对齐 OpenUsage Customize):目录序,每行 = SVG 图标(`VIBE_ICON_SVG`,
   `dangerouslySetInnerHTML`,渲染前把 `fill` 属性统一改 `currentColor`,20px,`text-cladd-fg`)
   + displayName + plan 副文本 + 「N 项指标」;快照里没有的 provider 灰显(`text-cladd-fg-softest`,
   副文本「无数据」)。行展开(有数据者):逐指标行 = 星标按钮(★,≤2/provider,超限
   `toast.error("每个 Agent 最多 2 个星标")`)+ 标签 + 进度 meter(severity 三色,CSS 即可,
   不必 cladd Progress)+ 数值/重置相对时间;末尾 spendLines 文本行(`Today: $127.42 · 141.8M
   tokens` 原样)。星标变更 → `PUT /api/vibe/starred` → 乐观更新 + 失败回滚 toast。快照龄
   >10 分钟:行区顶部「数据已过时(N 分钟前)」琥珀提示(OpenUsage "Outdated" 对齐)。
3. **LED 预览**:复用 `.device-stage`/`.clock-device`/`.clock-screen` 结构 + `POST
   /api/channels/preview`(合成 ChannelConfig,`forceRefresh: false`,10s AbortController,
   `createLatestTaskRunner` 防竞态——均为 app.tsx 既有模式)。上方 `agentA`/`agentB` 两个 cladd
   select(duo 预览),另一组「详情预览」provider select;选择变化 320ms 防抖重渲。此处选择仅
   影响预览与布置默认值,不落盘。
4. **频道布置**:读当前 workspace(`GET /api/workspace`),列出现存 vibe 频道 chips;provider
   勾选组(`Checkbox`,默认 = 快照里有数据的 provider);「布置到时钟」/「移除 VIBE 频道」
   Buttons 按 §4 read-modify-write + `toast`;成功后提示「旋钮即可翻页」。

纯逻辑入 `web/src/lib/vibe.ts`(DOM-free,可测):status 响应类型镜像(注释注明 mirrors
src/vibe/openusage-client.ts)、severity 计算、数值/相对时间格式化、`buildVibeChannels(workspace,
plan): { next, warnings }`、`stripVibeChannels(workspace)`。**duo/agent 内容 id 与选项键必须与
服务端注册一致**(`tools:vibe-duo`/`tools:vibe-agent`)。

文案全部简体中文;图标 `aria-hidden`;状态 `role="status"`;错误 `role="alert"`。

## 7. 测试清单

- `test/vibe-client.test.ts`(S):fixture = 真实 limits/usage 载荷(脱敏);解析/合并/目录序;
  percent clamp;坏字段丢弃;usage 失败仍出 snapshot;limits 连接拒绝 → `VibeUnavailableError`;
  超时(fetcher 挂起 + AbortController)。
- `test/vibe-store.test.ts`(S):mkdtemp 范式;默认星标合并;setStarred 校验(>2 拒绝、未知
  provider 拒绝);持久化 roundtrip;坏 JSON 容忍。
- `test/content-registry.test.ts`(S):长度 36;duo/agent 渲染:帧 52×16、delay=durationMs、
  label 文案;OFFLINE 帧(context 桩抛 VibeUnavailableError);无数据格消失(非黑像素区间断言);
  100%+100% 溢出降级不越界(0..51 列外无非黑像素)。
- `test/workspace-controller.test.ts`(S,追加):getVibeUsage 缓存语义——非 force 命中缓存;
  失败且缓存 <15min 降级返回;>15min 抛错。
- `test/vibe-web.test.ts`(W):`buildVibeChannels` 保序 upsert、24 上限 warnings、不动用户频道;
  `stripVibeChannels`;severity/格式化边界(79.9/80/90)。
- `test/mini-player.test.ts`(W):views 数组补 vibe。

## 8. 文档(实施后,双语成对)

- `docs/reference.md`/`.en.md`:环境变量表 `OPENUSAGE_URL`;API 表 `/api/vibe/status`、
  `/api/vibe/starred`;内容类型清单 +2。
- `README.md`/`README.en.md`:功能列表加 VIBE 一节(截图后补)。
- `docs/adr/0010-vibe-openusage-source.md`:数据源决策(§1 浓缩)。

## 9. 实施分工(Opus 5 双代理,文件互斥)

- **Agent S(服务端)**:`src/vibe/{vibe-catalog,openusage-client,vibe-store,vibe-render}.ts`
  (新);`src/pixel-font.ts`(加 `$`)、`web/src/lib/pixel-font-5x7.ts`(加 `%`,唯一 web 触碰,
  属共享字模真源)、`src/content-registry.ts`、`src/workspace-controller.ts`、`src/control-api.ts`、
  `src/service.ts`、`src/config.ts`、`scripts/preview.ts`;测试见 §7 S 项。
- **Agent W(web)**:`web/src/types.ts`、`web/src/app.tsx`、
  `web/src/components/studio/studio-header.tsx`、`web/src/components/vibe/*`(新)、
  `web/src/lib/vibe.ts`(新)、`web/src/styles/globals.css`;测试见 §7 W 项。
  已有产物直接用:`web/src/lib/vibe-icon-svg.ts`(生成,勿改)。
- 双方共同契约 = 本文档 §5 响应形状与 §3 选项键;W 不 fetch 服务端代码,按契约写镜像类型。
- 集成、`bun run build`、真机/预览验收、文档:主会话完成。

## 10. 验收清单

1. `bun run typecheck` && `bun test` && `bun run build` 全绿。
2. OpenUsage 在跑:`curl /api/vibe/status` 出三 provider 真数据;`bun run preview` 渲出 vibe
   频道 GIF(真实百分比)。
3. 控制台 VIBE 页:列表/星标/预览/布置全链路可用;移动端底部导航 7 列不挤。
4. 布置后旋钮翻页:`vibe` 双格 + 各代理详情页(官方固件按 App 切换,ZOS 进轮播环)。
5. 杀掉 OpenUsage:LED 出 OFFLINE 帧,GUI 出安装引导,服务无异常日志刷屏。
