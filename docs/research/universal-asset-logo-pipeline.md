# 通用资产搜索与自动像素 Logo 方案

状态：第一阶段已实现，外部来源边界已复核
日期：2026-08-07
范围：股票、数字货币、汇率、金属；Ulanzi TC002 的 52×16 内容频道

## 1. 产品结论

“通用添加”不等于“任何 ticker 都一定有官方品牌 Logo”。可验证的产品承诺是：

> 只要行情源能唯一确认并报价，资产就可以被添加；系统自动选择合规且身份可信的品牌图，未命中时自动生成稳定的程序化像素标识。

Logo 不是添加资产的前置条件。身份由本地 `instrumentRef`、行情 provider、交易对、名称和可用的链/合约信息共同确定；图标只是视觉增强。

本项目不提供用户上传 Logo。原因是上传并不能自动解决版权、商标、错配和 16×16 质量问题，还会引入额外的媒体上传、审核和安全面。当前流程固定为：

```text
搜索资产
  → provider 身份解析
  → 开放许可本地目录匹配
  → 服务端确定性像素化
  → 不可变本地快照
  → 未命中或不确定时程序化 fallback
```

## 2. 外部来源调研

### 2.1 CoinMarketCap：技术链路完整，但不能默认使用其 Logo

CoinMarketCap 目前提供无需 API key 的 [Keyless Public API](https://coinmarketcap.com/api/documentation/pro-api-reference/keyless-public-api)：

- [`/v1/cryptocurrency/map`](https://coinmarketcap.com/api/documentation/pro-api-reference/cryptocurrency#cryptocurrency-id-map) 返回 CMC ID、名称、symbol、slug、链和合约地址。
- [`/v2/cryptocurrency/info`](https://coinmarketcap.com/api/documentation/pro-api-reference/cryptocurrency#metadata) 返回 Logo URL；官方 BTC 示例是 `https://s2.coinmarketcap.com/static/img/coins/64x64/1.png`。

用户给出的 `.../1.gif` 当前可以访问，但官方 Metadata 契约返回 PNG，不能依赖未文档化的扩展名规律。即使使用 API，也必须保存 CMC ID 或合约身份，不能只靠 symbol；BTC、TRUMP 等 symbol 都可能对应多个资产。

访问能力不等于内容授权。CoinMarketCap 的[现行条款](https://coinmarketcap.com/terms/)没有授予第三方产品默认下载、长期存储、修改成像素衍生图并重新分发 Logo 的权利，并对自动提取、存储及第三方 Logo 使用设置限制。因此：

- 默认实现不请求 CMC Logo，也不热链 CMC CDN。
- Keyless API 不进入当前 Logo resolver。
- 将来只有在取得覆盖商业展示、转换、持久化和再分发的独立许可后，才增加 CMC adapter。

### 2.2 Web3Icons：长期主目录候选

[Web3Icons](https://github.com/0xa3k5/web3icons) 采用 [MIT License](https://github.com/0xa3k5/web3icons/blob/main/LICENCE)，持续维护；其 [`tokens.json`](https://github.com/0xa3k5/web3icons/blob/main/packages/common/src/metadata/tokens.json) 当前约 1,844 项，包含：

- id、name、symbol、marketCapRank；
- 按网络组织的合约地址；
- branded、mono、background 等可用变体。

它比 symbol-only 图标包更适合稳定身份匹配，优先级可设计为：

```text
network + contract address > catalog id + name > 唯一 symbol
```

限制是只提供 SVG。当前 Bun bundle 和 Alpine runtime 没有成熟的通用 SVG 栅格化依赖；一次本地全量栅格化 spike 也显示，直接逐模块处理完整目录会显著拖慢构建。因此 Web3Icons 放在下一阶段：固定版本、离线构建、只栅格化经过身份索引筛选的集合，并分别验证 macOS 与 Alpine 产物。

### 2.3 cryptocurrency-icons：当前自动 Logo 种子库

[spothq/cryptocurrency-icons](https://github.com/spothq/cryptocurrency-icons) 采用 [CC0-1.0](https://github.com/spothq/cryptocurrency-icons/blob/master/LICENSE.md)，直接提供透明 32/64/128 PNG 和包含 symbol、name、color 的 [`manifest.json`](https://github.com/spothq/cryptocurrency-icons/blob/master/manifest.json)。固定的 npm `0.18.1` 包含 487 条 metadata 和 483 张 128px 彩色 PNG。

它适合当前 PNG-first 管线，但不是全量目录：

- 数据较旧，没有 TRUMP、RENDER 等新资产；
- 没有链、合约地址或第三方稳定 ID；
- symbol 可能重用；
- CC0 不授予商标权，也不保证第三方权利已经清理。

所以当前代码只在以下条件同时成立时采用品牌图：

1. 资产来自 Coinbase 的加密货币身份记录；
2. Coinbase `assetId` 与交易对 base code 一致；
3. 目录中该 symbol 只有一个名称匹配项；
4. Coinbase 名称与目录名称规范化后完全一致；
5. 对应固定版本 PNG 存在且通过安全解码和质量管线。

任何一步不确定都使用 fallback，不静默猜图。

### 2.4 不作为默认来源的候选

- [Trust Wallet Assets](https://github.com/trustwallet/assets) 覆盖广且有链/合约身份，但 README 对 MIT 的明确描述限定在 scripts/documentation，不能据此推断所有社区 Logo 都获得可再分发授权。
- [Simple Icons](https://github.com/simple-icons/simple-icons) 可用于逐项审核的股票品牌白名单；其[免责声明](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md)明确说明仓库 CC0 不代表每个品牌图都是 CC0，也没有 ticker/ISIN 映射。
- [Logo.dev](https://www.logo.dev/docs/logo-images/introduction) 支持 domain、ticker、ISIN、名称和 crypto，但缓存、自托管、署名、套餐有效期及第三方 IP 受其[平台文档](https://www.logo.dev/docs/platform/self-hosting)和[条款](https://www.logo.dev/legal/terms)约束，不能作为开箱即用的永久本地目录。
- Twelve Data、CoinGecko、Finnhub 等 provider 返回图片 URL，不代表自动授予图片转换、长期缓存和再分发权。行情能力与 Logo 权利必须分开审核。

### 2.5 股票、汇率和金属

没有找到同时支持任意股票身份查询、下载、像素化、长期缓存和再分发的通用免费 Logo 源。股票默认使用 `exchange + ticker` 程序化标识；以后只接入逐项审核白名单或取得相应权利的 provider。

汇率和金属本身没有统一的公司 Logo。SIX 是 ISO 4217 代码的官方维护机构，并提供[权威代码信息](https://www.six-group.com/en/products-services/financial-information/market-reference-data/data-standards.html)：XAU、XAG、XPT、XPD 分别表示黄金、白银、铂和钯。当前继续使用代码、双币种组合和元素符号生成图标，不把国旗或券商图标冒充官方 Logo。

## 3. 当前实现

### 3.1 运行时资产模型

- 静态注册表保留可信的 `market:instrument` renderer。
- Workspace item 只保存稳定的 `instrumentRef`，真实身份、报价路由和 `iconRef` 位于独立 InstrumentStore。
- 同一频道按 `instrumentRef` 去重，不再按通用 `contentId` 阻止多个资产。
- 已有十个内置资产继续兼容；新资产使用动态链路。

### 3.2 搜索和身份

加密货币搜索同时读取 Coinbase Exchange 的公共产品与货币目录：

- 产品目录确定可报价交易对和精度；
- 货币目录补充真实名称、默认网络和可用合约地址；
- 简单 symbol 搜索不再因为 quote code 相同而返回所有 `*/BTC` 交易对；
- 精确 base symbol 优先 USD 交易对，然后才是其他报价币种。

本地记录中的可选 `logoIdentity` 保存：

```ts
interface MarketLogoIdentity {
  provider: "coinbase";
  assetId: string;
  name: string;
  network?: string;
  contractAddress?: string;
}
```

这为下一阶段的 Web3Icons 合约地址匹配保留了稳定插入点。

### 3.3 自动 Logo 管线

注册资产时执行：

```text
BundledCryptoLogoCatalog.resolve(draft)
  → 唯一 symbol + 名称一致性校验
  → 读取固定版本 128px PNG
  → processLogoPng
  → 选择 compact 16×16 变体（主体最大 12×12）
  → MarketIconStore.saveCatalog
```

PNG 安全与稳定性边界：

- 最大 2 MiB、最大边 1024；
- 先验证 PNG signature、IHDR 和 chunk 布局；
- 拒绝 APNG、嵌入 ICC 和无法确定的非 sRGB gamma；
- 透明优先，只在边缘颜色足够一致且 flood-fill 连通时去背景；
- 自动采用最大 12px 主体并居中留出 2px 安全边，与精修内置图标的视觉尺寸一致；
- 最多 12 色，确定性采样和内容 hash；
- 暗色 Logo 在纯黑屏幕上的平均亮度自动提升到安全阈值，同时保留原有色相关系；
- 任意错误立即降级为程序化 fallback，不阻塞资产注册。

IconStore 将像素 blob 与每个 instrument 的 provenance manifest 分开：相同像素可以去重，但不会合并来源记录。`catalog` manifest 保存目录名、固定版本、SPDX license、asset ID/name、source hash、像素 hash、pipeline version 和 derivation key。

### 3.4 离线和打包

- 构建时把 `cryptocurrency-icons@0.18.1` 的 128px 彩色 PNG、manifest 和 LICENSE 复制进 `dist/assets/crypto-icons`。
- 资产注册不从第三方 Logo 网站下载图片。
- 被采用的 16×16 结果保存到 `.runtime/market-icons`，重启和断网后保持不变。
- 服务启动时会把旧的 14px `balanced` 目录图无损迁移为 12px `compact` 新快照；旧文件保留，InstrumentStore 原子切换到新 `iconRef`。
- Docker runtime 只携带构建后的固定目录，不依赖 runtime `node_modules`。

行情帧始终预留 Logo 区域。长小数先省略小于 1 数值的小数点前 `0`，再逐级降低显示精度；极端长度才使用紧凑科学计数法，不再通过隐藏 Logo 为价格让位。

### 3.5 GUI

- 搜索输入使用 Cladd `Input`，搜索图标通过 `icon` 插槽渲染。
- 类型筛选使用 Cladd `Select`，与右侧 Cladd `Button` 共享相同 size、圆角和 surface token。
- 原生 `<input>` 外壳和原生 `<select>` 样式已删除。
- 用户上传入口、上传 API、Logo preview API 和应用 Logo 更新 API 均已删除。

## 4. API 和持久化

当前 API：

```text
GET  /api/market/search?q=...&kind=...
POST /api/market/instruments
GET  /api/market/instruments
GET  /api/market/icons/:iconRef.png
```

服务端只接受短期 `candidateRef`，不接受客户端提交远程 Logo URL。图标端点按 pixel hash 设置 immutable ETag；JSON 写请求继续使用 same-origin 和既有请求体上限。

当前不存在：

```text
POST /api/market/logo-uploads
GET  /api/market/logo-previews/*
PUT  /api/market/instruments/:ref/icon
```

## 5. 来源优先级

当前：

```text
已有审核像素母版
  > 身份匹配成功的固定开放目录 PNG
  > 按资产类别生成的程序化 fallback
```

未来取得许可或完成新目录打包后：

```text
已有审核像素母版
  > network + contract 匹配的 Web3Icons 固定快照
  > id + name 匹配的开放目录
  > 逐项审核的股票白名单 / 已许可 provider
  > 程序化 fallback
```

不允许只按 symbol 在多个候选中任选一个，也不允许上游 Logo 变化后静默覆盖已保存的 `iconRef`。

## 6. 已知限制

- 当前开放 PNG 目录只有 483 张，且年代较旧；长尾或新币会显示程序化标识。
- 名称完全一致是故意保守的 gate，可能产生 false negative，但避免 false positive。
- Coinbase 搜索覆盖不等于全球所有数字货币覆盖。
- 零 key 基线仍不提供任意股票搜索；股票需要未来的 BYOK 行情 adapter，Logo 还要单独取得权利。
- FX 与金属不会显示所谓“官方品牌 Logo”。
- MIT/CC0 解决仓库作品的版权许可边界，不自动授予底层品牌商标权；商业发布前仍需复核。

## 7. 下一阶段计划

### P2：Web3Icons 主目录

1. 固定 Web3Icons 和 metadata 版本，生成可审计的 source manifest。
2. 使用 Coinbase 已保存的 network/contract address 优先匹配，id/name 次之；symbol 仅在全目录唯一时启用。
3. 构建期只栅格化被身份索引选中的 branded SVG，避免逐模块处理完整目录。
4. 验证 SVG 禁脚本、外链、字体和 CSS 网络资源；限制输入尺寸、复杂度和处理时间。
5. 在 Bun 1.3.14 的 macOS ARM 与 Alpine 构建中验证产物、冷启动、内存和像素回归。
6. 目录未命中、歧义或栅格化失败时保持当前 fallback，不增加上传入口。

### P3：股票来源

1. 先完成股票 search/quote BYOK adapter，与 Logo adapter 分离。
2. 为已许可 provider 建 `deny | ephemeral-only | persist` 策略；只有 `persist` 能进入 IconStore。
3. 可选增加逐图核验的 Simple Icons/品牌白名单，保存单项 license、brand guideline 和身份映射。
4. 没有明确授权时继续使用 ticker fallback。

### P4：真实设备质量

1. 建立透明、白底、黑底、细线、渐变、多组件和吉祥物 corpus。
2. 冻结 calibration/holdout，增加 pixel hash、轮廓和 palette 回归。
3. 在真实 TC002 的低/中/高亮度检查黑底对比、细线消失、孤点和 GIF palette 闪烁。
4. 只有实机证据通过后，才提高自动品牌图覆盖承诺。

## 8. 验收门槛

- 搜索输入、类型选择和搜索按钮全部使用同一 Cladd UI 体系。
- 代码和网络 API 中不存在用户上传 Logo 路径。
- BTC/DOGE 等身份与名称一致的目录资产注册为 `iconMode: "catalog"`。
- TRUMP/未知股票/FX/金属等未命中资产自动使用 `iconMode: "fallback"`，仍可预览和推送。
- 同 symbol 的不确定资产不采用品牌图。
- 图标在注册后断网、重启和上游变化时保持相同 RGBA hash。
- 原有 Workspace、静态十项和真实渲染链路无回归。
- 单元测试、TypeScript、Web/service build 和独立端口 GUI 验收通过。

这份结论是工程和产品许可边界，不是法律意见；任何托管或商业发行仍需对实际部署地区、品牌商标和供应商合同做最终复核。
