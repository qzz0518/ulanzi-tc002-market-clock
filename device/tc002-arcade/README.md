# TC002 游戏固件（tc002-arcade，非持久化侧载）

Pixel Studio「游戏」页面对应的 **TC002 原生街机固件**：FlyThings SDK 编写、交叉编译为
`libzkgui.so`，在 52×16 LED 点阵上跑开机动画、卡带式游戏菜单、设备信息页与七款
旋钮+按键游戏（打砖块 / Flappy / 贪吃蛇 / Pong / 赛车 / 射击 / 俄罗斯方块），带低延迟

与音乐固件（`device/tc002-lyrics-player/`）互为**平级侧载 App**：同一 `/tmp` 加载路径、
同一恢复语义（断电或「恢复官方固件」即回到官方系统，flash 从不写入），两者互斥、
由入口脚本写入 `/tmp/tc002-sideload.id` 区分会话（ADR 0004）。菜单与信息页纯 ASCII
（3×5 PixelFont + 6×12 LatinFont），不带 CJK 字库。

## 按键说明

| 场景 | 旋钮转 | 旋钮按 | 左键 | 中键 | 右键 |
|---|---|---|---|---|---|
| 开机动画 | — | 跳过 | 跳过 | 跳过 | 跳过 |
| 菜单 | 选择卡带 | 进入 | 信息页 | 进入 | 信息页 |
| 信息页 | 音量 0-6（实时生效，tick 试音） | 返回 | 返回 | 翻屏 | 关机确认（3s 内再按一次执行 MCU 关机） |
| 打砖块 | 挡板移动（连转加速） | 发球/暂停 | 挡板左 | 发球/暂停 | 挡板右 |
| Flappy | — | 跳 | 跳 | 跳 | 跳 |
| 贪吃蛇 | 逆/顺时针=左/右转向 | 暂停 | 左转 | 暂停 | 右转 |
| Pong | 左板上/下 | 发球/暂停 | 板上 | 发球/暂停 | 板下 |
| 赛车 | 逆/顺时针=上/下换道 | 开始/重开 | 上换道 | 开始/重开 | 下换道 |
| 射击 | 飞船上/下（连转加速） | 射击（可按住连发）/开始 | 飞船上（按住） | 射击（可按住连发）/开始 | 飞船下（按住） |
| 俄罗斯方块 | 方块上/下平移 | 旋转/开始 | 软降（按住） | 旋转/开始 | 硬降 |
| 结算画面 | — | 重开 | 回菜单 | 重开 | — |
| 游戏内通用 | | **长按中键 1.2s 回菜单**（顶部显示进度条） | | | |

菜单为 8 格卡带（七游戏 + INFO），底部 y=15 一排页码点指示当前位置，游戏名超宽时
时后台逐游戏拉取，失败静默）。

信息页轮播两屏：电量原始值（MCU 0x03 语义未定，按 `BAT a/b` 裸值显示）、USB、音量、
运行时长；固件/MCU 版本与 IP。旋钮转动直接调音量（0-6 档，当帧生效并播 tick 试音，
仅本次会话保持），中键在两屏间手动切换。

## 音效

`app/sfx/` 内五个 16kHz 单声道 s16 WAV（boot / tick / confirm / score / over，均 <30KB），
由 `tools/gen-sfx.sh` 用 ffmpeg 方波表达式合成，启动时整段预载进内存、触发时直灌
`base::AudioPlayer` 多实例混音，无解码路径，预期延迟 10–30ms。重新生成：

```bash
device/tc002-arcade/tools/gen-sfx.sh   # 本机需要 ffmpeg
```

## 构建（共享音乐固件的 flythings-build，零复制）

工具链、依赖包与 Docker 镜像全部复用音乐固件的
[flythings-build](../tc002-lyrics-player/flythings-build/README.md)（先按其说明完成
`fetch-deps.sh` 与 `docker build`）。Makefile 的 `APP`/`OUT` 是可覆盖变量，挂载整个
`device/` 让两工程互见即可（仓库根目录执行）：

```bash
docker run --rm --platform linux/amd64 -v "$PWD/device":/work \
  -w /work/tc002-lyrics-player/flythings-build flythings-build \
  make APP=../../tc002-arcade/app OUT=libzkgui-arcade.so
# → device/tc002-lyrics-player/flythings-build/libzkgui-arcade.so（ELF32 ARM，已 strip）
```

`-D__PLATFORM_Z21__` 与 strip 的必要性同音乐固件（不 strip 会把 36MB 内存的设备推到
OOM）。`logic/*.cc` 不是编译单元（被 activity `#include`），新翻译单元一律 `.cpp`。

## 打包与发布

固件包 = 入口脚本 + 改名后的 `.so` + `EasyUI.cfg` + `ui/` + `sfx/`（仓库根目录执行）：

```bash
STAGE=$(mktemp -d)
cp device/tc002-arcade/sideload/player                              "$STAGE/"
cp device/tc002-lyrics-player/flythings-build/libzkgui-arcade.so    "$STAGE/libzkgui.so"
cp device/tc002-arcade/EasyUI.cfg                                   "$STAGE/"
cp -R device/tc002-arcade/app/ui                                    "$STAGE/ui"
cp -R device/tc002-arcade/app/sfx                                   "$STAGE/sfx"
bun run arcade-release -- "$STAGE" 0.2.0 player
```

生成 `release/bundle/` 与逐文件 SHA-256 的 `manifest.json`（schema v3，生成物不入库）。
之后在网页「游戏」页 → 游戏固件面板走三重确认侧载；installer 会把本机服务地址写到
设备 `/tmp/tc002-arcade/service.origin`，固件启动时读取。入口脚本把 `.so`/`ui`/
`EasyUI.cfg` 移进 `/tmp`，`sfx/` 留在 `/tmp/tc002-arcade/` 原地供固件预载，最后写
`/tmp/tc002-sideload.id` 并拉起 `zkswe`（设备 busybox 无 `sleep`，脚本不驻留）。

## 与服务端的协议

- **心跳**：每 5s `POST /api/arcade/heartbeat`
  `{"game":"menu|breakout|flappy|snake|pong|racer|shooter|tetris","phase":"...","score":N,"uptimeMs":N}`，
  网页据此显示「游戏固件在线」与当前局面。
- 全部为裸 socket HTTP/1.0 fire-and-forget（`net/NetClient`），阻塞都在后台线程。

## 恢复

同音乐固件：网页面板「恢复官方固件」、直接断电重启、或异常时按住 USB-C 旁复位键再
上电，三者都不动 flash。侧载安全细节与真机约束见
[ADR 0002](../../docs/adr/0002-native-music-player-boundary.md)、
[ADR 0004](../../docs/adr/0004-arcade-firmware.md) 与设计文档
[docs/design/arcade-firmware.md](../../docs/design/arcade-firmware.md)。
