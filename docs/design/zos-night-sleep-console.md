# 夜间息屏 — 控制台侧契约

- 状态：定稿，待实施（固件与服务侧已落地）
- 日期：2026-08-13
- 相关：[ADR 0009](../adr/0009-night-sleep.md)、`device/tc002-os/README.md#夜间息屏`、
  `docs/reference.md`（线协议与路由表）

这份文档是给**重做 常规设置 的那一组**看的：固件和服务已经就位，`web/` 一行都没动。
下面是控制台需要实现的全部内容，写到不用回来问的程度。

**先说结论级的三条**：

1. 用户看到的字是**息屏**，不是休眠。中文里 休眠 是 hibernate（机器断电），而这台设备唯一的
   恢复手段就是断电——这正是会劝退用户的联想。设备上的两行叫 `夜间息屏` / `息屏等待`。
2. **`telemetry.sleep` 是真相，`requestedSleep` 只是「上次请求」。**旋钮是第二个写方。
3. **绝不从像素推断息屏。**全黑和一台死掉的时钟在屏幕上一模一样——这是 `describeMirror`
   对离线情形早就写死的规矩，息屏是同一个坑。

---

## 1. 读：`GET /api/os/state`

新增两个字段（其余不变）：

```ts
requestedSleep: {
  enabled: boolean | null;
  startMin: number | null;   // 0..1439
  endMin: number | null;     // 0..1439，不含
  idleSec: number | null;    // 30..7200
  seq: number;               // 0 = 控制台从未写过
};

telemetry: {
  /* …既有字段… */
  sleep?: {
    on: boolean;
    startMin: number;
    endMin: number;
    idleSec: number;
    asleep: boolean;       // 面板此刻是不是黑的
    clockSynced: boolean;  // 「息屏被允许动作」，见 §5
  };
};
```

**`requestedSleep` 里的 `null` 是有意义的**：表示「控制台从没写过这一项」，不是默认值。
只有写过的字段才会上线协议，所以一次只改超时的 PUT 不可能顺手改掉窗口。**表单不要渲染
`requestedSleep`**——它没有窗口可显示的时候真的就是没有。要显示的是 `telemetry.sleep`。

`ZosTelemetry`（`web/src/lib/zos-link.ts`）需要加上这个可选的 `sleep` 字段，字段名与上表一致。

## 2. 能力探测：`telemetry.sleep === undefined`

**块不在 = 固件早于这个功能。**把控件禁用，写：

> 该固件版本不支持夜间息屏，请更新 ZOS

**不要看 `telemetry.proto`**——这一版固件根本不发 `proto`，把它抬上去会同时宣称一份它并没有的
lyric window 支持，还会翻转歌词编码（见 `docs/reference.md` 的 `OS_PROTO_LYRIC_WINDOW`）。

`telemetry === null`（设备从未上报）是另一回事：那是「等待设备」，不是「不支持」。

## 3. 写：`PUT /api/os/sleep`

```
{ enabled?: boolean, startMin?: 0..1439, endMin?: 0..1439, idleSec?: 30..7200 }
```

- 至少给一个字段，否则 400。越界 400。同源。走 `SettingsValidationError`，所以是 **400 不是 403**。
- 应答 `{ requested: <上面的 requestedSleep 形状> }`。
- **立即生效，没有草稿/保存两段式**：这个端点最该做好的一件事，是替一个不在时钟旁边、
  面板已经黑了的人把功能关掉。
- **只发变化的字段是安全的**，而且是推荐做法：服务只把写过的字段放上线协议，固件把「缺的那一行」
  读成「这一项别动」。
- `startMin === endMin` 是**全天**，必须接受（见 §6）。

设备最长 8 秒（长轮询）内收到。序列上升同时被固件算作一次「用户操作」，所以
`{enabled:false}` 不只是停止再次息屏，而是**当场点亮面板**。

## 4. 镜像：`describeMirror` 增加一个 `sleeping` 阶段

`web/src/lib/zos-link.ts` 的改动，逐条：

**类型**

```ts
export type ZosMirrorPhase = "offline" | "sleeping" | "waiting" | "stale" | "live";
```

**入参**，在既有对象上新增一个可选字段（名字就用这个）：

```ts
export function describeMirror(input: {
  live: boolean;
  frameReceivedAt: number | null;
  now: number;
  frameAgeMs?: number;
  /**
   * telemetry.sleep?.asleep。undefined = 固件不支持或还没上报过，
   * 与 false 的处理完全一致：不进 sleeping 分支。
   */
  asleep?: boolean;
}): ZosMirrorStatus;
```

**优先级**，写死的顺序是：

