# TC002 OS — 替换官方固件的系统固件

面向 Ulanzi TC002（52×16 RGB LED）的完整系统固件：一页一项的旋钮式菜单、
自带 WiFi 配网、频道 / 音乐 / 游戏 / 设置统一入口，以及可从 Pixel Studio 控制台
直接控制与实时镜像的设备画面。

与已有的两套侧载固件（`../tc002-lyrics-player` 音乐播放器、`../tc002-arcade` 游戏厅）
互斥共存，共用同一条 `/tmp` 加载路径与 `/tmp/tc002-sideload.id` 会话标识（ADR 0004）。

> **当前进度**：开机动画、Shell / 两级菜单、七款游戏、音乐页、设置页、控制台链路
> （长轮询 + 帧包 + 画面镜像）、音量 / 亮度、配网页面均已就位。
> **尚未实现：热点（SoftAP）**；改变链路的那一半锁在守卫文件后面，见下方「WiFi 与配网」。

## 唯一的架构铁律

**Screen 只往 Surface 里画，永远不碰 SPI；全工程只有 `platform/Presenter` 写 LED 总线。**

时间以参数 `nowMs` 传入，Screen 必须是 `(state, nowMs)` 的纯函数——同样的一对输入
必须产出同样的像素。这条铁律不是洁癖，它换来三件事：

1. **UI 可在 Mac 上验证。** `ui/`、`core/Surface|Ease` 不含任何 FlyThings 头文件，
   `mise run os-hostcheck` 用 clang++ 直接编译并断言像素。LED 总线是只写的，
   `/dev/fb0` 与面板无关（见 `docs/research/tc002-device-probe.md`），
   真机上根本读不回一帧——不在 host 上断言，UI 回归就没有任何地方能被发现。
2. **镜像功能只有一个接入点。** 画面合成收口在一处，后续把帧 tee 给控制台是加一行。
3. **不重演 arcade 的两个缺陷。** 那边 4 个页面各自从 `PageBase` 调 `sendLedData`，
   一把静态锁横跨整帧写入（含强制的 15 ms 帧间隔），任何别的线程都要等满一帧。

## 目录

```
app/src/core/     Surface, Shell, RingModel, Transitions, Text, Ease  ← 全部 host 可编译
app/src/ui/       Screen 接口与各页面, LevelOverlay, 图标, ZOS 字标   ← 同上
app/src/net/      HostLink, StateDoc, FrameBundle, HttpClient/Server,
                  WpaCtrl, WifiPolicy, SetupPortal, PortalService     ← 纯逻辑部分同上
app/src/platform/ Presenter, Sfx, DeviceControls, NetInfo,
                  DeviceProvisioning                                  ← 唯一的设备侧
app/src/visual/   Glyphs.cpp                    ← 唯一允许 include 字模表的翻译单元
app/src/managers/ KeyManager, McuManager        ← 沿用 arcade 已验证实现
app/src/uart/     串口 / MCU 协议                ← 同上
app/src/activity/ FlyThings Activity 外壳        ← 精简版，无 ZK 控件
app/src/logic/    osLogic.cc                    ← 组合根与渲染循环，被 activity include
hostcheck/        selfcheck.cpp, link-audit.sh
sideload/os       侧载启动脚本
```

七款游戏引擎不在这棵树里：`../tc002-arcade/app/src/games` 被原样编入（`EXTRA_SRC_DIRS`），
不做移植——它们已在真机验证并被 arcade 自己的自检覆盖，移植等于把这份保证分叉。

## 输入

旋钮顺时针 / 逆时针，加旋钮键（`0x67`）与左 / 中 / 右三键（`0x6C` / `0x69` / `0x6A`）。
`KeyManager` 在自己的事件线程上回调，`osLogic.cc` 只入队，UI tick 再取出——
屏幕状态只在一个线程上变更。

| 输入 | 行为 |
|---|---|
| 旋钮左右 | 当前环内翻页；音乐页上一首 / 下一首；游戏内直达引擎 |
| 旋钮键 / 中键短按 | 进入 / 确认；频道页暂停继续；音乐页播放暂停 |
| 任意键长按 600ms | 返回上一层（未被页面消费的 `kInputHold` 由 Shell 统一 pop） |
| 侧键短按 | 音量 ±1（0–6，与官方固件同刻度；mixer 上限实测为 50） |
| 侧键长按 | 亮度 ±1（10 档） |

