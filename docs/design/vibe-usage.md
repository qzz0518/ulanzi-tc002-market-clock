# VIBE:AI 编码代理用量频道与控制台标签页设计

- 状态:部分作废。数据层(§1/§2/§5)仍然有效;**§3 的两个内容类型 `tools:vibe-*` 已被删除**——
  VIBE 现在是 ZOS 固件上的独立 App,见 [vibe-firmware-app.md](vibe-firmware-app.md) 与
  [ADR 0011](../adr/0011-vibe-is-a-firmware-app.md)。本文 §3 的排版仍然有效:固件那一页照它画。
- 日期:2026-08-14
- 设计:Claude Fable(基于四线调研:OpenUsage 语义 / web 视图接入 / 服务端内容管线 / 旋钮与 App 映射)
- 实施:Opus 5 双代理(S=服务端,W=web),分工见 §9

## 1. 定位与数据源决策

把 Claude Code、Codex 等 AI 编码代理的额度用量搬上 52×16 LED:一页「双格总览」(两个代理并排,
对齐 OpenUsage 菜单栏 strip),外加每个代理一页详情;旋钮翻页。控制台新增顶级视图 **VIBE**,
设置交互对齐 OpenUsage 的 Customize(Provider 列表 + 星标)。

**数据源:本服务自采,每家一个 TypeScript 适配器。OpenUsage 只是参考实现,运行时不依赖它。**
理由(→ [ADR 0010](../adr/0010-vibe-native-usage-collection.md)):

- 第一版消费 OpenUsage 的本地只读 API(`127.0.0.1:6736`)。它能用、数字也对得上,但让一台像素
  时钟依赖一个第三方 GUI 装着、跑着、登着——而那份数据时钟自己就读得到;
- OpenUsage 拿到这些数字的全部动作都发生在本机:读各家 CLI 早已写好的凭据(钥匙串条目、`~` 下的
  JSON),调各家的用量接口,映射响应。不需要菜单栏应用,只需要知道每家把 token 放在哪、接口返回
  什么——这些从它的 Swift 源码里逐家读得出来(凭据位置与优先级、endpoint、header 集合、字段路径、
  plan 字符串映射、重置时间算法);
- **检测取代配置**:本机没有某家凭据,它就静默不出现,既不是错误也不是设置项。我们探全部四家,
  而不是显示另一个应用启用了哪几家;
- 「抄 OpenUsage」落在语义层:Provider 目录、指标键/标签、默认星标、缺数据即隐藏、staleness
  规则、meter 的 80%/90% 档位、菜单栏排版比例、设置交互,全部对齐。

代价明摆着:四家私有、无文档的接口从此由我们自己维护。适配器逐字段收窄写(缺字段丢弃而非默认),
所以上游改形状时降级成「该家无数据」而不是错数字,炸的范围是一个文件、一行。

前置条件:**没有前置条件**。装了哪家 CLI、登了哪家,就出现哪几家。一家都没登录(或全部拒绝)时
**宁缺毋假**:LED 渲染 `AI USAGE / NO LOGIN` 提示帧(weather「未配置」模式),GUI 显示登录引导。
四家都借各自 CLI 已经留在本机的登录,没有需要用户粘 key 的厂商。

商标注:provider 图标是第三方品牌标识,指称性使用;不使用 OpenUsage 自身的名称/徽标做品牌
(TRADEMARK.md 限制)。

## 2. 数据层(Agent S)

### 2.1 静态目录 `src/vibe/vibe-catalog.ts`

4 个 Provider,顺序与 OpenUsage ProviderCatalog 一致(前两固定,其余按显示名字母序):

