# Ulanzi 官方像素素材库逆向与本地接入建议

- 调研日期：2026-08-07
- 官方素材分类 ID：`1818114700000000001`
- 调研方式：只读检查官方页面、公开接口、当前前端 Bundle 与公开素材文件；未登录、未上传、未点赞、未收藏，也没有调用会增加下载记录的接口。
- 结论边界：下文记录的是当前线上实现，不是 Ulanzi 承诺长期稳定的公开 API。接口、字段和资源路径随时可能变化。

## 结论

可以在本项目中实现“官方像素素材库”，并且可以做到：

1. 浏览、搜索、分类和分页加载官方公开素材；
2. 粘贴 `contentView` 链接导入；
3. 把静态 PNG 归一化为 TC002 的 `52×16` 像素内容；
4. 把 GIF 解码为多帧内容并保留帧时长；
5. 作为单项加入所选频道，或建立独立 App，再通过本项目已有的频道预览和推送链路发送到时钟。

不能让浏览器前端直接请求官方接口和 ZIP。实测从本项目的 `http://127.0.0.1:43820` 发起请求时，列表、详情和 CDN ZIP 均被 CORS 拦截。接入必须经过本地服务端适配器。

还需要注意：官方详情接口没有可见的许可证字段。公开可下载不等于允许第三方批量镜像或重新分发。建议做“用户按需导入”，保留作者与原始链接，不在本项目内批量打包官方全库。

## 官方页面和公开接口

### 入口

