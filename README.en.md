# Ulanzi TC002 Pixel Studio

[简体中文](README.md) | English

Turns the Ulanzi TC002 pixel clock (52×16 LED) into an extensible multi-channel content
studio: market data, notices, timers, pixel animations, canvas artwork, official community
assets — plus a complete music lyrics player. Everything is composed in the browser and
rendered into pixel frames by a local Bun service that pushes them to the clock.

![Ulanzi TC002 multi-channel content studio control panel](docs/images/tc002-control-panel.png)

## Core concept: channels and content items

- **A channel = one Custom App on the clock**, directly selectable with the TC002 knob.
- **A content item = one segment inside a channel.** A single item is a standalone screen;
  multiple items are composed into one ordered GIF carousel.

For example, three knob entries: `markets` (BTC → gold → AAPL carousel), `timer` (interval
column), `fire` (flame animation).

## What's included

| Category | Content |
| --- | --- |
| Market | Built-in BTC, ETH, BNB, SOL, gold, USD/CNY, AAPL, MSFT, NVDA, GOOGL; plus search-and-add for more assets (next section) |
| Tools | Notice board, interval timer column |
| Visual | Langton's ant, aquarium, fire, flip clock, Matrix clock, maze, pixel pet, falling sand, starfield |
| Creative | Persistent 52×16 canvas; Ulanzi community pixel assets imported through the Library (PNG / GIF) |

### Market: search and add any asset (no API keys)

The content market's **Search more assets** covers four asset classes, all through public
endpoints — no API key of any kind:

| Kind | Source | Notes |
| --- | --- | --- |
| Crypto | Coinbase Exchange public catalog + market data | Any tradable product, 24H change |
| Stocks / ETFs | Yahoo Finance public search + Chart endpoint | Major exchanges (US, HK, Shanghai/Shenzhen, Tokyo, EU, …); prices may be delayed, 1D change |
| FX | Frankfurter (ECB reference rates) | Any ISO currency pair; central-bank daily reference, not tick quotes |
| Metals | Gold API | Gold, silver, platinum, palladium spot |

Stock search only admits exchanges whose quote currency is unambiguous (pence-priced London
listings and OTC pink sheets never appear), and the quote path re-checks the actual listing
currency — a mismatch fails loudly instead of labelling a price with the wrong currency.
Added assets are stored as stable local identities; a failing quote falls back to the cached
price and, once the cache expires, skips that one item while the rest of the channel keeps
rendering.

Icons are generated automatically: a cryptocurrency that passes the double symbol +
normalized-name match against the bundled CC0 catalog (`cryptocurrency-icons@0.18.1`) gets a
deterministic offline 16×16 pixelization; uncertain matches and every other asset class get a
procedural identicon derived from the asset identity — never a guessed logo. The four
built-in US stocks keep their PixDeck source icons; provenance and hashes are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Canvas and Library

The canvas supports pen/eraser, custom colors, grid, undo/redo, ASCII pixel text, image
pixelization, and PNG export; a saved canvas is a normal content item, usable in a carousel
or as a standalone app.

The Library talks to the official Ulanzi community live (every browse, search, and page
requests the official API, so upstream changes appear immediately) and also imports
`ugc.ulanzistudio.com/contentView/...` links. Imported assets are restored to 52×16 with
nearest-neighbor sampling, keep GIF timing, and are snapshotted under
`.runtime/pixel-assets` — later previews and pushes don't depend on the upstream site, and a
snapshot is never silently replaced by upstream edits. Community artwork is not bundled with
this repository, and author/source attribution is retained.

## Quick start

`mise.toml` pins Bun 1.3.14:

```bash
mise install
mise run test && mise run typecheck && mise run build
CLOCK_HOST=TC002_IP bun start        # replace TC002_IP with the clock's LAN IP or hostname
```

Then open `http://127.0.0.1:43820/`. Without mise, plain
`bun install && bun test && bun run build` works too; `bun run preview` writes per-channel
preview strips to `.runtime/previews/`, and `bun run status` reports service state.