| id | displayName | percent 指标(limits key → UI 标签) | 默认星标(≤2) |
|---|---|---|---|
| claude | Claude | session→Session, weekly→Weekly, sonnet→Sonnet, fable→Fable;另 extraUsage→Extra Usage(usd) | session, weekly |
| codex | Codex | session→Session, weekly→Weekly, spark→Spark, sparkWeekly→Spark Weekly;另 credits/creditValue→Credits(balance), rateLimitResets→Rate Limit Resets(balance) | session, weekly |
| grok | Grok | weekly→Weekly | weekly |
| opencode | OpenCode | session→Session, weekly→Weekly, monthly→Monthly | session, weekly |

默认星标即 OpenUsage `DefaultLayout.pinnedMetricIDs`(菜单栏默认);grok/opencode 不在其默认
表中,按同精神取各自的主 percent 指标。目录还带单字符 LED 标签映射(详情页行首):

```
session→"S"  weekly→"W"  monthly→"M"  sonnet→"N"  fable→"F"
spark→"K"  sparkWeekly→"X"  credits→"C"  creditValue→"V"
extraUsage→"E"  rateLimitResets→"R"
```

### 2.2 适配器层 `src/vibe/providers/`

一家一个文件,共用一层薄地板。适配器**不碰设备、不缓存、不排程**——与内容渲染器同一条纪律
(ADR 0001),也正因如此,一家厂商可以用假 fetch + 假钥匙串 + 冻结时钟测,不需要真登录。

```ts
// types.ts —— 契约
export interface VibeAdapterContext {
  now(): number;
  fetch: FetchLike;
  env: Record<string, string | undefined>;
  keychain: KeychainReader;          // read(service, account?) / write(service, value, account?)
  readTextFile(path: string): Promise<string | null>;   // 展开开头的 `~`,缺文件 → null
  writeTextFile(path: string, content: string): Promise<void>;  // 原子 + 0600
  listDirectory(path: string): Promise<string[]>;
  apiKey(providerId: string): string | null;            // 只对 key 制厂商有值
  timeoutMs: number;
}
export interface VibeProviderAdapter {
  id: string; displayName: string;
  detect(context): Promise<boolean>;            // 纯本地探测:本机有没有这家的凭据
  fetchUsage(context): Promise<VibeProviderResult>;  // { plan?, metrics, spendLines?, note? }
}
export interface VibeMetric {
  key: string;                       // 资源键,如 session / weekly / credits
  label: string;                     // 厂商自己的行标签(目录映射,未知 key 用原 key)
  kind: "consumption" | "balance";
  unit: string;                      // "percent" | "usd" | "credits" | "requests" | ...
  used?: number; limit?: number; remaining?: number; utilization?: number;  // consumption(0–1)
  available?: number;                // balance
  resetsAt?: string; windowSeconds?: number;
}
```

四种错误即四种状态,决定上层怎么降级:

| 错误 | 含义 | 上层动作 |
|---|---|---|
| `VibeCredentialsMissingError` | 本机没有这家的凭据 | 该家整条不出现,并清掉它的 last-good |
| `VibeCredentialsExpiredError` | 有凭据但被拒(刷新也没救回来) | 计入 errors,降级用 last-good |
| `VibeRequestError` | 传输失败或非 2xx | 同上 |
| `VibeRateLimitedError` | 429,带可选 `retryAfterMs` | 该家挂起到冷却结束,期间只吃缓存 |

地板三件:

- `parse.ts`——防御式字段读取(`asRecord`/`asNumber`/`pick`/`clampPercent`/`jwtPayload`/
  `consumptionMetric`/`balanceMetric`…)。数值非有限数即丢弃该字段,percent clamp 0–100。**绝不编数**。
- `http.ts`——`request()` 带硬超时(挂住的厂商不许拖住渲染循环);`requireSuccess()` 把 429 翻成
  `VibeRateLimitedError`(读 `Retry-After`)、其余非 2xx 翻成 `VibeRequestError`;
  `withTokenRefresh()` 是 401/403 → **刷新一次** → 再拒即 `VibeCredentialsExpiredError`
  (死循环刷一个失效 refresh token 只会把账号锁掉)。
