# TC002 音乐歌词固件（非持久化旁载播放器）

这是 Pixel Studio「音乐」页面对应的 **TC002 原生设备应用**：一个用 FlyThings
SDK 编写、交叉编译为 `libzkgui.so` 的 C++ 播放器。它在真机上完成网络音频下载、
扬声器播放、进度跳转，并直接驱动 52×16 LED 点阵渲染四种歌词主题——中文、日文、
英文歌词都用离线光栅化的 12×12 像素字模绘制，设备端不携带任何 TTF 或字体渲染器。

部署模型是**非持久化旁载（Path A）**：TC002 平时始终运行官方固件；调试会话把
播放器推到设备内存盘（tmpfs）临时运行，结束会话或断电重启即自动回到官方固件，
**flash 从不被写入**。已在真机端到端验证。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 原生音频播放 | 服务端代理网易云音频 → 设备下载到 `/tmp/track.mp3` → `base::MediaPlayer` 播放，支持毫秒级 `seekTo` |
| 四种歌词主题 | 走带（整字格变速横移）/ 天际（频谱同屏）/ 聚光（焦点居中滑动）/ 升降（整句升降），与网页预览同算法 |
| 四套配色 + 自定义主色 | 信号绿 / 磁带橙 / 蓝晒 / 街机红；网页可再覆盖一个十六进制主色（`ACCENT`） |
| 中日英字模 | Fusion Pixel 12px 离线光栅化：GB2312 一级汉字 + 平假名/片假名（含 ー、・）+ JIS X 0208 一级汉字 + 全角标点，共约 5200 个 12×12 字形，二分查找；ASCII 用 6×12 半宽字模 |
| 双向实时同步 | 网页选歌/播放/暂停/换主题/拖进度 → 设备 2 秒内应用；设备按键操作 → 心跳/上报回流网页，预览时钟跟随真机播放头 |
| 实体按键 | 中键：播放/暂停；左右键：上一句/下一句歌词（音频同步跳转）；旋钮旋转：调音量（0–6，弹出音量气泡）；旋钮按下：循环切换显示形式 |
| 开机与加载动画 | 频谱扫光开机动画；换曲下载期间显示「加载中」呼吸频谱 |

## 目录结构

```text
device/tc002-lyrics-player/
├── app/                  # FlyThings 应用源码（编译进 libzkgui.so）
│   ├── src/activity/     # IDE 形态的 Activity 入口（#include logic/*.cc）
│   ├── src/logic/        # lyricsLogic.cc：轮询/心跳线程、按键映射、状态应用
│   ├── src/pages/        # LyricsPage（四主题渲染）、SplashPage、VolumePage 等
│   ├── src/managers/     # AudioManager（play/pause/seek）、KeyManager、McuManager
│   ├── src/visual/       # CjkFont.h / LatinFont.h（生成物）、调色板、图标、频谱
│   └── ui/               # FlyThings 资源目录（随旁载一起推送）
├── core/                 # 与 FlyThings 无关的歌词时间轴/版式核心（可在主机用 C++11 自测）
├── tools/gen-fonts.py    # 离线字体光栅化器：woff2 → CjkFont.h + LatinFont.h
├── flythings-build/      # 无 IDE 的 Docker 交叉编译环境（见其 README）
├── flythings-overlay/    # 合入官方 Z21 Demo 工程所需的依赖清单
├── release/              # 发布产物区：bundle/ + manifest.json（由工具生成，已 gitignore）
└── probe/                # 纯 shell 设备探针，验证旁载链路并采集真机情报
```

## 与服务端的协议

固件用一个常驻后台线程完成全部同步。HTTP 是刻意最小化的**裸 socket
HTTP/1.0**（`app/src/net/NetClient.cpp`，不依赖 curl/openssl，只用 libc
socket）。每轮循环先拉状态、再发心跳，然后 `sleep(2)`：

1. **控制轮询**（每 2s）：`GET /api/music/device/state`，纯文本 `KEY\tVALUE`：

   | 字段 | 含义 |
   | --- | --- |
   | `SEQ` | 控制序列号；仅当变化时应用下面的字段 |
   | `TID` | 当前曲目 ID；变化时触发下载 `/api/music/device/audio` 与歌词 |
   | `PLAY` | `1/0` 播放或暂停 |
   | `MODE` | `ticker/skyline/spotlight/cascade` 显示形式 |
   | `SKIN` | `signal/tape/blueprint/arcade` 配色 |
   | `ACCENT` | 覆盖主色的 `rrggbb`，`-` 表示跟随配色 |
   | `SEEK` | 目标毫秒；固件按值去重，服务端换曲时重置为 `-1` |

2. **心跳上报**（同一轮询循环内、选定曲目后开始）：
   `POST /api/music/device/heartbeat`，上报 `trackId / playheadMs / playing`。
   注意固件在收到第一个曲目（`TID` 不为 `-`）之前不发心跳，此前网页不会显示
   「音乐固件在线」。上线后网页按 10 秒窗口判定在线（覆盖换曲时 5–7 秒的阻塞
   下载），并把预览动画锚定到真机播放头。

改变共享状态的按键会通过 `POST /api/music/device/report` 即时回传（中键的
播放/暂停、旋钮按下的主题切换）；左右键跳句不单独上报，由下一次心跳的
`playheadMs` 回流到网页，音量属于设备本地状态、不回传。

