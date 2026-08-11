# tc002-os 配网设计（开机前置）

替换官方固件就等于删掉官方那套 `/settings/*` 网页——包括它自带的 WiFi 配置页。
所以本固件必须自带一条完整的配网路径，而且必须是**开机前置**的：没有网络时，
它是第一屏，不是设置菜单深处的一项。

## 官方基线（2026-08-11 查证）

来源：<https://docs.ulanzistudio.com/tc002/software/web-setup.html>

| 环节 | 官方行为 |
|---|---|
| 无网开机 | 面板显示 `connect` |
| 热点 | SSID `U-Clock`，密码 `12345678` |
| 配置页 | 手机连上后跳 `192.168.100.1`，两个字段：SSID + 密码 |
| 频段 | 仅支持 2.4G |
| 成功后 | WiFi 指示由白色闪烁转白色常亮，面板显示 `READY`，路由器分配 IP |
| 查 IP | 工具菜单的「IP地址」项 |

两个可直接复用的事实：

1. **手机连上热点后能拿到地址**，说明设备侧存在给 AP 客户端发地址的 DHCP。
   这解答了摸底阶段悬着的问题——SoftAP 不是只能起个空壳。
2. **`192.168.100.1` 是 AP 侧的固定网关地址**，`SoftApManager::getIp()` 应当回报它。

## 与官方的差异，以及为什么

**热点名带机器码。** 官方所有设备都叫 `U-Clock`，同一个房间里两台就分不清，
而且和官方固件的热点重名会让用户在两套系统之间困惑。本固件用
`TC002-OS-<MAC 后四位>`（例：`TC002-OS-A772`），密码沿用 `12345678`——
密码换成随机值会强迫用户先看面板，而面板一次只显示 4 个汉字宽度。

**面板要显示热点名和地址，而不只是 `connect`。** 官方那句 `connect` 不告诉用户
接下来做什么。一页一项的翻页序列：`连接热点` → `TC002-OS-A772` → `12345678` →
`192.168.100.1`，旋钮可翻，也自动轮播。这正是「一页一项」在最需要的地方兑现。

**扫描结果直接给出，而不是让用户手打 SSID。** `WifiManager::startScan()` +
`getWifiScanInfosLock()` 已经可用，配置页列出扫到的 2.4G 网络，用户只填密码。
手打 SSID 在手机小键盘上极易出错，而错一个字符的表现和密码错完全一样。

## 状态机

```
        ┌──────────────┐
        │   BOOTING    │  BootScreen，1500ms
        └──────┬───────┘
               │ 读 /data/misc/wifi/wpa_supplicant.conf
       ┌───────┴────────┐
       │ 有凭据?         │
       └──┬──────────┬──┘
      是  │          │ 否
          ▼          ▼
   ┌────────────┐  ┌──────────────┐
   │ CONNECTING │  │ PROVISIONING │ ← SoftAP + 内置 HTTP 服务
   │  最多 25s   │  └──────┬───────┘
   └──┬──────┬──┘         │ 用户提交并连通
      │      │ 超时        │
      │      └────────────►│
      │ 成功                │
      ▼                    │
   ┌────────────┐          │
   │   READY    │◄─────────┘
   │  进入主环   │
   └────────────┘
```

**关键设计：CONNECTING 超时后回落到 PROVISIONING，而不是死等。** 换了路由器、
改了密码、搬了家——这三种情况下旧凭据都还在文件里，死等就是永远黑屏。
25 秒是因为 `wpa_supplicant` 关联 + DHCP 在 2.4G 弱信号下实测可能到 15 秒以上，
25 秒留足余量又不至于让用户以为设备坏了。

**PROVISIONING 不是终点。** 进了配网态仍然继续后台重试原凭据：用户可能只是
路由器重启慢了一步。一旦原网络回来就直接进 READY，热点自动关闭。

## wpa_supplicant 的所有权

`/etc/init.rc:131` 把它声明为 `class main` + **`disabled`** + **`oneshot`**：

- `disabled` → 开机 `class_start` 不拉它，必须有人显式 `ctl.start wpa_supplicant`
- `oneshot` → 它死了 init 不会重启

官方 app 通过 `libzknet.so` 干这件事（二进制里能看到 `ctl.start`、
`init.svc.wpa_supplicant` 字符串）。我们顶替了官方 app，这份责任就是我们的：

1. 开机主动 `ctl.start`，并轮询 `init.svc.wpa_supplicant` 直到 `running`
2. 运行期监督；进程消失就重启它（`libzknet` 的 EventThread 在守护进程消失时
   会 `handleDisconnect()` + `closeSockets()` 然后**退出**，此后 `WifiManager`
   就是瞎的——只靠它的回调发现不了这件事）

这一段做成注入时钟 + 注入属性读取器 + 注入执行器的纯 `WifiPolicy`，
在 host 上跑状态机断言；只有薄薄一层适配器碰 zknet。

## 内置 HTTP 服务

registry 里有 `civetweb-cxx`，但为了一个两字段的表单引入一个 HTTP 服务器框架
不划算。`device/tc002-arcade/app/src/net/NetClient.cpp` 已经证明了裸 socket 上
手写 HTTP/1.0 是可行的（那是客户端方向），服务端方向约 180 行同类代码即可：
`accept` → 读请求行与头 → 路由 → 回应。

需要的路由只有四条：

```
GET  /                → 配置页（HTML 内联，无外部资源）
GET  /scan            → 扫描结果 JSON
POST /connect         → {ssid, password}，触发连接并回报结果
GET  /status          → 当前状态，供页面轮询
```

页面必须**完全自包含**——手机连在热点上时没有外网，任何 CDN 引用都会转圈。

## 恢复路径（这一条决定了能不能固化）

侧载模式下万无一失：断电清空 `/tmp`，官方固件连同它的配网页一起回来。

固化之后这张网就没了，配网成为**唯一**入口。因此固化的前置条件是本文档这套
机制在真机上验证通过，且 `WifiPolicy` 的超时回落被证明可靠——否则一次换路由器
就是一次返厂级别的事故（没网就没 adb，5555 端口也上不去）。

## Host 可验证的部分

- `WifiPolicy` 状态机：注入时钟推进，断言 BOOTING→CONNECTING→超时→PROVISIONING、
  PROVISIONING 期间后台重试成功→READY、以及 supervisor 在进程消失后重启它
- HTTP 请求解析与路由表：在 macOS 上对 loopback socket 跑
- 配网页面的四屏文案排版：像素断言，确保 `TC002-OS-A772` 这类字符串在 52px 内
  的表现符合预期（11 个 ASCII × 6px = 66px > 52px，必然走跑马灯）

只有 SoftAP 起停、DHCP 是否真给手机发地址、以及 2.4G 关联本身需要真机。
