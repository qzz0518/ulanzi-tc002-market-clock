# Ulanzi TC002 Pixel Studio

[简体中文](README.md) | English

Turns the Ulanzi TC002 pixel clock (52×16 LED) into a multi-channel content studio: market
data, notices, timers, pixel animations, canvas artwork, official community assets — plus a
complete music lyrics player. Everything is composed in the browser and rendered into pixel
frames by a local Bun service that pushes them to the clock.

![Ulanzi TC002 multi-channel content studio control panel](docs/images/tc002-control-panel.png)

## What it does

The device has two tiers, and everything else follows from them
([ADR 0014](docs/adr/0014-two-tiers-official-and-zos.md)):

- **The official firmware.** The device is untouched; the service renders pixel frames on
  this machine and pushes them to the clock. Channels, live streaming, notices and the
  lyric mirror live here. It is the zero-risk entry point, and it stops at what pushing a
  Custom App can express — no new feature lands here.
- **ZOS.** The replacement firmware shipped in this repository; the direction is inverted
  and the device pulls. Input, games, music, VIBE, night sleep, the mirror and the upgrade
  chain live here, and every new device-side feature targets it (see below).

**A channel = one Custom App on the clock**: selected with the TC002 knob under the
official firmware, one page of the Channels menu under ZOS; multiple items in one channel
are composed into an ordered carousel.

| Category | Content |
| --- | --- |
| Market | 10 built-in assets (BTC, gold, AAPL, …); search-and-add any crypto, stock / ETF, FX pair, or precious metal — no API keys |
| Tools | Notice board (with a key-free webhook: one POST from curl / iOS Shortcuts / Home Assistant puts a message on the clock), interval timer column, pomodoro, countdown days |
| Visual | Langton's ant, aquarium, fire, flip clock, flux clock, Matrix clock, maze, pixel pet, falling sand, starfield, Game of Life, fireworks, Nyan Cat, shop sign (your own text and backlight color), weather particles, bold weather clock, viewfinder clock (six palettes, three of them night-dim — type only, dark ground), sunrise/sunset color clock (weather visuals locate by place-name search — no raw coordinates) |
| Creative | 52×16 canvas (pen, pixel text, image pixelization — crop a region and it fills the whole panel, optional live streaming to the clock plus QR-code collaborative doodling); Library imports of Ulanzi community assets (PNG / GIF) or local videos (ffmpeg to 52×16 pixel animation) |

The top-right settings dialog reads and writes the clock's brightness, volume, timezone, and
other general settings directly. Its device tab shows the SN, SSID, IP, MAC, and firmware
versions, and lets you repoint the clock when its IP moves — applied immediately, kept across
restarts, no reinstall. Under ZOS the same dialog becomes what ZOS actually offers: volume,
brightness and Bluetooth provisioning to set, and Wi-Fi, IP, battery, uptime, free memory and
firmware residency to read — the stock-only fields are absent rather than blank. Phone
browsers get a dedicated touch layout with add-to-home-screen support; browsers that can
install the console say so with a card in its bottom-left corner (Safari and iOS get the
manual steps instead), and browsers that cannot never bring it up.

<p align="center">
  <img src="docs/images/tc002-mobile-content.png" width="390" alt="Ulanzi TC002 Pixel Studio mobile channel composition">
</p>

## Pixel lyrics player

![Music workspace: switchable NetEase / Spotify sources, cover art in the track list, the player console, and the live 52×16 pixel preview](docs/images/tc002-music-studio.png)

The **Music** view is a complete music console with two interchangeable sources —
**NetEase Cloud Music** and **Spotify**. Search, playlists, cover art, timed lyrics with
translations, and the live 52×16 pixel preview are shared between them, with four display
modes × four palettes.

The highlight is **karaoke-grade**: roughly a fifth of NetEase tracks carry per-word timings
(`yrc`), and the wipe then walks each glyph at the rate it was actually sung; the rest are
bounded by a measured singing rate and labelled 估算 on the lyric track. The point is that **a
line ends when the singing does, not when the next line starts** — the last line of a verse is
usually followed by ten or more seconds of instrumental, and counting that as part of the line
leaves the highlight crawling long after the singer has stopped (see
[ADR 0008](docs/adr/0008-word-level-lyric-timing.md)).

