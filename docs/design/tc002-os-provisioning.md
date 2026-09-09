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
> - **已修复（2026-08-13，第一轮）**：dnsmasq 从来没有起来过。它的 pid 文件默认在
>   `/var/run/dnsmasq.pid`，而本机没有 `/var`，所以每次都退出 3——SSID 上了天线，
>   手机连得上，永远拿不到地址。补 `--pid-file` 后手测退出 0 并常驻。
>   **但这轮验证只在站内模式下手工跑过 dnsmasq，从未在真实 AP 模式下观察过**；
>   用户随后实测热点仍然发不出地址，于是有了下一条。
> - **已重构（2026-08-13，第二轮，本轮）**：dnsmasq 换成**厂商执行模型 + 三层参数表**
>   （`DeviceWifi::dnsmasqArgsForLayer`，host check 逐层钉住）：
>   L1 全显式 + `--no-daemon` + `--log-dhcp`（前台子进程根本不写 pidfile，整类问题消失；
>   DHCP 包级日志落 `/data`）；L2 逐字照抄本机 `libzknet.so` 里 `soft_ap_enable` 的
>   argv（`--no-daemon --no-resolv --no-poll --dhcp-range=…`，隐式吃 `/etc/dnsmasq.conf`
>   ——这是本平台量产机每台都在跑的形状）；L3 保留真机实测过的 daemon 化那条原样兜底。
>   监督从「按名认进程」改成**认 pid + cmdline 指纹**（`cmdlineClaimsOurDnsmasq`）：
>   老检查会把 init 起的、池子在 192.168.1.x 的外来 dnsmasq 当成自家的健康 DHCP。
>   hostapd 加厂商的熵文件配方（`-e /data/misc/wifi/entropy.bin`，缺则按 libzknet 语义
>   建 21 字节种子；被拒则回落原始裸调用）。teardown 改厂商顺序（dnsmasq → hostapd →
>   清地址 → `ctl.start wpa_supplicant`，最后一步在一切失败路径上不变）。
>   子进程 stderr 从 /tmp 迁到 `/data/zos-dnsmasq.l{1,2,3}.log`——上一代放在 tmpfs，
>   而读取它们的唯一方式（断电回网）恰好清空 tmpfs，诊断在送达读者的路上自毁。
> - **已修复（2026-08-13，本轮）**：配网页下拉恒空的确定性根因。`SCAN_RESULTS` 读的是
>   supplicant 的**缓存**，刚起的 daemon 缓存为空、应答只有表头，`scanResults` 把它当
>   「扫完了、没网络」，于是 `kScanning` 在第一个 160 ms tick 就带空列表进 AP，5 秒扫描
>   预算是死代码，真扫描随后被 `ctl.stop wpa_supplicant` 杀死。现在：空列表返回 false
>   （`scanSweepComplete`，host check 钉住）、预算 5 s→12 s、空结果期间每 4 s 重发
>   SCAN、首个非空立即进 AP；非空结果原子落盘 `/data/zos-scan-cache.txt`，下次开机
>   扫描超时也有上一次的列表可用（页面标注「来自上次扫描」，手输框仍是兜底）。
> - **新增（2026-08-13，本轮）**：面包屑（`platform/ProvisionLog`）。AP 路径每一步
>   append 一行到 `/data/zos-provision.log`（逐行 fsync、32 KB 轮转一代、PSK 结构性
>   进不来），`/data/zos-build.id` 每次开机 compare-first 写入构建号——先杀掉
>   「刷的到底是哪份代码」这个零号假设。schema 见下文「面包屑」一节。
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
不划算。`device/tc002-lyrics-player/app/src/net/NetClient.cpp` 已经证明了裸 socket 上
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

- dnsmasq 的三层参数表（`DeviceWifi::dnsmasqArgsForLayer`）：层序（推理层 → 厂商
  二进制层 → 真机实测层）、L2 逐字等于 libzknet 的 argv、L3 逐字等于真机实测过的那条、
  地址池必须落在网关同一个 /24、任何一层都不得引用不存在的 `/var`、三个 stderr 捕获
  必须在 `/data` 且互不覆盖。这条原本写在「只有真机能回答」那一栏里，然后就真的没人
  去真机上问过——热点上线一年多，dnsmasq 每次都因为默认 pid 路径
  `/var/run/dnsmasq.pid`（本机根本没有 `/var`）退出 3，一个地址都没发出去过。
  参数表现在是纯函数，host check 直接钉住。
