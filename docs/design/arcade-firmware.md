# TC002 游戏固件(tc002-arcade)设计

> **历史设计。** 该固件已于 2026-09-09 退役（[ADR 0014](../adr/0014-two-tiers-official-and-zos.md)）：
> 七款引擎原样搬入 `device/tc002-os/app/src/games/`，由 `mise run os-build` 编进 ZOS，
> 自检由 `mise run os-hostcheck` 运行；侧载的游戏 App、`/api/arcade/*` 与「游戏固件」面板已删除。
> 下文按当时的设计原样保留。

- 状态:已退役(原「定稿,实施中」)
- 日期:2026-08-10
- 设计:Claude Fable(基于三线调研:音乐固件复用盘点 / MCU 电量与音效路径 / 侧载栈泛化面)

## 1. 定位与总体

独立侧载 App `device/tc002-arcade/`,与音乐固件并列:同一 zkswe 独占、tmpfs 非持久化、
断电即恢复官方固件、三重确认侧载。包含:开机动画、游戏选择菜单、设备信息页(电量/USB/
版本/IP/音量/uptime)、七款旋钮+按键游戏(打砖块/Flappy/贪吃蛇/Pong 四款网页直译,
Racer/Shooter/Tetris 三款固件原生)、低延迟游戏音效、运行心跳,以及网页控制台的
「游戏固件」面板。

菜单与信息页用 ASCII(3×5 PixelFont + 6×12 LatinFont),**不带 CjkFont**(省 ~145KB rodata)。

## 2. 固件工程(device/tc002-arcade/)

### 2.1 结构与复用(按调研盘点执行)

- **原样复制**:KeyManager、PageManager、McuManager、AudioManager、mcuProtoParse、uart/ 全套
  (Main.cpp 的 onEasyUIDeinit 依赖,不可删)、PageBase、NetClient、Palette.h、PixelFont.h、
  LatinFont.h、Spectrum.h(菜单背景动效备用)、EasyUI.cfg、Dockerfile/fetch-deps.sh 不复制
  (共享 `device/flythings-build/`,见 2.8)。
- **修复后复制**:`utils/Surface.{h,cpp}` —— `fill()` 的 `i*4` 改 `i*3`(堆越界写);补上
  `getPixel` 实现(头文件声明了但 cpp 缺失,链接期才炸)。
- **改造**:Main.cpp(`onStartupApp` → `"arcadeActivity"`)、activity 壳五处同改(类名/
  REGISTER_ACTIVITY/getAppName→`"arcade.ftu"`/`#include "logic/arcadeLogic.cc"`/触摸回调名
  `onarcadeActivityTouchEvent`)、`app/ui/arcade.ftu` = `lyrics.ftu` 改名复制(162B 空白窗口
  占位,六份全同已验证,无需 IDE)。
- **不要**:LyricsPage、CjkFont.h、LyricModes.h、Icons.h、core/、.project/.cproject 等 IDE 元数据。

### 2.2 状态机与主循环(arcadeLogic.cc,骨架照抄 lyricsLogic)

```
STATE_SPLASH → STATE_MENU ⇄ STATE_INFO
             → STATE_GAME(当前游戏由 MenuPage 选定)
```
- `onUI_init`:幂等保护 → sys.zkapp.state → McuManager 初始化(/dev/ttyS1 1.5Mbps)→
  注册 splash/menu/info/game 四页 → SfxManager 预载音效 → KeyManager.start()。
- `onUI_show`:注册 TIMER_TICK 40ms(splash)→ 进 MENU/GAME 后 `resetUserTimer` 至 30ms
  (33fps;SPI 帧含 15ms 硬 usleep,逻辑预算 ~13ms/帧)。
- tick/draw 分离范式沿用;浮层倒计时常量必须与真实 tick 周期一致(音乐固件 60/30 不一致的
  bug 不复刻)。
- **输入线程边界**:KeyManager 回调在独立线程。arcadeLogic 持一个互斥保护的
  `std::vector<InputEvent>` 队列,回调只 push,UI tick 开头 swap 消费;不在回调里碰页面状态。
  分发统一走 `PageManager::onKeyEvent`(现成空挂点,音乐固件从未用,本固件启用),每页自理输入。

