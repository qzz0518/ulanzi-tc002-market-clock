# ADR 0002: TC002 music requires a separate native device application

- Status: Accepted
- Date: 2026-08-07
- Amended: 2026-08-08 — installation switched from persistent `update.img` flashing to
  non-persistent ADB sideload sessions (Path A); official firmware stays on flash.
- Amended: 2026-08-09 — the "future FlyThings adapter" below now exists
  (`device/tc002-lyrics-player/`). It is cross-compiled headlessly in Docker
  (`flythings-build/`, no Windows or FlyThings IDE required), and standalone tmpfs
  operation (UI, `AudioManager`, LED, keys) was verified end-to-end on real hardware
  on 2026-08-08 — the reversible-flash fallback in Consequences was never needed.
- Amended: 2026-08-09 — the sideload session now deploys the player into the framework's
  `/tmp` load path and restarts `zkswe` on it (decision 5's "temporary process while the
  official UI service is paused" describes the earlier probe-era session model); a session
  counts as alive while `/tmp/EasyUI.cfg` exists and `zkswe` is running.

## Context

Pixel Studio can already render images and send them to an official-firmware Custom App through
`POST /api/custom`. The requested music experience also needs the TC002 speaker, play/pause and
track changes, lyric timing, and a way to return to the official firmware.

Ulanzi's public Z21 Demo proves local-path MP3 playback through `AudioManager` / `MediaPlayer`.
The official Custom App HTTP contract and the current MQTT example do not expose an equivalent
remote command that makes the stock firmware decode an arbitrary network audio stream.

## Decision

Music is a fourth first-class Pixel Studio view backed by a separate, native TC002 application:

1. Pixel Studio keeps NetEase credentials on the computer and exposes only bounded search,
   lyric, and same-origin audio-proxy routes.
2. The browser provides the controller and a truthful web-audio preview.
3. The future FlyThings adapter downloads a bounded audio file over the LAN, passes only a local
   path to the proven `AudioManager` API, and renders 52×16 lyric frames on-device.
4. MQTT may later carry playback state, but is not treated as an audio decoder or firmware
   substitute.
5. The device never runs a persistent custom firmware. The player ships as a sideload bundle
   (a `bundle/` directory plus a generated per-file SHA-256 manifest) pushed to the TC002 tmpfs
   over fixed-host Wi-Fi ADB and runs as a temporary process while the official UI service
   (`zkswe`) is paused. Ending the session — or any power cycle — restores the official
   firmware because flash is never written. Starting a session still requires a TC002
   verified through both its HTTP API and ADB, plus an explicit restore acknowledgement.
6. Source-only or untested builds never unlock the session button.
7. Independently of the native player, Pixel Studio can mirror the rendered 52×16 lyric
   frames to the *official* firmware through the existing Custom App HTTP channel
   (`POST /api/custom`), giving on-device lyrics without touching the firmware at all.
   Audio on the device speaker still requires the native sideloaded player.

## Consequences

- The existing official-firmware Custom Apps continue to work unchanged until the user chooses
  to start a sideload session for the separate player.
- The device player still depends on a LAN Pixel Studio service for NetEase access; the NetEase
  cookie is never copied to the clock.
- Building the sideload bundle requires Windows and FlyThings IDE, followed by real-device audio,
  network, endurance, power-cycle-restore, and recovery testing. Whether the FlyThings build can
  run standalone from tmpfs (UI, `AudioManager`, LED path) is the first thing to verify on real
  hardware; if it cannot, the fallback is a reversible flash flow that backs up the official
  application image first.
- Hardware recovery can restore official firmware, but until verified on target hardware we do
  not promise that Wi-Fi/settings/user data survive unchanged.