- `keychain.ts`——`/usr/bin/security` 的包装。不绑 Security framework:spawn 只要几毫秒、不需要
  原生模块,而且**用户早已为自己那支 CLI 授权过这个条目,读它不会再弹一次框**。退出码 44 =
  `errSecItemNotFound`,是「没存」这个状态而不是失败;其余非零(钥匙串锁着、访问被拒)才是真错误。
  非 macOS 上换成 `EmptyKeychain`,那几家自然检测不到。

`providers/<厂商>.ts` ×4 + `providers/index.ts`(注册表,顺序与 `VIBE_CATALOG` 一致)。凭据来源
按厂商各异:`claude` 读钥匙串条目或 `~/.claude/.credentials.json`(`CLAUDE_CONFIG_DIR` 可改),
`codex` 读 `~/.codex/auth.json` / `~/.config/codex/auth.json` 再退钥匙串,`grok` 读
`~/.grok/auth.json`,`opencode` 认 `OPENCODE_DATA_DIR` / `XDG_DATA_HOME` /
`~/.local/share/opencode`。四家都借本机已有的 CLI 登录,没有走 `context.apiKey(id)` 的厂商。

**刷新与写回的边界**:这些厂商每次换取 access token 都会**轮换 refresh token**,旧的立刻作废。
我们刷了却不写回,等于把用户自己那支 CLI 手里的凭据变成废纸——下次他打开 Claude Code 会发现
自己被登出了。所以规则是:**能安全写回才允许刷新**。

- **文件型登录**(`~/.codex/auth.json`、`~/.grok/auth.json`、`.credentials.json`)照常刷新,
  刷完原子写回 0600。写回一律**在原文件上合并**,不按我们的模型重建:真实凭据里有我们不认识的
  键(Claude 的 `mcpOAuth` 存着用户各 MCP 服务器的 token、`refreshTokenExpiresAt` 就挨着我们读的
  那几个字段),重建等于把它们悄悄删掉。读回来解析不了、或条目已不在,则放弃写入而不是覆盖。
- **钥匙串型登录一律不刷新**。`security add-generic-password -w` 的值走 `getpass(3)`,
  **超过 128 字节静默截断且退出码为 0**(实测 336 字节写进去只剩 128,毫无报错)——这会把用户
  真实的 Claude Code 登录换成一段残片;改用命令行参数传 blob 又会让活的 OAuth token 出现在全机
  可见的 `ps` 里。两条路都不值当,于是钥匙串对我们只读:token 有效就用,过期就如实报「登录已过期」,
  用户下次运行 `claude` 自会修好。
- 写失败静默吞掉:本次读取仍然有效,而渲染中途钥匙串锁着这件事用户也做不了什么。

### 2.3 `src/vibe/usage-service.ts`

整个数据层就这一个类:建一次 context,`detect()` 探四家,有凭据的**并发** `fetchUsage()`,折成一份
快照。失败逐家隔离——一家接口挂了只损失它那一页,绝不损失整块屏。

```ts
export interface VibeProviderUsage {
  id: string; displayName: string; plan?: string;
  fetchedAt: string;                 // 这份数字是什么时候从厂商读到的
  stale: boolean;                    // true = 本轮被拒,正在顶 last-good
  note?: string;                     // 非致命提示,如「重新登录以恢复实时额度」
  metrics: VibeMetric[];             // 目录 percent 序在前,目录外 key 排后
  spendLines: VibeSpendLine[];
}
export interface VibeUsageSnapshot {
  fetchedAt: string;
  generatedAt: string;               // 与 fetchedAt 相等:没有上游,就没有第二个时钟
  providers: VibeProviderUsage[];    // 目录序;本机没凭据的厂商不出现
  errors: { providerId: string; message: string }[];
}
export class VibeUnavailableError extends Error {}   // 一家都没登录 → 渲染器画 NO LOGIN 帧
```