### 2.3 输入映射

| 场景 | 旋钮转 | 旋钮按 | 左键 | 中键 | 右键 |
|---|---|---|---|---|---|
| SPLASH | — | 跳过 | 跳过 | 跳过 | 跳过 |
| MENU | 选择游戏 | 进入 | 信息页 | 进入 | 信息页 |
| INFO | 音量 0-6(实时 setVolume + SFX_TICK 试音,存 logic 会话静态量) | 返回 | 返回 | 翻屏 | 关机确认(二次按确认,MCU 0x10) |
| Breakout | 挡板(1 detent=2px,双向连转 150ms 内加速×2) | 发球/暂停 | 挡板左 | 发球/暂停 | 挡板右 |
| Flappy | — | 跳 | 跳 | 跳 | 跳 |
| Snake | 逆/顺时针=左/右转向 | 暂停 | 逆时针转 | 暂停 | 顺时针转 |
| Pong | 左板上/下 | 发球/暂停 | 板上 | 发球/暂停 | 板下 |
| Racer | 逆/顺时针=上/下换道 | 开始/重开 | 上换道 | 开始/重开 | 下换道 |
| Shooter | 飞船上/下(同向连转加速) | 局中射击(按住连发)/非局中开始 | 上(按住持续) | 同旋钮按;另按下沿由 GamePage 播 SFX_TICK 作射击手感音 | 下(按住持续) |
| Tetris | 方块上/下平移 | 局中旋转/非局中开始 | 软降(按住) | 局中旋转/非局中开始 | 硬降 |
| GAME over | — | 重开 | 回菜单 | 重开 | — |
| GAME 内通用 | | **长按中键 1.2s = 回菜单**(按下沿计时,顶部画进度条;KeyManager 有抬起事件,可测长按) | | | |

### 2.4 页面

- **SplashPage**:约 3s——黑底上 "PIXEL"、"ARCADE" 两段 LatinFont 大字扫光进场 + 四游戏
  8×8 图标依次点亮 + 底部进度条;播 boot 音;任意键跳过。
- **MenuPage**:横向卡带选择:每项 12×12 图标 + 3×5 名字,旋钮滚动带 2 帧缓动,当前项亮框
  (Palette SKIN_ARCADE 街机红),移动播 tick 音;底行 3×5 提示 "PRESS TO PLAY"。
  第 5 项 "INFO"(信息页入口,与左键等效)。
- **InfoPage**:两列 3×5 文本逐行:`BAT`(电量,MCU 0x03 缓存值 + 充电标记;语义未定前显示
  原始字节,格式 `BAT 87% CHG` 或 `BAT x/y raw`)/`USB`/`VER`(固件版本编译期常量 + MCU 版本)/
  `IP`(getifaddrs)/`VOL 0-6`/`UP`(/proc/uptime)。
  **MCU 查询绝不在 UI 线程**:后台线程每 10s 查一次电量/USB 写入缓存(request 同步阻塞最坏
  1.5s),InfoPage 只读缓存;MCU 主动推送(mcuEventCb)同样更新缓存。
- **GamePage**:承载 `GameEngine`,输入事件透传,HUD 与 ready/结算画面由引擎自绘。

### 2.5 游戏引擎(games/engine.h,C++ 契约)