- **NetEase**: QR login, and the TC002 downloads the track and plays it through its own
  speaker.
- **Spotify**: official Spotify Connect — playback happens on whichever device you pick
  (phone, desktop client, speaker) and both the studio and the clock act as a remote plus a
  lyric screen; change the song on your phone and they follow within two seconds. It needs a
  free app registered in your own developer dashboard, see the
  [technical reference](docs/reference.en.md#music).

Two paths put lyrics on the clock:

- **Device mirror**: no flashing — lyric frames are pushed to the stock firmware while
  audio plays in the browser.
- **Native music firmware**: one click on the web page sideloads the C++ player shipped in
  this repository — speaker audio on the device, lyrics driving the LED matrix directly,
  bidirectional real-time sync with the web. The sideload lives only in device memory: a
  power cycle or one click restores the stock firmware, and flash is never written.
  **This is transitional**: ZOS already has the music page, and device-side audio is being
  folded into it behind a device-side switch (off by default); once the speaker is verified
  on hardware the sideloaded player is deleted, and until then it is frozen
  ([ADR 0014](docs/adr/0014-two-tiers-official-and-zos.md)).

<p align="center">
  <img src="docs/images/tc002-music-firmware-preview.png" width="720" alt="The 52×16 pixel lyric screen — the preview and the music firmware share one rendering algorithm">
</p>

## Game arcade

The "Games" tab is a pixel arcade: **time breakout, flappy bird, snake, two-player Pong,
lane racer, space shooter, and Tetris** — all seven run right in the browser (touch /
mouse / keyboard), and flipping "Screen" on mirrors the picture to the clock at ~25fps in
real time — no flashing, the clock is simply a second screen. Two-player Pong turns a
phone into the second paddle via a QR code. The last three were written for the firmware's
knob first and ported back here; the two simulations are byte-identical.

To play on the clock itself with its knob and buttons, the same seven games are ZOS's
Games menu (below).

## AI usage (VIBE)

Puts the quota of AI coding agents — Claude Code, Codex, and eight more — on the pixel panel.
It is **an app on ZOS**, peer to 音乐 and 游戏 on the knob's root ring: an overview of two
agents side by side first, then one page per agent (metrics, meters, reset countdown); the knob
pages, press toggles used vs left, hold goes back. An app rather than a channel because a
channel is only an animation refetched on a timer — no input, nothing to push to — and VIBE's
next step is reacting live to the vibe-coding session on this machine
(see [ADR 0011](docs/adr/0011-vibe-is-a-firmware-app.md)).

The service collects the numbers itself: it reads the login each agent's own CLI already left on
this Mac and calls that vendor's usage endpoint, so nothing else has to be installed; with
nothing signed in the panel says so rather than inventing a number
(see [ADR 0010](docs/adr/0010-vibe-native-usage-collection.md)).

The console's **VIBE** tab lists the four agents (Claude, Codex, OpenCode, Grok) and their
metrics, stars at most two per agent (those are the ones that reach the panel), previews both
52×16 pages, and can jump the clock straight to the app. All four borrow a CLI login this
machine already carries, so no API key has to be typed anywhere.

**When the service is not on the machine holding those logins** — a Docker deployment, a NAS,
another host — all four adapters truthfully find nothing and the panel is empty. That is not a
fault; it is the credentials being out of reach. Run the collector on **the machine that has the
logins** instead: `bun run agent -- --url http://<service>/v1/push --token <token>`, or
`bun run agent-build` to compile a single self-contained binary to carry over (macOS / Linux /
Windows). Set `VIBE_INGEST_TOKEN` on the service to start accepting pushes; pushed rows fold into
the same snapshot as locally collected ones, and the console, the renderers and the panel cannot
tell them apart. When both sources have the same vendor, the local read wins (see
[ADR 0013](docs/adr/0013-vibe-remote-usage-agent.md)).

The **远程采集** button on the console's VIBE tab holds a per-OS walkthrough with every command
pre-filled with your own address and token. Note that the collector reads — and when necessary
refreshes — each CLI's login, so **run it only on the machine those credentials belong to**.

## ZOS system firmware

The official firmware is the first tier and the service only pushes frames to it; **ZOS**
(`device/tc002-os/`) is the second, a replacement for the whole thing: it takes the
official app's place, *is* the device's system, and every new device-side feature targets
it. Boot is a 2.5-second ZOS wordmark animation, then a knob-driven root menu —
**Music / Games / Channels / VIBE / Settings** — one item per page, full-bleed (a list does
not fit on 52×16: four 12px CJK cells fill the width, one label's worth, and squeezing the
neighbours in leaves three unreadable rows). The knob pages, a press descends, a hold goes
back, at every level. The five destinations share four entry motions (channels like a CRT
waking up, music and VIBE as an equaliser rising, a game as a cartridge seated, settings
as a drawer dropping); leaving replays that same motion backwards. The side buttons are
volume on a short press and brightness on a long one, both raising a bar that expires on
its own.

- **Channels** holds the console's channels, one per page, and each page **is** its
  channel — no icon, no label; the name appears only while frames are still downloading.
  A press pauses and resumes.
- **Games** holds the browser arcade's seven games as native engines (`app/src/games/`),
  one card each, with a per-game 12×12 animated icon and per-game synthesised sound
  (square / triangle / noise sweeps — no .wav files, nothing to decode).
- **Music** shows what the console is playing (title, artist, current lyric line, playhead);
  the knob is previous/next and a press toggles play. NetEase audio comes out of the console's
  computer by default; set 设置 → 音乐播放 to 时钟 on the clock and it downloads and plays the
  track through its own speaker (Spotify still plays on the Connect device). **Not yet verified
  on hardware**, hence off by default.
- **Settings** lists network, IP, console address, volume, brightness, MAC, the setup-page
  address, and uptime.

**The direction is inverted: the device pulls.** Replacing the official app deletes its
`POST /api/custom` receiver, so ZOS long-polls the console for its menu, its channel frames
and the now-playing text, and the console never opens a connection to the device. The
device also ships each composed frame back at 10fps, which is how the console can show what
the panel is really displaying.

To try it without flashing, ZOS can be sideloaded too: memory only, a power cycle restores
the official firmware, flash is never written. Sideloading adds one step — a `host` file in
the bundle carries the console's address, which is how the device finds the service; without
it the firmware still runs, it just has no channels and no mirror. Its own setup page already
lists scanned networks and accepts a submission, but **the half that actually changes the
link is locked off by default** (see the
[technical reference](docs/reference.en.md#zos-system-firmware-tc002-os)).

## Quick start

Requires [Bun](https://bun.sh) (`mise.toml` pins 1.3.14 — with mise, just `mise install`):

```bash
bun install
CLOCK_HOST=TC002_IP bun start        # replace TC002_IP with the clock's LAN IP or hostname
```

Then open `http://127.0.0.1:43820/`. Install as a resident service (pick one):

```bash
bash scripts/install.sh --host TC002_IP          # macOS LaunchAgent
bash scripts/install-docker.sh --host TC002_IP   # Docker Compose
```

## More documentation

- [Technical reference](docs/reference.en.md): environment variables, market data sources, Library and Music details, architecture, and the local API
- [ZOS system firmware](device/tc002-os/README.md): the architectural rule, build and link audit, sideload and recovery
- [Music firmware](device/tc002-lyrics-player/README.md) (transitional): firmware sources, protocol, build, and sideload safety
- [Cross-compile toolchain](device/flythings-build/README.md): the IDE-free Docker build environment both firmwares share
- [ADRs](docs/adr/): key architecture decisions

## License

This project is **GPL-3.0-only** because it adapts and modifies GPL-3.0 PixDeck material.
Review [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before
distributing source or binaries.
