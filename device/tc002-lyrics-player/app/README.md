# TC002 Pixel Music — native lyrics player app

A FlyThings native app for the TC002, cross-compiled headlessly (see
`../flythings-build/`) and sideloaded to `/tmp` non-persistently — no flashing,
power-cycle restores the official firmware.

## What runs today (verified on real hardware)

- **Boot splash** (`pages/SplashPage`): ~2.4s 52×16 animation — spectrum bars
  rise, a note icon blooms, the "MUSIC" wordmark fades in.
- **Lyrics page** (`pages/LyricsPage`): a scrolling, karaoke-highlighted lyric
  line (sung / current / upcoming tiers) with a top progress cursor and a
  bottom play/track cursor. Lines are **built-in ASCII demo text** for now.
- **Keys** (`logic/lyricsLogic.cc`): middle = play/pause, left/right = prev/next
  line, rotary = cycle the 4 skins (signal/tape/blueprint/arcade), matching web.

## Structure

- `src/Main.cpp` — `onStartupApp` → `lyricsActivity`.
- `src/activity/lyricsActivity.*` — IDE-style activity (includes the logic .cc).
- `src/logic/lyricsLogic.cc` — page registration, tick loop, key dispatch.
- `src/pages/{SplashPage,LyricsPage}.*` — the two pages; draw via
  `Surface`+`sendLedData`.
- `src/visual/{Palette,PixelFont,Spectrum,Icons}.h` — skins, 3×5 ASCII font,
  pseudo-spectrum, note icon (mirrors the web preview's design).
- Reused device infra from pixel-pet: `PageBase`, `Surface`, `McuManager`,
  `KeyManager`, `PageManager`, `uart/*`, `mcuProtocol/*`.

Build & sideload: `../flythings-build/` (`make APP=/app`, then push to `/tmp` +
`EasyUI.cfg` + `ctl.restart zkswe`).

## Capabilities now working on real hardware

- **LED display** — `Surface` + `sendLedData` (splash, lyrics, volume cup).
- **Keys** — middle play/pause, left/right skip, knob turn = volume, knob press =
  skin.
- **Audio** — `AudioManager::playAudio(localPath)` through MI_AO, verified with a
  1KHz tone. Chain: `audio-utility` → `base-json` → `ffmpeg` → `z` → device
  `libmi_ao`. Volume 0–6 via the boba-cup overlay (`pages/VolumePage`).
- **HTTP** — `net/NetClient` (`downloadFile` / `httpGet`) over `base-http-client`
  → `curl` (static, built-in resolver) + device `libssl`/`libcrypto`.

## Next stage — wire it together (LAN service integration)

1. **Service endpoints** (Pixel Studio `control-api`): device-facing routes for
   the current track (audio URL + duration + play state) and its lyric frames.
2. **Device fetch loop**: a background thread polls state, `downloadFile`s the
   audio to `/tmp`, `playAudio`s it, and pulls pre-rendered 52×16 CJK lyric
   frames (service renders the 4 modes + Fusion Pixel font — no on-device CJK
   font), synced to playback position.
3. **Polish**: connecting/empty/error states, endurance + restore tests.

All four device capabilities above are proven; this stage is integration +
on-device iteration.