游戏页是唯一要求「原始按键边沿」的页面（`wantsRawButtons()`）：引擎需要知道方向键被按住
了多久，所以侧键在游戏内不再是音量 / 亮度。长按在任何阶段都能退出游戏。

## 菜单

主菜单固定四项：**音乐 / 游戏 / 轮播 / 设置**，一页一项、满幅显示。频道在「轮播」下一层，
七款游戏在「游戏」下一层——频道是内容不是目的地，十个频道会把另外三项挤出这个一次只显示
一项的环。频道页**没有图标也没有名字**：画面是服务端排好的内容，名字只在帧还没下载完时
出现。四个入口各有各的进场动画（CRT / 均衡器 / 卡带 / 抽屉），退出是同一段动画倒放。

音效是合成的（方波 / 三角波 / 噪声 + 频率扫描 + 衰减包络，直接写 `base::AudioPlayer`），
不带任何 .wav——采样要经 MediaPlayer 解码，会拖进约 1.1MB .text + 856KB .bss 的 ffmpeg。
Shell 的三声（tick / confirm / back）全局统一，七款游戏各有自己的开始 / 得分 / 结束音色。

## 控制台链路

设备主动拉：`GET /api/os/pull`（8 秒长轮询，行式 `KEY\tVALUE`）、
`GET /api/os/frames?app=`（`TCF1` 原始 RGB 帧包）、`POST /api/os/report`（10 秒遥测）、
`POST /api/os/mirror`（10fps 回传面板实拍帧，仅在控制台在看时）。两条线程：长轮询会挂住
连接最多 8 秒，一个线程做不了两件事，而 8 秒才更新一次的镜像不叫镜像。UI tick 从不阻塞在
任何一条上——它取一份 snapshot，帧包用 vector swap 交接。协议细节见 `docs/reference.md`。

## 构建与验证

```bash
mise run os-hostcheck    # clang++ 编译 UI 并断言像素，不需要设备
mise run os-build        # Docker 交叉编译 → libzkgui-os.so（ELF32 ARM，已 strip）
mise run os-linkaudit    # 链接审计，见下
```

`os-linkaudit` 拦的是唯一一种「推上去才发现」的故障：加载器对缺符号只会报一句
`initLib error: undefined symbol`，面板全黑，不告诉你缺哪个库哪个符号。它做四件事：

- **NEEDED 必须是可满足集合的子集。** 基准取 `libzkgui-arcade.so`——那个固件在真机上
  跑通过，它的 NEEDED 集合是经验上成立的。设备内存映射（`device-dump/maps-baseline.txt`）
  只用来扩大集合，不单独作为判据：它反映的是官方 app **加载过**什么，而不是设备上
  **有**什么（`libzkmedia` 就是存在但未被官方 app 加载的例子）。
- **零个未定义的 `av_*` / `sws_*` / `swr_*` 符号。** 链了 audio-utility 却没有 ffmpeg
  会留下约 38 个未定义符号，而设备根本不带 `libav*`。
- **零个 FlyThings 网络管理器符号。** 这是**安全闸门**不是洁癖：`NetManager` /
  `WifiManager` / `SoftApManager` 掌管无线的电源路径，会对着这台机器上并不存在的模块目录
  调 rmmod/insmod，走进那个分支 `wlan0` 就没了，而 adb 正骑在这条链路上——只能物理断电
  恢复。管理器类是 C++ 的，一旦有人 `#include <net/NetManager.h>`，改写后的符号名就会留在
  未定义符号里，构建在这里失败而不是在台架上失败。详见
  [ADR 0006](../../docs/adr/0006-no-flythings-network-managers.md)。
- **体积上限 1.2 MB。** 包会被推进 tmpfs（即内存），36 MB 的机器上未 strip 的 .so
  曾经把设备直接 OOM 重启。最初的 600 KB 是设计目标而非硬件上限：arcade 在真机上是
  1,766,760 字节、音乐固件 1,840,452 字节，而声音本身要 ~438 KB。这个上限仍拦得住真正
  要命的那次失手——把整条 ffmpeg 解码路径链进来，实测约 1.9 MB。

