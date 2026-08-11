# TC002 OS — 替换官方固件的系统固件

面向 Ulanzi TC002（52×16 RGB LED）的完整系统固件：一页一项的旋钮式菜单、
自带 WiFi 配网、频道 / 音乐 / 游戏 / 设置统一入口，以及可从 Pixel Studio 控制台
直接控制与实时镜像的设备画面。

与已有的两套侧载固件（`../tc002-lyrics-player` 音乐播放器、`../tc002-arcade` 游戏厅）
互斥共存，共用同一条 `/tmp` 加载路径与 `/tmp/tc002-sideload.id` 会话标识（ADR 0004）。

> **当前进度：里程碑 1（骨架 + 首帧）**。开机动画已能在 Mac 上逐像素断言，
> 交叉构建产物为 194 KB 的 ELF32-ARM，NEEDED 集合与真机跑通的 arcade 固件完全一致。
> 尚未接入：字体、Shell / 菜单、网络、WiFi 配网。

## 唯一的架构铁律

**Screen 只往 Surface 里画，永远不碰 SPI；全工程只有 `core/Presenter` 写 LED 总线。**

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
app/src/core/     Surface, Presenter, Ease      ← Presenter 是唯一的设备侧
app/src/ui/       Screen 接口, BootScreen        ← 全部 host 可编译
app/src/managers/ KeyManager, McuManager        ← 沿用 arcade 已验证实现
app/src/uart/     串口 / MCU 协议                ← 同上
app/src/activity/ FlyThings Activity 外壳        ← 精简版，无 ZK 控件
app/src/logic/    osLogic.cc                    ← 渲染循环，被 activity include
hostcheck/        selfcheck.cpp, link-audit.sh
sideload/os       侧载启动脚本
```

## 输入

旋钮顺时针 / 逆时针，加旋钮键（`0x67`）与左 / 中 / 右三键（`0x6C` / `0x69` / `0x6A`）。
`KeyManager` 在自己的事件线程上回调，`osLogic.cc` 只入队，UI tick 再取出——
屏幕状态只在一个线程上变更。

## 构建与验证

```bash
mise run os-hostcheck    # clang++ 编译 UI 并断言像素，不需要设备
mise run os-build        # Docker 交叉编译 → libzkgui-os.so（ELF32 ARM，已 strip）
mise run os-linkaudit    # 链接审计，见下
```

`os-linkaudit` 拦的是唯一一种「推上去才发现」的故障：加载器对缺符号只会报一句
`initLib error: undefined symbol`，面板全黑，不告诉你缺哪个库哪个符号。它做三件事：

- **NEEDED 必须是可满足集合的子集。** 基准取 `libzkgui-arcade.so`——那个固件在真机上
  跑通过，它的 NEEDED 集合是经验上成立的。设备内存映射（`device-dump/maps-baseline.txt`）
  只用来扩大集合，不单独作为判据：它反映的是官方 app **加载过**什么，而不是设备上
  **有**什么（`libzkmedia` 就是存在但未被官方 app 加载的例子）。
- **零个未定义的 `av_*` / `sws_*` / `swr_*` 符号。** 链了 audio-utility 却没有 ffmpeg
  会留下约 38 个未定义符号，而设备根本不带 `libav*`。
- **体积上限 600 KB。** 包会被推进 tmpfs（即内存），36 MB 的机器上未 strip 的 .so
  曾经把设备直接 OOM 重启。

三个固件共用同一个构建目录，因此 `BUILD_DIR` 按 app 隔离——否则切换 `APP` 而不
`make clean` 会把上一个 app 的 .o 静默链进来：能编、能加载、跑的是另一个固件。

## 侧载与恢复

侧载全程只写 tmpfs，闪存一次都不碰。**断电即恢复官方固件**：`/tmp` 被清空，
框架回落到 `/res/etc/EasyUI.cfg`，官方 app 连同它自带的 WiFi 配置网页一起回来。
这是这套固件出任何问题时的通用救砖手段，也正是固化（写 `/res`）会删掉的那张安全网。