- `PROVIDER_STALE_MS = 15 * 60_000`:某家失败时,它上一次的好数据继续顶 15 分钟并置
  `stale: true`;超过就从快照里消失(过了这条线谁也说不清那个数字是什么时候真的),只留 errors。
- `detect()` 返回 false → 该家**静默缺席**,同时删掉它的 last-good:登出之后不许昨天的数字还挂在屏上。
- 429 → `cooldownUntil` 逐家记账(厂商没说就默认 5 分钟),冷却期间只吃缓存。被限流的 Claude 不拖住 Codex。
- `providers.length === 0 && errors.length === 0` → 抛 `VibeUnavailableError`(真的一家都没登录)。
- 默认超时 8s/家,四家并发;`options` 全是测试缝(adapters / fetcher / keychain / env / now /
  apiKey / readTextFile / writeTextFile / listDirectory)。

### 2.4 控制器缓存(改 `src/workspace-controller.ts` + `src/content-registry.ts`)

- `ContentRenderContext` 增加 `getVibeUsage(forceRefresh: boolean): Promise<VibeUsageView>`,其中
  `VibeUsageView = { snapshot: VibeUsageSnapshot; starred: Record<string, string[]> }`(starred 已
  与目录默认合并,渲染器不再碰 store)。
- `WorkspaceControllerOptions` 增加 `vibeClient?: VibeUsageService` 与 `vibeStarred?: () => Record<string, string[]>`。
- 控制器新增 `vibeCache?: VibeUsageSnapshot` + `getVibeUsage(forceRefresh)`,语义照抄 `getMarket`:
  有缓存且**未过龄**且非 forceRefresh 直接回;抓取失败时缓存未过期则降级返回,过期则抛。
  **staleMs 用常量 `VIBE_STALE_MS = 15 * 60_000`**(与适配器层的 last-good 窗口同宽;不复用
  `sourceStaleMs`,其 120s 默认对分钟级节奏的源必然误伤)。命中也要计龄——没有 VIBE 频道在排程时
  谁也不会传 forceRefresh=true,不计龄就会把开机那一份钉死,而 `/api/vibe/status` 还报它是新的。
  无 vibeClient → 抛 `VibeUnavailableError`。
- 快照数值**不进** `renderInputsKey`/`channelContentRevision`(既有约束,易变数据不入 key)。

### 2.5 `src/vibe/vibe-store.ts`(`.runtime/vibe.json`)

LyricThemeStore 范式全套:randomUUID 临时文件 + rename、写操作链式排队、signature 去重、坏文件
容忍、`settled()` 测试缝;非机密,**不用 0600**。形状:

```json
{ "version": 1, "starred": { "claude": ["session", "weekly"], "grok": ["weekly"] } }
```

`setStarred(providerId, keys)`:校验 provider 在目录、keys ≤2 且去重;键不做白名单硬校验(上游
可能新增 resource),但长度 ≤32、`[A-Za-z]` 开头。`getStarred()` 返回与目录默认合并后的完整表。

### 2.6 `src/vibe/vibe-key-store.ts`(`.runtime/vibe-keys.json`)

给「本机没有任何东西替它登录」的厂商用。**现在四家都有 CLI 登录可借,所以 key 制厂商列表是空的**,
`set()` 对任何 id 都拒绝,`status()` 返回空表。留着这条路而不是删掉,是因为 `/api/vibe/key` 与状态
信封里的 `keys` 是控制 API 的既定契约,而且下一家没有本地登录的厂商只需要在列表里加一行。

真的存了 key 时这个文件是**凭据**:与 `vibe.json` 不同,它**写 0600**,而且永不出进程——
`GET /api/vibe/status` 只报「有没有」,不报 key。

```json
{ "version": 1, "keys": {} }
```

- `resolve(providerId)`:先取存的 key,没有再取该厂商自己的环境变量。**存的优先**,
  于是控制台里粘一把新 key 能盖掉服务启动时继承的那份 shell 导出。