三个固件共用同一个构建目录，因此 `BUILD_DIR` 按 app 隔离——否则切换 `APP` 而不
`make clean` 会把上一个 app 的 .o 静默链进来：能编、能加载、跑的是另一个固件。

## 侧载与恢复

侧载全程只写 tmpfs，闪存一次都不碰。**断电即恢复官方固件**：`/tmp` 被清空，
框架回落到 `/res/etc/EasyUI.cfg`，官方 app 连同它自带的 WiFi 配置网页一起回来。
这是这套固件出任何问题时的通用救砖手段，也正是固化（写 `/res`）会删掉的那张安全网
（[ADR 0006](../../docs/adr/0006-no-flythings-network-managers.md)）。

服务端走与另外两套固件同一个参数化安装器（`/api/os/device-app/*`，确认口令
`START_TC002_OS_SESSION`，ADR 0004）；控制台目前还没有 ZOS 的侧载面板，这四条路由要自己调。

比另外两套多一步：**包里要放一个 `host` 文件写上控制台地址**。局域网里没有任何东西会广播
这个服务——它是某台笔记本上的一个 Bun 进程，不是有名字的路由器服务，所以只能告诉它。
启动脚本把它移到 `/tmp/zos-host`，固件启动时读（也接受 push 后原地的 `/tmp/tc002-os/host`），
三种写法都认：`http://192.168.8.185:43820`、`192.168.8.185:43820`、`192.168.8.185`
（后两种分别补 `http://` 和 `:43820`）。文件缺失不是错误：固件照常独立运行，只是没有频道
也没有镜像——启动脚本对它的搬移带条件判断，否则 `set -e` 会把「没配控制台」变成一次失败
的启动和一块黑屏。

## WiFi 与配网

替换官方 app 就等于删掉它的 `/settings/*` 网页，包括自带的 WiFi 配置页，所以这套固件必须
自带一条配网路径。目前：

- **已经能用**：固件自带 HTTP 服务，在**设备正常地址的 8080 端口**提供配网页——`GET /`
  页面（完全自包含，无 CDN / 无 web 字体 / 无外部样式表）、`GET /scan`（wpa_supplicant 控制
  套接字的 `SCAN_RESULTS`，即上一次扫描的缓存，读它不会触发新扫描；按信号排序去重）、
  `GET /status`、`POST /connect`。设置页里能看到这个地址。选 8080 不选 80，是因为绑特权
  端口要求那一刻还是 root。服务跑在自己的线程上，`serveOnce` 阻塞对 25fps 的 UI tick 不能接受。
- **故意还没通**：真正改变链路的那一半锁在守卫文件 `/tmp/zos-allow-link` 后面。执行器
  （`platform/DeviceWifi.h`）沿这条线一刀切开——只读的一半永远可用，会改变的一半（拉起
  supplicant、关联、请求 DHCP、起停热点、发起扫描）现查守卫文件，不存在就拒绝；配网页的
  提交同样，并在**拒绝的当下**回报 `link-locked`，而不是先假装成功。安装器不创建这个文件，
  所以正常安装下这段代码编进去了、UI 能走到、物理上不做事。
  `adb shell touch /tmp/zos-allow-link` 武装一次实验，断电自动解除。
- **还没实现**：热点（SoftAP）。`startSoftAp()` / `stopSoftAp()` 目前只写一行日志就返回；
  配方是知道的（停 wpa_supplicant、写 hostapd.conf、起 hostapd、发地址），但每一步都动 adb
  所骑的那条链路，而 `SoftApManager` 正是 ADR 0006 禁止链接的东西。因此**一台没有存储凭据
  的设备现在还不能由 ZOS 自己配网**；`docs/design/tc002-os-provisioning.md` 那套四屏热点
  流程仍是设计。