- 进程身份指纹（`cmdlineClaimsOurDnsmasq`）：三层各自的 argv 都被认领，裸
  `/bin/dnsmasq`（init 起的外来进程的样子）与 192.168.1.x 池子被拒绝。
- hostapd 的两级 argv（`hostapdArgs`）：首选厂商形状 `-B -e <熵文件> <conf>`，
  回落逐字等于一直在天线上跑的裸调用。
- 扫描完成判据（`scanSweepComplete`）：空缓存不是扫完；策略层空结果不结束
  `kScanning`、每 4 s 重发 SCAN、首个非空立即进 AP、12 s 超时兜底——全部在
  FakeWifi（其语义与真执行器契约一致，这次是真的一致）上推演。
- 面包屑（`ProvisionLog`）：行格式、seq、控制字符消毒（SSID 不能伪造第二行事件）、
  轮转、compare-first 的构建号写入，全部在宿主机 scratch 路径上跑真实现。

只有 SoftAP 起停、dnsmasq 是否真的握住 67 端口、以及 2.4G 关联本身需要真机。

## 2026-08-13 大修的三个架构决定

**决定 1：保留 AP 门户配网，拒绝 BLE，但 bring-up 配方向厂商全面对齐。**
原厂 TC002 的初配走 BLE GATT（官方仓库 `Z21_TC002_Demo/src/ble/` 有完整接收端，
量产设备的 BLE 广播名与之一致；仓库里没有任何 TC002 的 AP 配网痕迹）——但 BLE 需要
手机侧协议与 App，官方 demo 的 `on_message` 没有解析实现，量产协议未知，而 ZOS 的
门户网页就是我们的「App」。同时本机 `libzknet.so` 反汇编证明这块芯片上存在一套
field-proven 的 SoftAP+DHCP 实现（平台其他产品线在用）：AP 模式在此硬件上可行且被
验证过，只是配方细节与 ZOS 有偏差。所以流程保留 AP 门户，配方逐条改成厂商在本机
二进制里的那份（熵文件、`--no-daemon` 前台 dnsmasq、teardown 顺序）。BLE 零件都在
官方仓库（GPL-3.0，BlueZ GATT server + hciattach），留作未来选项。热点保持 WPA2：
静态 IP 会话证明握手已通，不引入新变量。

**决定 2：扫描列表 = 拆 supplicant 前可靠扫描 + 持久缓存到 /data。**
单射频 STA/AP 互斥被厂商二进制确认（`"wifi maybe enable, can't enable soft ap !!!"`），
AP 期间架构上确实无法扫描；但缓存通道早已建好，真正的确定性根因是空缓存被当成扫完
（见上文实现现状）。付出的代价，明说：最坏的首配路径进 AP 前多等 **12 秒**；断电后
展示的可能是**陈旧列表**（页面标注，手输框兜底）。拒绝的选项：掉 AP 重扫（手机断连，
有困死用户风险，厂商无先例）；AP+STA 并发（驱动能力零记载，厂商从不用）。

**决定 3：诊断即交付。** 每一轮配网失败都必须让下一轮变便宜：AP 路径每步落
`/data`，断电读取是设计内路径而不是事后补救。这就是下面的面包屑 schema。

## 面包屑（/data，断电后 adb 读）

| 路径 | 写法 | 证明什么 |
|---|---|---|
| `/data/zos-build.id` | 开机 compare-first 覆写：`<git rev>[-dirty]-<时间戳>`（`mise run os-build` 注入 `ZOS_BUILD_ID`，对应对象每次构建强制重编） | 杀死「刷的是哪份代码」（零号假设） |
| `/data/zos-provision.log` | append，行格式 `<seq> <单调ms> <TAG> k=v...`；逐行 fsync；≥32 KB 轮转为 `.1` 保一代 | 主事件链，TAG 表见下 |
| `/data/zos-dnsmasq.l{1,2,3}.log` | dnsmasq 各层 stderr，每次尝试 O_TRUNC；L1 含 `--log-dhcp` 的包级日志 | 有 DISCOVER 有 OFFER=驱动丢包；有 DISCOVER 无 OFFER=context 失配；全无=进程/手机侧 |
| `/data/zos-scan-cache.txt` | 每行一个 SSID，临时文件+rename 原子替换；只存 SSID | 断电后下拉仍有货 |