- [官方像素素材库](https://ugc.ulanzistudio.com/home/1818114700000000001)
- [新天鹅堡详情页，ID 1091](https://ugc.ulanzistudio.com/contentView/1091?status=index&cateName=Pixel+Assets&title=Neuschwanstein+Castle)
- [官方 PixelGrid 编辑器](https://ugc.ulanzistudio.com/pixel-art)
- 当前站点前端 Bundle：[index-5oO8ECMp.js](https://ugc.ulanzistudio.com/assets/index-5oO8ECMp.js)

Bundle 文件名带内容哈希，后续发布后可能失效。

### 列表接口

```text
GET https://ugc.ulanzistudio.com/api/api/list
  ?cateId=1818114700000000001
  &excludeCateId=
  &screen=
  &sort=
  &isAsc=asc
  &limit=12
  &orderByColumn=
  &page=1
  &searchText=
  &classify=0
  &lang=zh_CN
  &source=web
```

当前快照返回 `count: 50`。官方页面默认每页 12 项，通过滚动递增 `page`。

列表项的重要字段：

```text
id                 作品 ID
titleCn/titleEn    标题
banner             逗号分隔的预览图片路径
files              作品 ZIP 路径
classify           内容分类代码
author/nickname    作者信息，部分作品为空
createTime         上传时间
hot/star/download  排序指标
```

`banner` 和 `files` 是相对 `https://api.ulanzistudio.com` 的路径，不是相对详情页域名的普通静态文件。

官方界面的排序值是：

| 界面文案 | `sort` 值 |
| --- | --- |
| 热点 / Popular | `hot` |
| 支持数 / Support Count | `star` |
| 最新上传 / Latest Uploads | `new` |

当前 50 项的 `hot/star/download` 基本为 0，因此这几个排序在当前数据上不具备很强的验证意义。Bundle 中还存在回退值 `download`。

### 分类接口

```text
GET https://ugc.ulanzistudio.com/api/api/classifyList
  ?cate=1818114700000000001
  &lang=zh_CN
  &source=web
```

一个容易踩坑的点：列表查询的 `classify` 参数使用分类记录的 `id`，而列表项返回的是该记录的 `classify` 代码，两者不是同一个数字。

| 分类 | 查询参数 `id` | 列表项 `classify` | 当前数量 |
| --- | ---: | ---: | ---: |
| 文字 | 6 | 5 | 0 |
| AI | 8 | 7 | 8 |
| 自然 | 11 | 10 | 12 |
| 娱乐 | 12 | 11 | 1 |
| 图形 | 13 | 12 | 29 |

`classify=0` 表示全部。

### 详情接口

```text
GET https://ugc.ulanzistudio.com/api/api/resources
  ?id=1091
  &lang=zh_CN
  &source=web
```

详情返回 `tResources`。ID `1091` 当前的关键数据为：

```json
{
  "id": "1091",
  "cateId": "1818114700000000001",
  "titleCn": "新天鹅堡",
  "titleEn": "Neuschwanstein Castle",
  "version": "1.0.0",
  "author": "Sakiko",
  "classify": 12,
  "banner": "/cdn/uploadPath/upload/2026/07/31/2c99549e4eead6288e006d91c50d540e.png,/cdn/uploadPath/upload/2026/07/31/671cab16c63988345af20448492c2218.png",
  "files": "/cdn/uploadPath/upload/2026/07/31/6d43f3ca389966f901ae1ef0ba2a4d7b.zip"
}
```

官方详情页 Bundle 还会为资源构造桌面 App Deep Link：

```text
UlanziDeck://run?type=0&downloadID=1091&ver=1.0.0
```

但像素编辑器的“链接导入”不是依赖 Deep Link；它直接从 `contentView` URL 中提取数字 ID，然后调用详情接口并下载 ZIP。

## 官方 ZIP 格式

公开资源 ZIP 内部只有一个 `data.json`，结构为：

```json
{
  "images": [
    {
      "index": 0,
      "base64": "data:image/png;base64,..."
    }
  ]
}
```

动画作品会把 `base64` 的 MIME 换成 `data:image/gif;base64,...`。

### 实测样本

| 作品 | ZIP | `data.json` 中的图片 | 说明 |
| --- | --- | --- | --- |
| 新天鹅堡 `1091` | [6d43…d7b.zip](https://api.ulanzistudio.com/cdn/uploadPath/upload/2026/07/31/6d43f3ca389966f901ae1ef0ba2a4d7b.zip) | PNG，`975×300`，11,205 bytes | 单帧 |
| cc 小螃蟹 `1011` | [ec161…486.zip](https://api.ulanzistudio.com/cdn/uploadPath/upload/pixel-assets-migration/ec161c13f7ac1520bd3c8e74146c8c72a57cdd74fe7637e1e973134e62e8d486.zip) | GIF，`416×128`，39,014 bytes | 8 帧，每帧 140 ms，循环播放 |
| 数码宠物 `1013` | [25b0…4d8.zip](https://api.ulanzistudio.com/cdn/uploadPath/upload/pixel-assets-migration/25b0fdc7c73895ee77891321bfd0baaa5a8fb19274dce4de273a9428c660c4d8.zip) | PNG，`975×300`，10,073 bytes | 单帧 |

这些图像的宽高比都是 `3.25`，正好等于 `52/16`。它们不是直接保存成 `52×16`，而是无平滑放大的展示图。

官方 PixelGrid 的导出代码也证实了这一点：

- 工作画布是 `52×16`；
- 导出比例是 `18.75`；
- 因此素材 PNG 为 `975×300`；
- PNG 被转成 Data URL，放入 `data.json` 后再生成 ZIP；
- 设备展示图为 `1064×420`，其中 `975×300` 内容绘制在设备屏幕区域。

因此导入时应使用最近邻方式还原为 `52×16`，不能把 `975×300` 当成任意照片再走当前的“主体识别”算法。

## 官方链接导入的真实语义

当前官方 PixelGrid 页面已经实现了链接导入，逻辑可以概括为：

1. 对输入执行 `/\/contentView\/(\d+)/`，提取资源 ID；
2. `GET /api/api/resources?id=<ID>`；
3. 验证 `tResources.cateId === "1818114700000000001"`；
4. 读取 `tResources.files`；
5. 下载 ZIP；
6. 用 JSZip 读取 `data.json`；
7. 取 `images[0].base64`；
8. 交给图片裁剪器，再写入 `52×16` 单帧画布。

官方页面明确标记为 `SINGLE FRAME EDITOR`。它只读取 `images[0]`，并通过普通 `Image`/Canvas 裁剪流程处理，因此这条 Web 导入链路不会可靠保留 GIF 动画。我们的实现不必继承这个限制。

### 官方 Web 当前存在的导入 Bug

官方 Bundle 当前把 ZIP 地址拼成：

```text
https://ugc.ulanzistudio.com/api + /cdn/uploadPath/...zip
```

也就是：

```text
https://ugc.ulanzistudio.com/api/cdn/uploadPath/...zip
```

2026-08-07 实测该地址 `fetch` 失败，所以在官方 PixelGrid 中粘贴题述“新天鹅堡”链接会显示 `Failed to import from URL`。

同一个 ZIP 使用下面的真实 CDN 地址可以正常返回 `200 application/zip`：

```text
https://api.ulanzistudio.com/cdn/uploadPath/...zip
```

我们的实现应使用服务端从 `api.ulanzistudio.com` 获取文件，不要照抄官方 Web 当前的错误代理拼接。

## CORS 与为什么必须服务端代理

从官方站点自身页面请求接口和 `api.ulanzistudio.com` CDN 可以成功；但从本项目本地页面 `http://127.0.0.1:43820` 实测下面四类请求全部得到浏览器级 `TypeError: Failed to fetch`：

- `ugc.ulanzistudio.com/api/api/list`
- `ugc.ulanzistudio.com/api/api/resources`
- `api.ulanzistudio.com/cdn/...zip`
- `ugc.ulanzistudio.com/api/cdn/...zip`

即使 `<img>` 能显示某些跨域缩略图，把它绘制到 Canvas 后也可能因跨域成为 tainted canvas，无法读取像素。因此列表、详情、缩略图和导入文件都应通过本地服务端适配器，前端只访问本项目自己的同源 API。

## 与当前项目模型的差异

当前 `creative:canvas` 只保存一组 `52×16 = 832` 个 RGB 整数，属于单帧内容。

当前 `web/src/lib/canvas-pixelize.ts` 的图片导入面向 PixDeck 风格的小图标：

- 会先识别并裁剪“主体”；
- 近白色被视为背景；
- 输出宽度最多 16 像素。

它不适合官方全屏素材：官方素材通常应占满 `52×16`，而且白色像素可能是画面本身。直接复用会造成画面被裁掉、宽度缩水或白色消失。

建议新增独立的 `creative:pixel-asset` 内容类型，不要把动画和来源信息硬塞进现有单帧画板：

```text
creative:canvas       用户绘制或编辑的单帧 52×16 画布
creative:pixel-asset  从素材库导入的单帧/多帧内容
```

静态素材可以额外提供“复制到画板”操作，生成可编辑的 `creative:canvas`；GIF 则默认作为 `creative:pixel-asset` 加入频道，以保留动画。

## 推荐架构

### 本地服务端适配器

建议增加一层专用的 `UlanziPixelAssetClient`，不要让 UI 知道官方字段和 URL 拼接规则。

```text
GET  /api/library/ulanzi/pixel-assets
GET  /api/library/ulanzi/pixel-assets/:id
POST /api/library/ulanzi/pixel-assets/import
```

第一条接收 `page`、`limit`、`search`、`classificationId` 和 `sort`，返回项目自己的稳定 DTO。第二条返回详情与本地可访问的预览地址。第三条接收资源 ID 或官方 `contentView` URL，下载并验证 ZIP，再生成本地内容。

导入完成后，应该把归一化的 `52×16` 媒体保存到本地内容存储中，Workspace 只保存不可变的 `assetRef`、标题、作者、来源 URL 和播放参数。不要每次预览或推送时都重新请求官方 CDN，否则上游不可用时用户已经导入的频道也会失效。

### 统一现有频道链路

素材库不应成为第二条直写设备的路径。推荐流程是：

```text
官方素材库
  → 本地服务端抓取、校验、归一化
  → 加入所选频道 / 设为独立 App
  → 现有频道预览
  → 现有“推送频道”
  → TC002
```

这样仍然只有 Workspace Controller 负责组合、预览和推送，避免素材库与频道状态脱节。

### UI 建议

在“内容市场 → 创作”中增加“像素素材库”，保持与现有内容市场的布局一致：

- 搜索框；
- 全部、文字、AI、自然、娱乐、图形分类；
- 最新、热点、支持数排序；
- 卡片显示动画/静态预览、标题、作者和来源；
- 详情抽屉显示大预览、说明和原始官方链接；
- 操作使用现有语义：“加入频道”“设为独立 App”；
- 静态素材再提供“在画板中编辑”；
- 画板中增加“从官方链接导入”，文案明确为“粘贴 Ulanzi 素材链接”。

导入完成后先在当前频道预览，但不要自动推送设备。最终推送仍由用户点击现有主操作完成。

## 安全和稳定性边界

### URL 与 SSRF

不要按用户输入的任意 URL 做服务端下载。链接导入只接受：

```text
scheme: https
host: ugc.ulanzistudio.com
pathname: /contentView/<纯数字 ID>
```

拿到 ID 后，服务端自己构造固定的详情接口。ZIP 也只接受详情接口返回的、位于 `api.ulanzistudio.com/cdn/uploadPath/upload/` 下的 `.zip`，并禁用或逐跳验证重定向。

### ZIP 与图片校验

至少需要：

- 请求超时和并发限制；
- 官方上传界面声明单文件最大 50 MB，本项目也应设置明确的更小或等于 50 MB 的下载上限；
- 校验 ZIP magic、中央目录和路径穿越；
- 只读取根目录 `data.json`；
- 限制压缩后、解压后和 Base64 解码后的大小，防止 ZIP bomb；
- `images` 数量和动画帧数受 `WORKSPACE_LIMITS.maxFramesPerChannel = 360` 约束；
- 对 Data URL 同时检查声明 MIME 和真实文件签名；
- 只接受 PNG/GIF，解码后限制长宽和总像素；
- 最近邻缩放到 `52×16`，不执行 SVG、HTML 或脚本；
- 生成内容哈希用于去重和不可变本地缓存。

### 上游兼容层

官方 API 没有发现公开稳定性承诺。应把这些常量集中在一个适配器：

```text
官方站点域名
API 路径
素材分类 ID
字段归一化
分类 ID 映射
ZIP schema 版本
```

列表结果适合短时间缓存；已经导入的素材必须本地持久化。上游失败时显示“官方素材库暂时不可用”，但不影响本地频道和已导入内容。

### 版权与署名

详情和列表响应中未发现明确的许可证字段，页面也没有为单个作品展示可复用许可证。因此建议：

- 不随项目安装包预置或批量镜像官方素材；
- 由用户按需导入；
- 保留作品标题、作者、官方资源 ID 和原始详情链接；
- UI 中提供“查看官方页面”；
- 如果将来要运营公开二次素材市场，应先向 Ulanzi 确认 API 与内容授权。

## 推荐分期

### 第一阶段：可用且安全

1. 服务端列表、详情和缩略图代理；
2. 搜索、分类、分页；
3. 详情 ID / `contentView` 链接导入；
4. PNG 最近邻还原为 `52×16`；
5. 加入当前频道、设为独立 App、现有预览与推送；
6. 来源与作者展示；
7. 上游超时、缓存和安全校验。

### 第二阶段：完整动画

1. 新增 `creative:pixel-asset` 多帧内容；
2. GIF 解码、帧合成、帧延迟和循环处理；
3. 本地不可变媒体存储与去重；
4. 动画缩略图和频道预览；
5. 静态素材“复制到画板编辑”。

如果目标是“一次做完整”，建议第一、二阶段一起完成。否则 GIF 作品在第一阶段必须明确标注“暂不支持动画”，不能无提示地只取首帧。

## 验收清单

- 列表能够加载当前全部 50 项并正确分页；
- 分类查询使用记录 `id`，而不是列表项的 `classify` 代码；
- 搜索和三种官方排序参数正确透传；
- 题述 `1091` 链接能在本项目中导入，不复现官方 Web 的错误代理 URL；
- `1091` 导入后得到完整 `52×16` 画面；
- `1011` 导入后得到 8 帧、每帧 140 ms 的循环动画；
- 非像素素材分类的 `contentView` 链接被拒绝；
- 非官方主机、路径欺骗、重定向到其他主机、超大文件和恶意 ZIP 被拒绝；
- 从浏览器前端只请求本地同源 API，不再触发 CORS；
- 导入后断网或官方 API 临时失败，已导入内容仍能预览和推送；
- 同一素材重复导入可以复用本地内容哈希；
- 加入频道不会自动推送设备；
- 已导入卡片显示“已在频道中”，并保留作者和官方来源链接。
