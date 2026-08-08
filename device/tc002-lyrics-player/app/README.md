# TC002 Pixel Music — native lyrics player app

A FlyThings native app for the TC002, cross-compiled headlessly (see
`../flythings-build/`) and sideloaded to `/tmp` non-persistently — no flashing,
power-cycle restores the official firmware.

## What runs today (verified on real hardware)

- **Boot splash** (`pages/SplashPage`): ~2.4s 52×16 animation — spectrum bars
  rise, a note icon blooms, the "MUSIC" wordmark fades in.
- **Lyrics page** (`pages/LyricsPage`): four display modes (ticker / skyline /
  spotlight / cascade) rendered fully on-device with offline-rasterised Fusion
  Pixel glyphs (`visual/CjkFont.h`, ~5200 12×12 CJK glyphs, plus 6×12 ASCII in
  `LatinFont.h`). Lyrics and audio come from the LAN Pixel Studio service
  (`/api/music/device/now` + `/api/music/device/audio`), downloaded to
  `/tmp/track.mp3` and played through the speaker.
- **Keys** (`logic/lyricsLogic.cc`): middle = play/pause (reported to the
  service), left/right = previous/next lyric line with audio seek, knob turn =
  volume 0–6 (boba-cup overlay, `pages/VolumePage`), knob press = cycle the 4
  display modes (reported). Palettes (skins) and the accent color are switched
  from the web side via `/state`.
- **Sync loop**: one background thread polls `GET /api/music/device/state`
  every 2 s, applies track/play/mode/skin/accent/seek changes, and posts
  playhead heartbeats.

## Structure

- `src/Main.cpp` — `onStartupApp` → `lyricsActivity`.
- `src/activity/lyricsActivity.*` — IDE-style activity (includes the logic .cc).
- `src/logic/lyricsLogic.cc` — page registration, poll/heartbeat thread, key
  dispatch, compile-time service origin.
- `src/pages/{SplashPage,LyricsPage,VolumePage}.*` — the pages; draw via
  `Surface`+`sendLedData`.
- `src/managers/AudioManager.*` — local-path playback (play/pause/seek).
- `src/net/NetClient.*` — hand-written raw-socket HTTP/1.0 client
  (`httpGet` / `httpPost` / `downloadFile`); deliberately avoids curl/openssl.
- `src/visual/{Palette,PixelFont,CjkFont,LatinFont,LyricModes,Spectrum,Icons}.h`
  — skins, 3×5 ASCII UI font, generated 12×12 CJK + 6×12 Latin lyric glyphs,
  mode metadata, pseudo-spectrum, note icon (mirrors the web preview's design).
- Reused device infra from pixel-pet: `PageBase`, `Surface`, `McuManager`,
  `KeyManager`, `PageManager`, `uart/*`, `mcuProtocol/*`.

Build & sideload: `../flythings-build/` (plain `make` — the default
`APP=../app` already points here — then push to `/tmp` + `EasyUI.cfg` +
`ctl.restart zkswe`; the exact push order is in the
[player README](../README.md)).

## Capabilities on real hardware

- **LED display** — `Surface` + `sendLedData` (splash, lyrics, volume cup).
- **Audio** — `AudioManager::playAudio(localPath)` through MI_AO with
  millisecond `seekTo`, verified end-to-end. Chain: `audio-utility` →
  `base-json` → `ffmpeg` → `z` → device `libmi_ao`.
- **HTTP** — `net/NetClient` over raw libc sockets, plain HTTP only; the
  service origin is a compile-time constant in `lyricsLogic.cc`.

Protocol fields, build pitfalls, deployment and recovery are documented in the
[player README](../README.md).