`zos-provision.log` 的 TAG（全部已接线）：
`BOOT rev=` 会话边界；`SCAN_CMD reply=<OK|FAIL-BUSY|no-socket|no-reply>` 每次下发
SCAN 的原始应答；`SCAN_DONE n= t= exit=<result|timeout>` 缓存被喂了什么、怎么退出；
`AP_ENTER reason=<no-creds|connect-timeout> scanned=` 区分首配与凭据失效；
`SUPP_STOP svc=` ctl.stop 是否真生效；`HOSTAPD_SPAWN args=<entropy|plain> rc=
entropy=<exists|created|fail>`；`AP_ADDR rc= readback=` 关闭 ifconfig 返回值被忽略的洞；
`ADDR_CHANGE old= new=` 仅变化时写，钉地址空洞；`DNSMASQ_TRY layer= pid=
outcome=<alive|exit:N|signal:N|spawn-fail|down>` 哪层配方跑了、怎么死的；
`DNSMASQ_DEAD pid= exit= respawn=` 监督期死亡与重启计数（受 30 s retry floor 约束）;
`DNSMASQ_ADOPT pid=` 固件重启后按 cmdline 指纹认领旧进程；`AP_UP ssid= addr= dhcp=`；
`PORTAL_HIT path=/scan n= cached=` 手机确实到达门户（仅计数变化时写）；
`PROV_SUBMIT ssid= psk=redacted accepted=` —— **logger 的 API 结构性收不到密钥**，
唯一见到 PSK 的调用点在建串前就写死 `redacted`；`AP_EXIT` / `AP_ABORT` 收尾，
两者的终点都有 `ctl.start wpa_supplicant`。

## 真机验收（协调者执行）

1. 刷机开机在 LAN 上：`cat /data/zos-build.id` 与本次构建号一致（先杀零号假设）。
2. 触发配网：手机连热点，≤10 s 拿到 192.168.100.100–200 的租约；打开
   192.168.100.1（或等弹窗），下拉**非空**（实时或标注「上次扫描」的缓存均算）；
   选网+输密码，设备回到 LAN，门户退场。
3. 无论成败：断电重启回 LAN，读 `/data/zos-provision.log` 与 `/data/zos-dnsmasq.*.log`。
   判读表：
   - `DNSMASQ_TRY ... outcome=exit:N` + 对应层的 stderr 文件 → 哪层被拒、为何
   - l1 日志有 DISCOVER 有 OFFER 而手机无租约 → 驱动丢广播 OFFER → 下轮试 `--dhcp-broadcast`
   - 有 DISCOVER 无 OFFER → context 失配 → 对照 `AP_ADDR` / `ADDR_CHANGE`
   - 全无 DISCOVER → 手机侧/入向广播死 → 考虑开放热点或厂商 `-d` 前台 hostapd
   - `SCAN_DONE n=0` 且 `PORTAL_HIT` 带 `cached=1` → 缓存兜底在工作；两者都是 0 → 看 `SCAN_CMD reply=`
4. 成功判据：第 2 步全过，且日志含完整事件链
   （BOOT→SCAN_CMD→SCAN_DONE→AP_ENTER→SUPP_STOP→HOSTAPD_SPAWN→AP_ADDR→
   DNSMASQ_TRY alive→AP_UP→PORTAL_HIT→PROV_SUBMIT），全文 `grep psk=` 只命中
   `psk=redacted`。

## 还欠真机的两件事（都不碰无线电）

1. **`/bin/dnsmasq <L1 的 12 个参数> --test; echo $?`**，要求 0。`--test` 在选项解析
   完就退出，不 fork、不 bind、不碰 wlan0/hostapd/wpa_supplicant，因此不影响 adb。
   它只证明这个构建**接受**这些参数（`--no-daemon`、`--log-dhcp` 是这轮新加的两个）。
   跑不了也不阻塞发布：L2/L3 就是为这种情况存在的，但跑了就能把回落从「保险」降级成
   「用不上的保险」。顺手 `cat /etc/passwd /etc/group`，可以确认 `--user=root` 是必需
   还是仅仅稳妥；`ls -l /data/misc/wifi/`（entropy.bin 是否已存在、
   wpa_supplicant.conf 的 mtime 能顺带验证 SAVE_CONFIG 是否真落盘）。
2. **`cat /proc/net/tcp`**，找本地端口 `0050`（80）的 `st 0A` 监听行，settle 配网页到底
   在 80 还是回落到了 8080。面板的「配网」行渲染的是 `<ip>:<port>`，也能直接读。
   顺手 `cat /proc/net/udp` 找 `:0043`/`:0035`——若有外来 dnsmasq 占着 67 端口，
   L1/L2 的 stderr 会写 "Address in use"，两边互相印证（候选 3）。

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