```cpp
struct GameInputEvent {
  enum Kind { KnobCw, KnobCcw, KnobPress, Left, Middle, Right };
  Kind kind; bool down;              // down=false 仅按键抬起;旋钮无抬起
};
struct GameHud { int score; int lives; enum Phase { Ready, Playing, Over } phase; };
class GameEngine {
public:
  virtual ~GameEngine() = default;
  virtual const char* id() const = 0;        // "breakout"|"flappy"|"snake"|"pong"
  virtual const char* title() const = 0;     // "BREAKOUT"
  virtual void reset() = 0;
  virtual void onInput(const GameInputEvent&) = 0;
  virtual void tick(int dtMs) = 0;           // 内部固定步长累积,dt clamp 250ms
  virtual void render(Surface&) = 0;         // 52×16,含 ready/over 画面
  virtual GameHud hud() const = 0;
};
```
前四款从 `web/src/lib/games/*.ts` **直译**(物理参数照抄:速度/反弹角/难度曲线已经真机手感
验证)。输入差异:web 是指针采样,固件是事件驱动——挡板类由事件积分出速度/位置。
后三款(Racer/Shooter/Tetris)无网页对应,按同一 engine.h 契约在设备侧原生实现。
时间数字砖(breakout)用 3×5 PixelFont 排 HH:MM(时间来自 localtime)。

### 2.6 音效(SfxManager,新写)

- 方案:`base::AudioPlayer` 多实例混音 + **启动时预载 PCM**(wav s16 mono 16kHz,bundle 内
  `sfx/*.wav`,单个 <10KB):boot / tick(菜单)/ confirm / score / over 五个。
- 触发:`play()` + `putSamples()` 直灌,预期延迟 10-30ms。
- `base::AudioManager::instance().setIdleTimeout(3000)`(两份调研对 0 的语义解读相反,3000
  在两种解释下都安全;真机听爆音验证)。
- 音量:沿用 0-6 档全局映射;信息页可见当前档;旋钮在菜单页不调音量(避免与选择冲突),
  音量沿用设备既有设置值(getConfig 同步来的官方 volume 不可得——固件内默认 4,后续可加
  菜单项)。

### 2.7 联网(NetClient,全部 fire-and-forget detached 线程)

- 服务地址:`/tmp/tc002-arcade/service.origin`(侧载注入,机制同音乐)。
- **心跳**:每 5s `POST /api/arcade/heartbeat` `{"game":"menu|breakout|...","phase":"...","score":N,"uptimeMs":N}`。
  (服务端 API 现成,限流内)。

### 2.8 构建与打包

- **共享 `device/flythings-build/`**(工具链/packages/device-audio 全复用,零复制;当时它还在
  `tc002-lyrics-player/` 下面,随 ADR 0014 上提到 `device/`):
  `docker run --rm --platform linux/amd64 -v "$PWD/device":/work \
   -w /work/flythings-build flythings-build \
   make APP=../tc002-arcade/app OUT=libzkgui-arcade.so`
  (Makefile 的 APP/OUT 本就是 ?= 可覆盖变量;挂载 device/ 使两工程互见。)
- 保留完整音频链依赖(音效需要);`-D__PLATFORM_Z21__`、`-DLOG_TAG`、strip 步骤一个不动。
- `sideload/player`:BUNDLE=/tmp/tc002-arcade;清理列表含 `/tmp/tc002-sideload.id`;
  **额外写身份文件** `echo tc002-arcade > /tmp/tc002-sideload.id`(见 3.1);busybox 无 sleep
  的约束沿用(脚本不等待)。
- release:`scripts/create-release.ts` 泛化(appId/releaseDirectory 参数),
  `bun run arcade-release -- <stage> <ver> player`;manifest schema v3 不变。

## 3. 服务端(参数化,不复制)

### 3.1 SideloadProfile(installer 泛化)

`tc002-music-installer.ts` → 通用 `Tc002SideloadInstaller` + profile:

```ts
interface SideloadProfile {
  appId: string;             // "tc002-lyrics-player" | "tc002-arcade"
  slug: string;              // remote dir = /tmp/tc002-<slug>
  confirmation: string;      // "START_TC002_MUSIC_SESSION" | "START_TC002_ARCADE_SESSION"
  releaseDirectory: string;
  packagingDoc: string;
  extraCleanupPaths: string[];  // music: ["/tmp/track.mp3"];arcade: []
  copy: { running: string; started: string };
}
```
- **会话身份判别**(修复现存缺口):入口脚本写 `/tmp/tc002-sideload.id`,存活检查加
  `[ "$(cat /tmp/tc002-sideload.id)" = "<appId>" ]`;id 文件加入三处 rm 清单;
  start 的清理阶段同时 `rm -rf /tmp/tc002-music /tmp/tc002-arcade`(双目录,防 tmpfs 残留)。
  音乐固件的 `sideload/player` 同步补写 id 文件(向后兼容:id 缺失时音乐 installer 视为
  自己的旧会话,arcade 视为他人)。
