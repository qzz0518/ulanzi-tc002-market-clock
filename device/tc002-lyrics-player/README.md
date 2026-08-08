# TC002 音乐歌词固件（非持久化侧载播放器）

这是 Pixel Studio「音乐」页面对应的 **TC002 原生设备应用**：一个用 FlyThings
SDK 编写、交叉编译为 `libzkgui.so` 的 C++ 播放器。它在真机上完成网络音频下载、
扬声器播放、进度跳转，并直接驱动 52×16 LED 点阵渲染四种歌词主题——中文、日文、
英文歌词都用离线光栅化的 12×12 像素字模绘制，设备端不携带任何 TTF 或字体渲染器。

部署模型是**非持久化侧载（Path A）**：TC002 平时始终运行官方固件；调试会话把
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
| 开机 / 待机 / 加载 | 六秒五幕开机动画（CRT 扫线 → PIXEL 弹跳 → MUSIC 闪光 → 频谱升起 → 淡出）；未选歌时显示与网页同款「选择歌曲」待机画面；仅换曲下载期间显示「加载中」呼吸频谱 |

## 目录结构

```text
device/tc002-lyrics-player/
├── app/                  # FlyThings 应用源码（编译进 libzkgui.so）
│   ├── src/activity/     # IDE 形态的 Activity 入口（#include logic/*.cc）
│   ├── src/logic/        # lyricsLogic.cc：轮询/心跳线程、按键映射、状态应用
│   ├── src/pages/        # LyricsPage（四主题渲染）、SplashPage、VolumePage 等
│   ├── src/managers/     # AudioManager（play/pause/seek）、KeyManager、McuManager
│   ├── src/visual/       # CjkFont.h / LatinFont.h（生成物）、调色板、图标、频谱
│   └── ui/               # FlyThings 资源目录（随侧载一起推送）
├── app.manifest.json     # 应用元数据：平台、分辨率、依赖包清单
├── core/                 # 与 FlyThings 无关的歌词时间轴/版式核心（可在主机用 C++11 自测）
├── tools/gen-fonts.py    # 离线字体光栅化器：woff2 → CjkFont.h + LatinFont.h
├── flythings-build/      # 无 IDE 的 Docker 交叉编译环境（见其 README）
├── flythings-overlay/    # 合入官方 Z21 Demo 工程所需的依赖清单
├── sideload/             # 网页「侧载固件」的入口脚本（部署到 /tmp 并拉起框架）
├── release/              # 发布产物区：bundle/ + manifest.json（由工具生成，已 gitignore）
└── probe/                # 纯 shell 设备探针，验证侧载链路并采集真机情报
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

   响应还带 `HBAGE` / `FWPOLL` / `DTRACK` / `DPLAY` / `DPLAYING` 五个回报字段，
   固件忽略它们：网页轮询自带 `?viewer=web`，不带该参数的请求被记为固件拉取，
   `FWPOLL`（距上次固件拉取的毫秒数）让网页在选歌前就能感知固件上线；`HBAGE`
   与 `DPLAY` 用于判定在线并把预览锚定到真机播放头。

2. **心跳上报**（同一轮询循环内、选定曲目后开始）：
   `POST /api/music/device/heartbeat`，上报 `trackId / playheadMs / playing`。
   注意固件在收到第一个曲目（`TID` 不为 `-`）之前不发心跳，此前网页不会显示
   「音乐固件在线」。上线后网页按 10 秒窗口判定在线（覆盖换曲时 5–7 秒的阻塞
   下载），并把预览动画锚定到真机播放头。

改变共享状态的按键会通过 `POST /api/music/device/report` 即时回传（中键的
播放/暂停、旋钮按下的主题切换）；左右键跳句不单独上报，由下一次心跳的
`playheadMs` 回流到网页，音量属于设备本地状态、不回传。

> **服务地址在侧载时自动注入**：installer 会把「与时钟同网段的本机地址」写到设备
> `/tmp/tc002-music/service.origin`，固件启动时读取——换网络、换机器都无需重新编译，
> 同一个 `libzkgui.so` 到处能用。读不到该文件时（例如手工 adb 部署）退回编译期默认
> `PIXEL_STUDIO_ORIGIN`（占位 `http://PIXEL_STUDIO_HOST:43820`，手工路径需自行替换后重编译）。

## 字体管线

```bash
python3 tools/gen-fonts.py <完整 SC 字体.woff2>   # 需要 fontTools + brotli + Pillow
```

从 Fusion Pixel 12px 的 woff2 离线光栅化生成 `app/src/visual/CjkFont.h`
（全宽 12×12，按码点严格升序，运行期二分查找）和 `LatinFont.h`（半宽 6×12，
ASCII 连续存储 O(1) 索引）。位图约定与 `LyricsPage.cpp` 一致：CJK 每行一个
12 位掩码、bit11 为最左列；Latin 每行只用低 6 位、bit5 为最左列。