> **服务器地址是编译期常量**：`app/src/logic/lyricsLogic.cc` 中的
> `PIXEL_STUDIO_ORIGIN` 默认使用不可直接连接的占位主机
> `http://PIXEL_STUDIO_HOST:43820`。编译前把这一处替换为运行 Pixel Studio
> 的局域网地址；换局域网环境后重新编译即可。

## 字体管线

```bash
python3 tools/gen-fonts.py   # 需要 fontTools + brotli + Pillow
```

从 `@fontsource/fusion-pixel-12px-monospaced-sc` 的 woff2 离线光栅化生成
`app/src/visual/CjkFont.h`（全宽 12×12，按码点严格升序，运行期二分查找）和
`LatinFont.h`（半宽 6×12，ASCII 连续存储 O(1) 索引）。位图约定与
`LyricsPage.cpp` 一致：CJK 每行一个 12 位掩码、bit11 为最左列；Latin 每行只用
低 6 位、bit5 为最左列。字体许可见仓库根 `THIRD_PARTY_NOTICES.md`。

## 构建

无需 Windows/FlyThings IDE，Docker 交叉编译（amd64 容器，Apple Silicon 下自动
模拟）。工具链与 z21 依赖包的获取、Makefile 还原细节见
[flythings-build/README.md](flythings-build/README.md)。

```bash
cd device/tc002-lyrics-player/flythings-build
./fetch-deps.sh                     # 工具链 + z21 依赖包（一次性）
docker build --platform linux/amd64 -t flythings-build .
docker run --rm --platform linux/amd64 \
  -v "$PWD/..":/work -w /work/flythings-build flythings-build make
# → libzkgui.so（ELF32 ARM，已 strip）
```

两个不能省的构建事实：

- `-D__PLATFORM_Z21__` 必须定义，否则依赖头里 `base::function` 落到 boost
  签名，加载时报 `undefined symbol`。
- 产物**必须 strip**（Makefile 已内置）：未 strip 的 `.so` 约 6.7MB，会把
  36MB 内存的设备直接挤到 OOM 重启；strip 后约 1.8MB。

## 旁载部署与恢复

两条部署路径服务不同目的：

- **网页「设备与固件」面板的调试会话**：推送经清单校验的 `release/bundle/`
  到 `/tmp/tc002-music` 并执行其入口（`ctl.stop zkswe` 暂停官方界面）。适合
  跑独立可执行产物（当前 staged 的是传输链路探针）。
- **FlyThings 播放器（本目录的主角）走框架加载路径**，开发期直接 adb 操作：

```bash
adb connect <device-ip>:5555
adb shell rm -f /tmp/track.mp3          # 关键：tmpfs 很小，先清旧音频再推新 .so，
                                        # 否则 adbd 会在推送中途卡死（显示 online 但 shell 报 error:closed）
adb push flythings-build/libzkgui.so /tmp/libzkgui.so
adb push app/ui /tmp/ui
adb push flythings-build/EasyUI.cfg /tmp/EasyUI.cfg   # startupLibPath=/tmp/libzkgui.so
adb shell 'setprop ctl.restart zkswe'   # 框架从 /tmp 加载播放器
```

恢复官方固件（任选其一，都不会动 flash）：

1. 网页面板点「结束会话」；
2. 直接断电重启（tmpfs 清空，自动恢复）；
3. 仍异常时断电后按住 USB-C 旁的复位按钮再上电。恢复后应复查 Wi-Fi、时区、
   亮度、音量与自定义内容。

## 发布产物

```bash
bun run music-release -- /path/to/bundle-source-dir 0.1.0 [entry]
```

把指定目录（你整理好的构建产物）复制为 `release/bundle/` 并生成逐文件
SHA-256 的 `manifest.json`（schema v3，源目录与 semver 版本为必填参数）。
网页端只有在旁载包与清单完全一致、官方 HTTP 接口与 Wi-Fi ADB 双重确认是
真机、且用户勾选「知道如何恢复」之后才允许启动会话。`bundle/` 与
`manifest.json` 是生成物，不入库。

## 主机自测

不装工具链也能检查核心层：

```bash
c++ -std=c++11 -Wall -Wextra -Werror \
  -I device/tc002-lyrics-player/core/include \
  device/tc002-lyrics-player/core/src/LyricTimeline.cpp \
  device/tc002-lyrics-player/core/src/PixelLyricLayout.cpp \
  device/tc002-lyrics-player/core/test/host-check.cpp \
  -o /tmp/tc002-music-core-check && /tmp/tc002-music-core-check
```

## 边界与已知约束

- **非持久化是有意设计**：不做 `update.img` 固化，官方固件永远是断电后的
  默认状态；`/tmp` 即 RAM，所有旁载内容随断电消失。
- 内存约束严格（36MB，含系统）：推送顺序、strip、音频文件大小都受它约束。
- 设备无 `grep/tail/tar`（精简 busybox）：排障时把 `logcat -d` 全量拉回主机再过滤。
- 音频能否播放仍受网易云账号、会员、版权与地区限制；服务端代理不绕过任何限制。
- 「设备同屏」（不旁载、走官方固件 Custom App 通道推 GIF 帧）依然可用，但受
  官方通道的帧数/帧率上限约束；原生固件模式才是完整体验。
- 架构边界（网页/服务端/固件各自负责什么）见
  [ADR 0002](../../docs/adr/0002-native-music-player-boundary.md)；真机探针
  情报见 [docs/research/tc002-device-probe.md](../../docs/research/tc002-device-probe.md)；
  无 IDE 构建路径的考古记录见
  [docs/research/flythings-build-path.md](../../docs/research/flythings-build-path.md)。