`wpa_supplicant` 在 `/etc/init.rc` 里是 `disabled` + `oneshot`：开机没人拉它，它死了 init
也不重启。官方 app 通过 `libzknet` 干这件事，我们顶替了它，这份责任就是我们的——
`WifiPolicy` 负责 `ctl.start`、轮询 `init.svc.wpa_supplicant`、进程消失就重启，并把重启次数
报给设置页。关联本身不带地址，因此每次连上都要显式请求一次 DHCP 租约，且必须异步发出：
`NetUtils::dhcpRequestIp` 会阻塞数秒，内联调用会把整块面板冻住一次租约协商那么久。

## 固化到 flash

侧载是临时的：断电即回官方固件。固化把 ZOS 写进 `mtd3 res`，重启后仍在。

### 打包

```bash
mise run os-image            # → .runtime/tc002-os/update.img
mise run os-restore-image    # → .runtime/tc002-stock/restore-live.img（还原点）
```

容器格式是 `ZKSWEV1.0` 头 + squashfs 载荷，**没有签名**——只有一个覆盖 `file[0:568]`
的 CRC-32 和一个内嵌 MD5，两者都由打包器重算。`os-image` 每次先把库存
`update.img` 逐字节重建一遍，不一致就拒绝出包；572 字节头部无一字节抄自原文件
（含那 509 字节填充，实为 MSVC `rand()`、种子 `0x14e4a39e`）。没有这道关卡，
刷进去的就是一个猜测。

### 安装（官方流程，逐字取自 `IDE使用说明/说明文档.md`）

```bash
adb push ./update.img /tmp/update.img
adb shell setprop sys.zkupgrade.flag 255
adb shell setprop sys.zkupgrade.dir /tmp
adb shell setprop ctl.restart zkswe
```

驱动升级的是**框架**不是应用：`/bin/zkgui`（即 `service zkswe`）链接
`libzkupgrade.so`，`libeasyui.so` 导入全套 `zk_upgrade_*` 并持有 `UpgradeMonitor`。
应用的 `libzkgui.so` 里没有 `UpgradeActivity` 并不说明这条链是死的——它在应用之上，
所以换掉应用不会换掉它。另一条路（`zkdaemon` → `/bin/zkupgradebin`）**确实是死的**，
那个二进制在本机不存在。

### 为什么刷 `res` 拿不走 adb

这是动手前唯一需要相信的事，它有两条独立证据：

1. **分区隔离**。`/bin/zkgui`、`/lib/libeasyui.so`、`/lib/libzknet.so`、
   `/bin/wpa_supplicant`、`/bin/adbd` 全部位于 `/`（`mtd2 rootfs`，squashfs 只读）；
   WiFi 凭据在 `/data`（`mtd6`）。刷 `mtd3` 一个都碰不到。
2. **启动顺序**。`/bin/zkgui` 的 `main` 里，`NetManager::start()` 在
   `EasyUIContext::initEasyUI()` **之前**（0x10f94 对 0x10f9c，连续指令、中间无分支），
   而应用的 `.so` 是 `initEasyUI` 才加载的。所以即使 `/res` 完全损坏，网络照样起来。

因此一次失败的刷写最坏是「面板不亮但 adb 还在」，可以再刷一次。

### 恢复

**没有 recovery 分区**（`/proc/mtd` 里 BOOT0/KERNEL/rootfs/res/config/MISC/data/UDISK，
无 A/B 对），**也没有 TF 卡通道**（`mmc0` 上挂的是 aic8800 WiFi 的 SDIO 功能
`mmc0:a9b3:1/2`，不是卡槽），USB 也不行（官方文档：带 Wi-Fi 的机型 USB 连接无效）。

Ulanzi 不提供可下载的 TC002 固件包，所以唯一的还原源是从本机取下的副本。设备
UDISK 上那份 `update.img` 比机器实际运行的版本**旧**，拿它「恢复」是静默降级；
`mise run os-restore-image` 从**现役** `/res` 打包，才是真正的还原点。

> **切勿按住任何按键超过 5 秒。** `/bin/zkdaemon` 的按键线程在 5000 ms 后执行
> `rm -rf /data/*`，会连同 WiFi 凭据一起删除，把设备推进「无网 + 无 adb」——
> 那不是恢复键。