```
!live  →  offline
asleep →  sleeping      ← 新增，在 waiting 与 stale 之前
frameReceivedAt === null → waiting
ageMs > ZOS_MIRROR_STALE_MS → stale
否则 → live
```

`sleeping` 排在 `waiting` **之前**，这解决了「息屏 + 从来没收到过帧」的歧义：那种情况下用户想
知道的是「它在息屏」，不是「在等画面」。排在 `stale` 之前，是因为设备息屏时每秒真的会 tee 一帧
黑帧（在 2500 ms 的 staleness 线以内），所以这个标签**不依赖 tee 的频率**。

**返回值**

```ts
{
  phase: "sleeping",
  label: "已息屏",
  notice: "面板已按夜间息屏熄灭。在时钟上转动旋钮，或在这里按任意方向键即可唤醒。",
  showsFrame: false,
}
```

`showsFrame: false` 是**承重的**：清空画布，而不是画一屏黑像素。理由和 `offline` 分支一样——
黑像素和一块坏掉的屏在人眼里没有区别，而这里我们明确知道原因，就该说出来。

**唤醒后的抖动**：`asleep` 的翻转会让固件**立刻补发一次遥测**（不等 10 秒周期），所以状态轮询
（2 秒）通常在 ~2 秒内就能看到 `asleep: false`。如果你想更稳，可以再加一条：当最后一帧的
`receivedAt` 比 `telemetry.receivedAt` 更新时，跳过 `sleeping` 分支——一块已经亮起来的面板绝不
该被画成空白。这条是可选的加固，不是必需项。

## 5. 「开了却不息屏」的解释

`sleep.on && !sleep.clockSynced` → 在开关旁边写：

> 等待校时，暂不息屏

字段名比它实际的含义窄一点：设备发的是「**同步过、且在 26 小时以内**」，也就是「息屏此刻被允许
动作」。这台机器在 TimeSync 之前实测停在 1970-01-01 00:00，而那个时刻就在 23:00→07:00 里面——
所以「时间不可信就一律亮着」是这个功能的前提而不是保守，值得在 UI 上说一句。

设备自己的那一行在这种状态下显示 `23-07 等待校时`（并排，不是替换）。

## 6. 表单

**预设**，与设备保持一致，让两个界面一眼对得上：

| 预设 | 值 |
|---|---|
| 关闭 | `enabled: false` |
| 22:00–07:00 | `1320 → 420` |
| 23:00–07:00 | `1380 → 420` |
| 00:00–08:00 | `0 → 480` |
| 自定义 | 任意分钟 |
| 全天 | `startMin === endMin` |

**`全天` 只有控制台能设。**旋钮上按不出来：它是唯一没有「到点自己亮回来」那个墙上时刻的模式，
而那是整套安全论证的支点（ADR 0009 §安全网 第 2 条）。控制台可以给它，但**必须写清楚代价**：

> 全天：任何时段都会息屏，没有自动亮回来的时刻——只能靠操作唤醒。

**跨零点是常态**。分钟选择器必须能预览这一点：`23:30 → 次日 06:45`。结束时刻**不含**（07:00
已经是早上）。

**等待时长**：1 / 3 / 5 / 10 / 30 分钟与设备一致，另可自定义 30–7200 秒。

## 7. 唤醒

**不要加专门的「唤醒」按钮。**既有的远程方向键就是唤醒控制：固件把控制台注入的按键走的是物理
按键那条路，所以**第一下只唤醒、不执行**（和真按键一样，凌晨两点转旋钮是为了看时间，不是为了
翻频道）。§4 那条 notice 已经把这件事告诉用户了。

## 8. 旋钮是第二个写方

表单每次打开、以及每次轮询回来，都要**重新读 `telemetry.sleep`**，不要相信自己上一次的请求：

- 用户在时钟上按一下 `夜间息屏`，窗口就变了；
- 特别地——**设备上的一按可以换掉控制台设的自定义窗口**。设备端只有一个窗口槽位，环是
  `关闭 → 22-07 → 23-07 → 00-08 → [自定义] → 关闭`。离开自定义的那一按落在 `关闭`（窗口还在，
  控制台一次 `{enabled:true}` 就能恢复），**再按一下才真的换掉它**。所以一个「我刚设过所以它还在」
  的假设会是错的。

同样的关系音量滑块已经有了，这里只是第二例。

## 9. 服务重启

hub 的序列是 Bun 进程里的普通实例状态，`bun start` 之后从 1 重来。设备侧已经处理：**比已采纳值
小的序列**被当成「服务重启了」而不是重放。控制台无需为此做任何事——写这一条只是为了说明，
在服务刚重启、`requestedSleep.seq` 回到 0 的时候，**这不代表设备的配置丢了**：设备的配置在
`/data`，`telemetry.sleep` 会照常报上来。