- `status()`:每家 `"stored" | "environment" | "unset"`,这是 GUI 唯一能知道的事。
- `set(providerId, key)`:非 key 制厂商拒绝(`SettingsValidationError`),长度 ≤512,空串即清除。
  持久化沿用 LyricThemeStore 范式(randomUUID 临时文件 + rename、链式排队、signature 去重、
  `settled()` 测试缝),外加落盘前后各 chmod 0600;写失败静默——满盘不该让「设置 key」这个请求失败,
  key 仍在内存里生效,下次保存重试。
- 接进 `VibeUsageService` 的 `apiKey` 选项,适配器通过 `context.apiKey(id)` 拿到。

## 3. LED 渲染(Agent S,`src/vibe/vibe-render.ts` + content-registry 注册两个定义)

图标数据在 `src/vibe/vibe-icons.ts`(10px/12px,"."/"*"/"x" 行编码)。绘制:"x" 用指定色全亮,
"*" 用 55% 亮度(×140/255)。**这些 LED 点阵是手绘像素画,不是从 SVG 光栅化来的**:把矢量标识
面积平均到 10–12px 会把它毁掉(OpenAI 的绳结变成实心圆,xAI 的斜杠糊成一片),因为这个尺度
下每一笔只有 1–2px 宽,平均覆盖率过不了任何合理阈值。手绘是拿保真度换「还认得出来」。
`src/assets/vibe-icons/*.svg` 保留矢量原件,控制台**直接渲染真 SVG**
(`scripts/gen-vibe-icons.ts` 只把它们内联进 `web/src/lib/vibe-icon-svg.ts`,不再光栅化)。

**字形补齐**(先做):`src/pixel-font.ts` 3×5 加 `"$"`:`[".##","##.",".#.",".##","##."]`;
`web/src/lib/pixel-font-5x7.ts` 加 `"%"`:`["##..#","##..#","...#.","..#..",".#...","#..##","#..##"]`
(5×7 表是 server/web 共享真源,server 侧 drawPixelText5x7 自动受益)。

通用约定:背景纯黑;单帧,`frameDelaysMs = [item.durationMs]`;数值文本色 = 白
`[255,255,255]`,`utilization ≥ 0.8` 变琥珀 `[255,204,0]`,`≥ 0.9` 变红 `[255,69,58]`
(OpenUsage 绝对档位 80%/90%,live-pace 预测 v1 不做);快照龄 > 10 分钟(OpenUsage "Outdated"
阈值)在 (51,0) 画 1 颗琥珀像素。

### 3.1 `tools:vibe-duo` —— 双格总览(对齐菜单栏 Text 风格)

- 选项:`agentA` select(10 provider,默认 `claude`)、`agentB` select(10 + `none`,默认
  `codex`)。标题「AI 用量总览」,描述「两个 AI 编码代理的额度并排显示,直接读本机各代理自己的
  登录。」category `tools`,defaultDurationMs 15_000,preferredRefreshIntervalMs 60_000。
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
- 双格全无数据 → 中性 `gauge` 10px 图标(非厂商标识)+ 右侧 3×5 `"NO DATA"`(灰 `[150,150,150]`)。
- `getVibeUsage` 抛 `VibeUnavailableError`(一家都没登录)→ 提示帧:3×5 居中两行 `"AI USAGE"`
  (y=2,灰)/ `"NO LOGIN"`(y=9,琥珀);其他错误照常 throw(频道错误路径)。
- label:`"VIBE · Claude + Codex"`(displayName 拼接;单格时不带加号)。

### 3.2 `tools:vibe-agent` —— 单代理详情

