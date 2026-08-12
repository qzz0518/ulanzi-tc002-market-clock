# tc002-os 配网设计（开机前置）

替换官方固件就等于删掉官方那套 `/settings/*` 网页——包括它自带的 WiFi 配置页。
所以本固件必须自带一条完整的配网路径，而且必须是**开机前置**的：没有网络时，
它是第一屏，不是设置菜单深处的一项。

> **实现现状（2026-08-12）。** 本文是设计，不是已交付行为的描述，两者目前有差距：
>
> - **已实现**：`SetupPortal` 的四条路由（页面 / `/scan` / `/status` / `POST /connect`）
>   和 `PortalService` 的独立线程。但它服务在**设备正常地址的 8080 端口**上，而不是只在
>   热点起来时——这样页面、网络列表和提交往返都能从同网段的笔记本上跑一遍，全程不碰无线。
>   这一点比别处更重要：adb 就骑在同一条链路上，弄错一次的代价是物理断电。
>   `/scan` 的数据来自 `WpaCtrl` 读 `SCAN_RESULTS`（上一次扫描的缓存），不是
>   `WifiManager::startScan()`——理由见 [ADR 0006](../adr/0006-no-flythings-network-managers.md)。
> - **已实现但默认失效**：所有会改变链路的调用锁在守卫文件 `/tmp/zos-allow-link` 后面——
>   执行器（`platform/DeviceWifi.h`）的可变一半，以及配网页的提交
>   （`platform/DeviceProvisioning.h`），文件不存在就拒绝并回报 `link-locked`。
>   安装器不创建它，所以正常安装下这段路径物理上不做事。
> - **已实现**：热点（SoftAP）。`bringUpSoftAp()` 走完整序列——停 supplicant、写
>   `hostapd.conf`、起 hostapd、`ifconfig wlan0 192.168.100.1`、起 dnsmasq。热点名是
>   `ZOS-<MAC 后四位>`（不是下文的 `TC002-OS-*`，那个 13 个 ASCII 一定要跑马灯），
>   密码 `12345678`。设置页在配网期间多出「热点 / 密码」两行，把这两个字符串告诉用户。
> - **未实现**：下文的四屏翻页序列。热点名、密码、地址目前只出现在设置菜单里。
> - **已修复（2026-08-13）**：dnsmasq 从来没有起来过。它的 pid 文件默认在
>   `/var/run/dnsmasq.pid`，而本机没有 `/var`，所以每次都退出 3——SSID 上了天线，
>   手机连得上，永远拿不到地址。参数表已挪进 `DeviceWifi::dnsmasqArgs` 并被 host check
>   钉住；同时热点 worker 常驻，dnsmasq 死了会被重新拉起。
>   参数表是**两层**：首选表加了 `--conf-file=/dev/null`、`--user=root` 等几个
>   本机没执行过的开关，一旦这个 dnsmasq 构建不认（`EC_BADCONF`，退出即原样复现本 bug），
>   `superviseDhcp()` 立刻回落到 `dnsmasqProvenArgs()`——真机上实测退出 0 并常驻的那一条
>   （原来的四个参数 + `--pid-file=/tmp/zos-dnsmasq.pid`，不动 `/etc/dnsmasq.conf`）。
>   子进程的 stderr 现在重定向到 `/tmp/zos-dnsmasq.err` / `-proven.err`：设备回到网络后
>   `adb pull` 就能看见 dnsmasq 自己说了什么，这正是当年缺的那条线索。
> - **已修复（同上）**：`wlan0` 上的 `192.168.100.1` 原来只在起热点时设一次。libzknet 的
>   `dhcpRequestIp()` 跑在无法取消的分离线程上，返回时会写同一个网卡（成功写路由器地址、
>   失败清 `0.0.0.0`）；地址一没，所有 DHCP context 都不匹配，dnsmasq 活着却一言不发，
>   而进程检查照样报健康——就是本 bug 换了个入口。现在每轮监督都对账地址，
>   并且 `softApDhcpFailed()`（面板上的「手动配网」）把「没有网关地址」也算进去。
> - **偏离**：下文引用 `WifiManager` / `SoftApManager` 的地方已被 ADR 0006 否决——那两个类
>   掌管无线电源路径，链接它们本身就是本设计要避免的那种不可恢复故障。

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

- dnsmasq 的参数表（`DeviceWifi::dnsmasqArgs` / `dnsmasqProvenArgs`）：pid/租约文件必须
  落在可写路径、地址池必须落在网关同一个 /24、回落表必须**逐字**等于真机上实测过的那条。
  这条原本写在「只有真机能回答」那一栏里，然后就真的没人去真机上问过——热点上线一年多，
  dnsmasq 每次都因为默认 pid 路径 `/var/run/dnsmasq.pid`（本机根本没有 `/var`）退出 3，
  一个地址都没发出去过。参数表现在是纯函数，host check 直接钉住。

只有 SoftAP 起停、dnsmasq 是否真的握住 67 端口、以及 2.4G 关联本身需要真机。

## 还欠真机的两件事（都不碰无线电）

1. **`/bin/dnsmasq <首选表的 11 个参数> --test; echo $?`**，要求 0。`--test` 在选项解析
   完就退出，不 fork、不 bind、不碰 wlan0/hostapd/wpa_supplicant，因此不影响 adb。
   它只证明这个构建**接受**这些参数，不证明 `/tmp` 可写（那个已经实测过）。
   跑不了也不阻塞发布：回落表就是为这种情况存在的，但跑了就能把回落从「保险」降级成
   「用不上的保险」。顺手 `cat /etc/passwd /etc/group`，可以确认 `--user=root` 是必需
   还是仅仅稳妥。
2. **`cat /proc/net/tcp`**，找本地端口 `0050`（80）的 `st 0A` 监听行，settle 配网页到底
   在 80 还是回落到了 8080。面板的「配网」行渲染的是 `<ip>:<port>`，也能直接读。

## 明知没关、故意没关的一个口子

`WifiPolicy::kObtainingIp` 没有出口：关联上了但路由器一直不发租约，设备就一直等。
写过一版「三次拿不到就回落热点」，评审后撤了——`bringUpSoftAp()` 会
`ctl.stop wpa_supplicant`，而 `/etc/init.rc` 把这个服务标成 `disabled` + `oneshot`，
所以 `kProvisioning` 里那条「后台继续重试」的分支（它 gate 在 `supplicantRunning()` 上）
在热点真上天线之后根本不会触发：**这个回落是单向的**，除非有人在配网页提交凭据或者拔电。
而它触发的条件——断电恢复后时钟比路由器的 DHCP 先起来——常见且短暂。
用一个 36 秒的定时器把这种设备永久推进热点，比让它继续等更糟。
真要关这个口子，需要热点能被拆掉再重测存储的网络，那是另一件要单独取证的事。

顺带说清楚：**`kConnecting` 那条 25 秒超时进热点的老路，单向性完全一样**——
`stopSoftAp()` 只有 `applyCredentials()`（用户在配网页提交）会调，
`kProvisioning` 里那条能调它的分支同样 gate 在 `supplicantRunning()` 上。
所以热点一旦真上天线，出路只有「有人配网」或「拔电」两条。这是既有行为，本次没动，
但它和上面那个未关的口子是同一件事的两半，要修就一起修。
