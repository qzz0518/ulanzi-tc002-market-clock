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
- Amended: 2026-08-09 — music became multi-source (NetEase + Spotify), which splits
  decision 1–3 along a new axis; see "Playback modes" below.
- Amended: 2026-09-09 — the sideloaded player is transitional. ZOS carries the music page
  and, pending hardware verification, device-side audio over the same
  `/api/music/device/*` protocol; once the speaker is verified the sideload is deleted, and
  until then it receives no changes. See [ADR 0014](0014-two-tiers-official-and-zos.md).

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

## Playback modes

Adding Spotify did not change where credentials live, but it did split *who owns the audio*.
Each source declares a `playbackMode` and everything downstream follows it:

- `device-audio` (NetEase) — decisions 1–3 as written: the service proxies a bounded audio
  file, the TC002 downloads it and plays it through `AudioManager`, and the device owns the
  playhead.
- `remote` (Spotify) — Spotify audio is DRM-protected and never leaves Spotify's own clients,
  so the service does not proxy, download, or transcode it. Playback lives on a Spotify
  Connect device; the service polls `GET /v1/me/player`, republishes the position through the
  same plain-text device-state endpoint, and both the studio and the firmware become remotes
  whose lyric clock is anchored on that reading. `/api/music/device/audio` answers `204` so
  the firmware cannot try to play anything locally, and device key presses are relayed to
  the Web API as Connect commands instead of acting on local audio.

Making the studio tab itself a Connect device (Spotify's Web Playback SDK) was built and
then removed. It worked, but it cost a third-party script from `sdk.scdn.co`, a widened page
CSP for the DRM iframe, and an access token handed to the frontend — all to duplicate a
desktop client the user already has open on the same machine. Following their clients beats
becoming one.

The alternative — reverse-engineering the Connect *receiver* protocol (librespot) so the
TC002 appears as a Spotify speaker — was rejected: it needs a DRM-bypassing client on a
36 MB ARM device, and it is neither licensable nor honest about what it is doing. Being a
Connect *controller* is the officially supported path and needs no such compromise.

Spotify has no public lyric API, so lyrics for `remote` sources come from LRCLIB with a
NetEase search fallback; a miss degrades to showing the track title, never to a failure.

## Consequences

- The existing official-firmware Custom Apps continue to work unchanged until the user chooses
  to start a sideload session for the separate player.
- Spotify requires the user to register their own developer app: the Client ID is theirs,
  authorization is PKCE (no client secret exists to leak), and the only redirect URI Spotify
  will accept over plaintext http is the loopback callback on the machine running the service.
- Connect transport control requires a Spotify Premium account. A free account can still be
  signed in and browsed; commands surface Spotify's `PREMIUM_REQUIRED` as a plain message.
- The device player still depends on a LAN Pixel Studio service for NetEase access; the NetEase
  cookie is never copied to the clock.
- Building the sideload bundle requires Windows and FlyThings IDE, followed by real-device audio,
  network, endurance, power-cycle-restore, and recovery testing. Whether the FlyThings build can
  run standalone from tmpfs (UI, `AudioManager`, LED path) is the first thing to verify on real
  hardware; if it cannot, the fallback is a reversible flash flow that backs up the official
  application image first.
- Hardware recovery can restore official firmware, but until verified on target hardware we do
  not promise that Wi-Fi/settings/user data survive unchanged.