- 选项:`agent` select(10,默认 `claude`)、`metricA`/`metricB` select(`auto` + 目录 percent
  键并集去重,默认 `auto`)。标题「AI 用量详情」,描述「单个 AI 编码代理的额度与重置进度,直接读
  本机该代理自己的登录。」其余同上。
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
- `scripts/preview.ts` 注入真实 `VibeUsageService`(一行;本机一家都没登录时自然渲染 NO LOGIN 帧,
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
    keys: { <厂商>: "stored"|"environment"|"unset" },   # 只有状态,绝不含 key;四家都借 CLI 登录,故为空表
    snapshot: VibeUsageSnapshot | null,           # 一家都没登录时 null
    error: string | null                          # 采集失败的原因
  }
```

`refresh=1` → `controller.getVibeUsage(true)`;默认走缓存(无缓存则采一次)。**一家都没登录不算
HTTP 错误**(200 + `snapshot: null` + `error`),GUI 据此渲染登录引导而不是弹错误 toast。
没有 `baseUrl`——没有上游可指。

```
PUT /api/vibe/starred                    # assertSameOrigin + readJson
body { providerId: "claude", starred: ["session","weekly"] }
→ 200 { starred: {...完整表} }            # 校验失败 SettingsValidationError → 400
```

```
PUT /api/vibe/key                        # assertSameOrigin + readJson
body { providerId: "<key 制厂商>", key: "…" }   # key 传空串即清除
→ 200 { keys: {...状态表} }               # 只回状态,绝不回显 key;校验失败 400
                                          # 目前没有 key 制厂商,任何 id 都是 400