Install as a resident service (pick one — don't let both claim port 43820):

```bash
bash scripts/install.sh --host TC002_IP          # macOS LaunchAgent
bash scripts/install-docker.sh --host TC002_IP   # Docker Compose (published to host loopback only)
```

The macOS install listens on `0.0.0.0` by default so phones on the LAN can connect (General
settings → title-bar phone icon shows a QR code and copyable URL); pass
`--control-host 127.0.0.1` to keep it Mac-only.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `CLOCK_HOST` | required | TC002 LAN IP or hostname, without protocol or port |
| `CONTROL_HOST` | `0.0.0.0` for the macOS install; `127.0.0.1` when run directly | Control panel listen address; phones need `0.0.0.0` |
| `HEALTH_PORT` | `43820` | Control panel, API, and health-check port |
| `REQUEST_TIMEOUT_MS` | `5000` | Market and device request timeout |
| `SOURCE_STALE_MS` | `120000` | How long cached market data may be reused after failures |
| `DISPLAY_DURATION_SECONDS` | `90` | Minimum Custom App lifetime on the device |
| `APP_NAME` | `btc` | Default channel name for fresh installs and first-run legacy migration |
| `ADB_BIN` | auto-detected at install | Absolute `adb` path; a LaunchAgent doesn't inherit the shell PATH |
| `CLOCK_HTTP_PROXY` | unset | Optional loopback HTTP proxy (no credentials) for device requests |

## Control panel

- Left: the channel rail (knob entries). Center: the channel editor (ordering, durations,
  preview, per-channel push). Right: the content market grouped by Market / Tools / Visual /
  Creative.
- Top navigation: four first-class views — **Content / Canvas / Library / Music**.
- The top-right **General settings** dialog reads and writes brightness, volume, paging,
  scrolling, timezone, date, weekday, and low-battery sleep; its title-bar phone icon reveals
  the same-subnet QR code and URL on demand.

Phone portrait mode splits **Channel composition** and **Add content** into two workspaces,
with bottom navigation and single-column forms laid out for touch; the canvas asks for
landscape. The UI ships a Web App Manifest and an offline static shell for add-to-home-screen
use; full PWA installation requires a trusted HTTPS origin, while plain LAN HTTP keeps the
responsive panel fully working.

<p align="center">
  <img src="docs/images/tc002-mobile-content.png" width="390" alt="Ulanzi TC002 Pixel Studio mobile channel composition">
</p>

Configuration lives in `.runtime/workspace.json`; a legacy `.runtime/settings.json` is
atomically migrated into one market channel on first launch without overwriting the original.
Disabling, deleting, or renaming a channel posts an empty object to its former Custom App
name; a cleanup that fails while the device is offline is recorded as degraded state and
never rolls back the save.

## Pixel lyrics player

![Music workspace: search, track picking, themes, and the live 52×16 pixel preview](docs/images/tc002-music-studio.png)

The **Music** view is a complete music console: NetEase Music QR login, search (20 per
page), signed-in playlists, timed lyrics with translations, a same-origin audio proxy, and a
live 52×16 pixel lyric preview. The login cookie stays only in
`.runtime/music-session.json` (mode `0600`) — neither the browser nor the clock ever sees the
raw credential, and logout deletes the file. Playback remains subject to account,
subscription, copyright, and regional limits; a 45-second preview is shown as a preview, not
a full track.

The preview and the device share one theme system: four display modes (ticker / skyline /
spotlight / cascade) × four palettes (signal green / tape orange / blueprint / arcade red),
plus a color-picker accent override.

Two complementary paths put lyrics on the clock:

- **Device mirror (stock firmware, no flashing)**: pushes the rendered lyric frames (up to
  60 frames, ~15fps) through the stock firmware's Custom App channel; audio plays in the
  browser.
- **Native music firmware (non-persistent sideload)**: the repository contains a complete
  FlyThings C++ player — cross-compiled in Docker, no Windows IDE — sideloaded with one
  click from the web page; the service address is injected onto the device at sideload
  time, so a new network never requires a rebuild. The firmware downloads the audio
  on-device, plays it through the speaker with millisecond seeking, drives the LED matrix
  with offline-rasterised 12×12 Chinese and Japanese glyphs, and ships a six-second boot
  animation plus a "pick a song" idle screen. Web and firmware stay in **bidirectional
  real-time sync** over a control-sequence + heartbeat protocol: web-side
  select/pause/theme/seek reaches the device within 2 s, device keys flow back instantly,
  and the preview clock anchors to the real playhead. Within seconds of the firmware
  coming online the studio switches into remote mode and locks Content / Canvas / Library
  and General settings (they ride the stock-firmware channel, which is gone during the
  session); restoring the official firmware unlocks them again. The stock firmware has no
  player that decodes network audio — speaker output requires a device-side app calling
  `AudioManager`, which is exactly why the sideloaded firmware exists (MQTT can carry
  control messages but cannot replace it).

<p align="center">
  <img src="docs/images/tc002-music-firmware-preview.png" width="720" alt="The 52×16 pixel lyric screen — the preview and the music firmware share one rendering algorithm">
</p>

Sideloading is always non-persistent: the firmware only ever runs from the device tmpfs, and
hitting **Restore official firmware** — or any power cycle — brings the stock firmware back
because flash is never written. Sideloading requires the bundle to match its per-file SHA-256
manifest, the official HTTP API and Wi-Fi ADB to both identify the device, and an explicit
restore acknowledgement. Firmware sources, the protocol, build, and deployment live in
[device/tc002-lyrics-player](device/tc002-lyrics-player/README.md).

## Architecture and extension

Content renderers only produce 52×16 frames and delays — they cannot write to the device or
start background loops. The central controller owns market caching, frame limits, GIF
encoding, serialized device writes, failure isolation, and scheduling (see
[ADR 0001](docs/adr/0001-extensible-content-channels.md)). Adding trusted built-in content
means registering one `ContentDefinition` in `src/content-registry.ts`; the registry
deliberately does not load arbitrary third-party JavaScript — an untrusted plugin system
would need an out-of-process protocol and its own ADR.

Device transport is the TC002-native `POST /api/custom?name=...` (no broker, one request per
complete Custom App, explicit delete semantics), injected behind
`pushPayload(appName, payload)` — a future Home Assistant or MQTT adapter changes no
renderer. The music architecture boundary (web / service / firmware responsibilities) is
[ADR 0002](docs/adr/0002-native-music-player-boundary.md).

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/catalog` | Categories, option schemas, and defaults |
| `GET` / `PUT` | `/api/workspace` | Read or atomically save all channels |
| `POST` | `/api/channels/preview` | Render a saved channel or draft |
| `POST` | `/api/channels/push` | Push one channel |
| `POST` | `/api/push` | Push every enabled channel |
| `GET` | `/api/state`, `/health` | Device, channel, market, and cleanup status |
| `GET` / `PUT` | `/api/device/settings/general` | Read or write TC002 general settings |
| `GET` | `/api/access` | Same-subnet phone URL and listener status |
| `GET` | `/api/market/search` | Search addable market assets by query and kind |
| `GET` / `POST` | `/api/market/instruments` | List added assets; register one by candidate ref |
| `GET` | `/api/market/icons/:iconRef.png` | 16×16 pixel icon of a runtime asset (immutable cache) |
| `GET` | `/api/presets`, `/api/icons/:id.png` | Legacy market presets and built-in asset icons |
| `GET` / `PUT` | `/api/settings` | Legacy single-carousel settings |
| `POST` | `/api/preview` | Legacy: returns rendered GIF/PNG bytes directly |
| `GET` | `/api/library/ulanzi/pixel-assets` | Browse, search, filter, and page community assets |
| `GET` | `/api/library/ulanzi/media` | Safely proxy official preview media |
| `POST` | `/api/library/ulanzi/import` | Validate and import a `contentView` link or work ID |
| `GET` | `/api/library/ulanzi/imported/:ref` | Read a normalized local asset snapshot |
| `GET` | `/api/music/session`, `/api/music/avatar` | Sanitized NetEase login state and proxied avatar |
| `POST` | `/api/music/qr`, `/api/music/qr/check`, `/api/music/logout` | Server-held QR session; logout deletes the local credential |
| `GET` | `/api/music/search`, `/api/music/playlists`, `/api/music/playlists/:id/tracks` | Search tracks, read playlists and their tracks |
| `GET` | `/api/music/tracks/:id`, `/api/music/tracks/:id/stream` | Track metadata + timed lyrics; same-origin audio proxy (Range) |
| `GET` / `POST` | `/api/music/device-app/*` | Validate the firmware bundle, probe the device, sideload / restore (tmpfs session) |
| `POST` / `DELETE` | `/api/music/mirror` | Push lyric frames (≤60) to a stock-firmware Custom App (device mirror) |
| `POST` | `/api/music/device/select`, `/api/music/device/control` | Web-side track selection and control patches |
| `GET` | `/api/music/device/state`, `/api/music/device/current` | Plain-text control state polled by the firmware; legacy current-track poll |
| `POST` | `/api/music/device/report`, `/api/music/device/heartbeat` | Firmware key-action reports and playhead heartbeats |
| `GET` | `/api/music/device/now`, `/api/music/device/audio` | Firmware-side lyric fetch and audio download |

Writes accept JSON only and require same-origin requests (except the firmware-facing
`report` / `heartbeat` endpoints, whose caller is the clock itself); the request-body limit is
256 KiB.
Limits: 24 channels, 48 items per channel, 360 rendered frames per channel; app names are
unique and restricted to 1–32 ASCII letters, digits, underscores, or hyphens.

## Data sources and license

Built-in assets: crypto via Coinbase (Kraken fallback, 24H change); gold via Gold API (the
free endpoint has no reliable 24H open, so no fabricated change); USD/CNY from
Frankfurter/ECB daily reference rates; the four US stocks via Yahoo Chart (1D vs previous
close). Search-added runtime assets use one fixed provider per kind (Coinbase / Yahoo /
Frankfurter / Gold API, no fallback route) and degrade gracefully on quote failure.

This project is **GPL-3.0-only** because it adapts and modifies GPL-3.0 PixDeck material.
Review [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before
distributing source or binaries.