- `MusicInstallerError` 类名保留(control-api 状态码映射依赖)。
- service.ts:两个 installer 实例(profile 不同,verifyClock/serviceOrigin 闭包共享)。

### 3.2 API

- control-api 现有 42 行 device-app 路由抽成 `deviceAppRoutes(prefix, installer)` helper,
  挂 `/api/music/device-app/*` 与 `/api/arcade/device-app/*` 两组(行为完全同构)。
- 新增 `POST /api/arcade/heartbeat`(免同源,调用方是固件;记内存时间戳+最近状态)与
  `GET /api/arcade/status`(同源;返回 `{online, ageMs, game, phase, score}`,
  online = 心跳 age<12s || session.active)。
- docs/reference.md API 表补三行。

## 4. 网页控制台

- 抽 `<FirmwarePanel>` 组件(约 200 行,从 music-player 的状态+动作+Dialog JSX 提取),
  props:`apiPrefix`、`confirmation`、标题文案、`dialogClassName`。音乐页与游戏页共用;
  结构 CSS `.music-deploy*` 段改共享前缀 `.fw-deploy*`(主题变量各自保留)。
- GameShell 顶栏加「游戏固件」按钮(同款 `.music-device-trigger` 交互)开 FirmwarePanel;
  面板内展示 arcade/status(在线时:当前游戏/分数/心跳)。
- `firmwareOnline` 归一(调研方案 A):`musicFirmwareOnline || arcadeOnline` 派生,
  changeView/StudioHeader/GameShell 全走派生量;StudioHeader 状态 Chip 与 tooltip 按
  kind 显示「音乐固件直连/游戏固件直连」;GameShell 固件在线警告文案区分两种固件。
  arcadeOnline 来源:游戏页 10s 轮询 `GET /api/arcade/status`(内存读,零成本)。

## 5. 实施分域

| 阶段 | 任务 | 域 |
|---|---|---|
| P0(主会话手建) | 骨架:目录+15 个复制文件+Surface 修复+Main/activity/ftu/EasyUI.cfg+engine.h 契约 | device/tc002-arcade/** |
| P1 并行 F1(fable max) | arcadeLogic 状态机+Splash/Menu/Info+SfxManager+MCU 缓存线程+心跳/排行上报+sideload/player | device/tc002-arcade/(games/ 除外) |
| P1 并行 F2(fable max) | 四游戏 C++ 直译+GamePage(按 engine.h,对照 web TS 引擎) | device/tc002-arcade/app/src/games/**、pages/GamePage.* |
| P1 并行 S1(fable max) | installer 参数化+身份文件+API helper+heartbeat/status+release 脚本泛化+FirmwarePanel+firmwareOnline 归一+全部测试 | src/、web/、scripts/、test/ |
| P2 | Docker 真机编译跑通+bundle 打包+manifest;全量测试;静态审查 | flythings-build 构建 |
| P3 | 主会话终审;真机侧载由用户执行(三重确认流程) | — |

## 6. 验收

- 自动:全仓 test/typecheck/build 全绿;Docker 交叉编译产出 strip 后 .so(预期 <2MB);
  release manifest 校验通过;installer/panel 单测(fake adb/processRunner,样板
  test/tc002-music-installer.test.ts)。
- 真机(用户,遵守侧载安全流程:先清 /tmp 旧音频、绝不 logcat、异常断电恢复):
  开机动画→菜单手感(旋钮缓动/音效延迟)→四游戏可玩性(重点 breakout 旋钮跟手)→
  信息页电量原始值(回传给我定 0x03 字段语义)→长按回菜单→网页面板侧载/恢复/在线状态→
  与音乐固件互斥切换。