```

接线(service.ts):`VibeUsageService` 在数据客户端区构造,`apiKey` 接 `VibeKeyStore.resolve`;
`VibeStore` 与 `VibeKeyStore` 都在 handler 构造前 load;controller options 传 `vibeClient` +
`vibeStarred: () => store.getStarred()`;`createControlHandler` options 增
`vibe: { status(refresh), setStarred(providerId, keys), setKey(providerId, key) }`。

## 6. 控制台 VIBE 标签页(Agent W)

视图接入(r2 调研 12 步清单,逐条执行):

1. `web/src/types.ts:305` `StudioView` 加 `"vibe"`。
2. `studio-header.tsx` 主导航加 `<Tab value="vibe" disabled={firmwareLocked}><Gauge />VIBE</Tab>`
   (lucide `Gauge`;放在「游戏」与「系统」之间)。
3. `changeView` 允许清单不改(vibe 编辑 workspace,侧载固件在线时与 console 一样锁)。
4. `pageCopy` 分支:kicker `"TC002 VIBE USAGE"`,title 「VIBE 用量」,description
   「把 Claude Code、Codex 等 AI 编码代理的额度搬上像素屏,直接读本机各代理自己的登录。」
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

1. **状态条**:`Chip` 报「已登录 N 家」(>0 brand 色 / 0 neutral)+ `fetchedAt` 相对时间 +
   「刷新」`Button`(`GET /api/vibe/status?refresh=1`)。一家都读不到时显示引导块:VIBE 不需要
   额外装什么,登录 Claude Code / Codex CLI / OpenCode / Grok CLI 任一家后回来刷新即可。
   有 `error` 时附一句「本次采集的失败原因:…」。
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
src/vibe/usage-service.ts)、severity 计算、数值/相对时间格式化、`buildVibeChannels(workspace,
plan): { next, warnings }`、`stripVibeChannels(workspace)`。**duo/agent 内容 id 与选项键必须与
服务端注册一致**(`tools:vibe-duo`/`tools:vibe-agent`)。

文案全部简体中文;图标 `aria-hidden`;状态 `role="status"`;错误 `role="alert"`。

## 7. 测试清单

- `test/vibe-<厂商>.test.ts`(S,一家一个):fixture = 该厂商真实响应(脱敏)+ 假 fetch/假钥匙串/
  冻结时钟;detect 的凭据优先级;解析/目录序;percent clamp;坏字段丢弃;401 → 刷新一次 → 写回;
  429 → `VibeRateLimitedError`;无凭据 → `VibeCredentialsMissingError`;超时。
- 服务层语义(`VibeUsageService`)在 `test/workspace-controller.test.ts`、
  `test/content-registry.test.ts`、`test/control-api.test.ts` 里用假适配器覆盖:并发折叠、逐家降级、
  15 分钟 last-good、429 冷却、一家都没登录 → `VibeUnavailableError`。
- `test/vibe-store.test.ts`(S):mkdtemp 范式;默认星标合并;setStarred 校验(>2 拒绝、未知
  provider 拒绝);持久化 roundtrip;坏 JSON 容忍。
- `test/content-registry.test.ts`(S):长度 36;duo/agent 渲染:帧 52×16、delay=durationMs、
  label 文案;NO LOGIN 帧(context 桩抛 VibeUnavailableError);无数据格消失(非黑像素区间断言);
  100%+100% 溢出降级不越界(0..51 列外无非黑像素)。
- `test/workspace-controller.test.ts`(S,追加):getVibeUsage 缓存语义——非 force 命中缓存;
  失败且缓存 <15min 降级返回;>15min 抛错。
- `test/vibe-web.test.ts`(W):`buildVibeChannels` 保序 upsert、24 上限 warnings、不动用户频道;
  `stripVibeChannels`;severity/格式化边界(79.9/80/90)。
- `test/mini-player.test.ts`(W):views 数组补 vibe。

## 8. 文档(实施后,双语成对)

- `docs/reference.md`/`.en.md`:VIBE 一节(凭据来源、四家清单、逐家降级状态);
  API 表 `/api/vibe/status`、`/api/vibe/starred`、`/api/vibe/key`;内容类型清单 +2。
  **环境变量表里不加任何 VIBE 项**——没有可配置的上游。
- `README.md`/`README.en.md`:功能列表加 VIBE 一节(截图后补)。
- `docs/adr/0010-vibe-native-usage-collection.md`:数据源决策(§1 浓缩)。

## 9. 实施分工(Opus 5 双代理,文件互斥)

- **Agent S(服务端)**:`src/vibe/{vibe-catalog,usage-service,vibe-store,vibe-key-store,vibe-render}.ts`
  与 `src/vibe/providers/*`(新);`src/pixel-font.ts`(加 `$`)、`web/src/lib/pixel-font-5x7.ts`
  (加 `%`,唯一 web 触碰,属共享字模真源)、`src/content-registry.ts`、`src/workspace-controller.ts`、
  `src/control-api.ts`、`src/service.ts`、`scripts/preview.ts`;测试见 §7 S 项。
- **Agent W(web)**:`web/src/types.ts`、`web/src/app.tsx`、
  `web/src/components/studio/studio-header.tsx`、`web/src/components/vibe/*`(新)、
  `web/src/lib/vibe.ts`(新)、`web/src/styles/globals.css`;测试见 §7 W 项。
  已有产物直接用:`web/src/lib/vibe-icon-svg.ts`(生成,勿改)。
- 双方共同契约 = 本文档 §5 响应形状与 §3 选项键;W 不 fetch 服务端代码,按契约写镜像类型。
- 集成、`bun run build`、真机/预览验收、文档:主会话完成。

## 10. 验收清单

1. `bun run typecheck` && `bun test` && `bun run build` 全绿。
2. `curl /api/vibe/status` 出本机所有已登录代理的真数据(至多四家);数值与 OpenUsage 菜单栏
   逐项核对一致(仅滚动 5 小时窗因两次调用相差的分钟数不同);`bun run preview` 渲出 vibe 频道
   GIF(真实百分比)。
3. 控制台 VIBE 页:列表/星标/预览/布置全链路可用;移动端底部导航 7 列不挤。
4. 布置后旋钮翻页:`vibe` 双格 + 各代理详情页(官方固件按 App 切换,ZOS 进轮播环)。
5. 退出任一代理的登录:该家从快照消失(15 分钟 last-good 过后),别家照常;全部退出后 LED 出
   `AI USAGE / NO LOGIN` 帧,GUI 出登录引导,服务无异常日志刷屏。