必须传**完整**的简体中文字体（上游 release 下载）。`@fontsource` 的 npm 包
只发布 latin 子集，用它跑生成器会把 5000 多个汉字全部当作「字体里没有」跳过——
脚本现在会直接报错拒绝写出残缺字模。

字模是唯一产物，仓库和构建产物里都不含字体文件。生成后需在仓库根重跑
`bun run scripts/gen-web-glyphs.ts`，把同一份字模同步给网页预览
（`test/pixel-glyphs.test.ts` 会逐位校验两边一致）。字体许可见仓库根
`THIRD_PARTY_NOTICES.md`。

## 构建

无需 Windows/FlyThings IDE，Docker 交叉编译（amd64 容器，Apple Silicon 下自动
模拟）。工具链与 z21 依赖包的获取、Makefile 还原细节见
[flythings-build/README.md](flythings-build/README.md)。

```bash
cd device/tc002-lyrics-player/flythings-build
./fetch-deps.sh                     # 工具链 + 基础依赖包；播放器额外包需手动补齐，见 flythings-build/README.md
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

## 侧载部署与恢复

日常部署直接走网页：音乐页 → 「设备与固件」→ **侧载固件**。按钮背后的完整链路：

1. 逐文件 SHA-256 校验 `release/bundle/`（固件包 = `libzkgui.so` + `ui/` +
   `EasyUI.cfg` + 入口脚本 `player`），并通过官方 HTTP 接口与 Wi-Fi ADB 双重
   确认真机；
2. 先停止旧世界：杀掉上次会话进程并暂停官方界面（`ctl.stop zkswe`）——tmpfs
   上被进程占用的文件删了也不释放空间，必须先停再清；
3. 清光全部残留（含 `/tmp/track.mp3`，不清会在推送中途卡死 adbd），推送固件包
   到 `/tmp/tc002-music`，写入 `service.origin`（本机服务地址，见下方引用块）；
4. 执行入口脚本：把 `.so` / `ui` / `EasyUI.cfg` 移进 `/tmp`、重新拉起系统框架
   （从 `/tmp` 加载播放器）后即退出——设备 busybox 没有 `sleep`，入口不长驻；
   主机等待约 2.5 秒后校验「`/tmp/EasyUI.cfg` 存在且 zkswe 运行中」，这也是
   会话存活的定义，失败会自动删除半部署的配置并拉回官方界面；
5. 「恢复官方固件」= 删光 `/tmp` 里的固件文件后 `ctl.restart zkswe`——框架
   找不到 `/tmp/EasyUI.cfg` 就自动落回官方资源。

开发期也可以手工 adb 走同一条框架加载路径：

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

1. 网页面板点「恢复官方固件」；
2. 直接断电重启（tmpfs 清空，自动恢复）；
3. 仍异常时断电后按住 USB-C 旁的复位按钮再上电。恢复后应复查 Wi-Fi、时区、
   亮度、音量与自定义内容。

## 发布产物

固件包由四样东西组装后打包（在仓库根目录执行）：

```bash
STAGE=$(mktemp -d)
cp device/tc002-lyrics-player/sideload/player             "$STAGE/"
cp device/tc002-lyrics-player/flythings-build/libzkgui.so "$STAGE/"
cp device/tc002-lyrics-player/flythings-build/EasyUI.cfg  "$STAGE/"
cp -R device/tc002-lyrics-player/app/ui                   "$STAGE/ui"
bun run music-release -- "$STAGE" 0.1.0 player
```

把指定目录复制为 `release/bundle/` 并生成逐文件 SHA-256 的 `manifest.json`
（schema v3，源目录与 semver 版本为必填参数）。
网页端只有在固件包与清单完全一致、官方 HTTP 接口与 Wi-Fi ADB 双重确认是
真机、且用户勾选「知道如何恢复」之后才允许侧载。`bundle/` 与
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
  默认状态；`/tmp` 即 RAM，所有侧载内容随断电消失。
- 内存约束严格（36MB，含系统）：推送顺序、strip、音频文件大小都受它约束。
- 设备无 `grep/tail/tar`（精简 busybox）：排障时把 `logcat -d` 全量拉回主机再过滤。
- 音频能否播放仍受网易云账号、会员、版权与地区限制；服务端代理不绕过任何限制。
- 「设备同屏」（不侧载、走官方固件 Custom App 通道推 GIF 帧）依然可用，但受
  官方通道的帧数/帧率上限约束；原生固件模式才是完整体验。
- 架构边界（网页/服务端/固件各自负责什么）见
  [ADR 0002](../../docs/adr/0002-native-music-player-boundary.md)；真机探针
  情报见 [docs/research/tc002-device-probe.md](../../docs/research/tc002-device-probe.md)；
  无 IDE 构建路径的考古记录见
  [docs/research/flythings-build-path.md](../../docs/research/flythings-build-path.md)。
