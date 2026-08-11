# Technical reference

[简体中文](reference.md) | English

The front-page README covers what this is and how to install it; this page is the full
reference for configuration, data sources, control-panel behavior, architecture, and the
local API.

## Configuration and operation

`mise.toml` pins Bun 1.3.14. Without mise, plain `bun install && bun start` works too.
Common development commands:

```bash
mise run test && mise run typecheck && mise run build
bun run preview        # write per-channel preview strips to .runtime/previews/
bun run status         # report service state
```

The macOS install (`scripts/install.sh`) listens on `0.0.0.0` by default so phones on the
LAN can connect (General settings → title-bar phone icon shows a QR code and copyable URL);
pass `--control-host 127.0.0.1` to keep it Mac-only. The Docker install
(`scripts/install-docker.sh`) publishes to the host loopback only. Don't let both claim
port 43820.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `CLOCK_HOST` | required | TC002 LAN IP or hostname, without protocol or port. A first-run seed: once the console sets an address, `.runtime/clock-host.json` takes precedence |
| `CONTROL_HOST` | `0.0.0.0` for the macOS install; `127.0.0.1` when run directly | Control panel listen address; phones need `0.0.0.0` |
| `HEALTH_PORT` | `43820` | Control panel, API, and health-check port |
| `REQUEST_TIMEOUT_MS` | `5000` | Market and device request timeout |
| `SOURCE_STALE_MS` | `120000` | How long cached market data may be reused after failures |
| `DISPLAY_DURATION_SECONDS` | `90` | Minimum Custom App lifetime on the device |
| `APP_NAME` | `btc` | Default channel name for fresh installs and first-run legacy migration |
| `ADB_BIN` | auto-detected at install | Absolute `adb` path; a LaunchAgent doesn't inherit the shell PATH |
| `CLOCK_HTTP_PROXY` | unset | Optional loopback HTTP proxy (no credentials); **every** device request goes through it, live and notify included |

## Control-panel behavior

Phone portrait mode splits **Channel composition** and **Add content** into two workspaces,
with bottom navigation and single-column forms laid out for touch; the canvas asks for
landscape. The UI ships a Web App Manifest and an offline static shell for add-to-home-screen
use; full PWA installation requires a trusted HTTPS origin, while plain LAN HTTP keeps the
responsive panel fully working.

Configuration lives in `.runtime/workspace.json`; a legacy `.runtime/settings.json` is
atomically migrated into one market channel on first launch without overwriting the original.
Disabling, deleting, or renaming a channel posts an empty object to its former Custom App
name; a cleanup that fails while the device is offline is recorded as degraded state and
never rolls back the save. A clock address set from the console is stored in
`.runtime/clock-host.json` and outranks `CLOCK_HOST` on every later start.

## Market data

### Search and add any asset (no API keys)

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

### Icon generation

Icons are generated automatically: a cryptocurrency that passes the double symbol +
normalized-name match against the bundled CC0 catalog (`cryptocurrency-icons@0.18.1`) gets a
deterministic offline 16×16 pixelization; uncertain matches and every other asset class get a
procedural identicon derived from the asset identity — never a guessed logo. The four
built-in US stocks keep their PixDeck source icons; provenance and hashes are in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

### Built-in asset data sources

Built-in assets: crypto via Coinbase (Kraken fallback, 24H change); gold via Gold API (the
free endpoint has no reliable 24H open, so no fabricated change); USD/CNY from
Frankfurter/ECB daily reference rates; the four US stocks via Yahoo Chart (1D vs previous
close). Search-added runtime assets use one fixed provider per kind (Coinbase / Yahoo /
Frankfurter / Gold API, no fallback route) and degrade gracefully on quote failure.

## Library

The Library talks to the official Ulanzi community live (every browse, search, and page
requests the official API, so upstream changes appear immediately) and also imports
`ugc.ulanzistudio.com/contentView/...` links. Imported assets are restored to 52×16 with
nearest-neighbor sampling, keep GIF timing, and are snapshotted under
`.runtime/pixel-assets` — later previews and pushes don't depend on the upstream site, and a
snapshot is never silently replaced by upstream edits. Community artwork is not bundled with
this repository, and author/source attribution is retained.

## Music

The module has two interchangeable sources. The live one is remembered in
`.runtime/music-provider.json`; switching clears the previous source's selection, because
the two catalogues share no track IDs (NetEase hands out decimals, Spotify base62). Cover
art always goes through the same-origin proxy `/api/music/art`, so the page CSP stays
`img-src 'self'` and no third-party CDN learns what is playing.

### NetEase

QR login, audio through a same-origin proxy, and the TC002 downloads and plays the track
itself. The login cookie stays only in `.runtime/music-session.json` (mode `0600`) — neither
the browser nor the clock ever sees the raw credential, and logout deletes the file.
Playback remains subject to account, subscription, copyright, and regional limits; a
45-second preview is shown as a preview, not a full track.

### Spotify Connect

Spotify audio is DRM-protected and never touches this machine or the clock — playback
happens on whichever Connect device you pick, and both the studio and the TC002 are a remote
plus a lyric screen. Spotify issues no public key, so register a free app in your own
developer dashboard:

1. Open the [Spotify developer dashboard](https://developer.spotify.com/dashboard) →
   Create app
2. Set the Redirect URI to exactly `http://127.0.0.1:43820/api/music/spotify/callback`
   (the port follows `HEALTH_PORT`; Spotify accepts plaintext http only on the loopback
   address, and no longer accepts `localhost`)
3. Enable Web API, save, and paste the Client ID into the studio's Spotify panel

Authorization uses **Authorization Code + PKCE**, so no client secret is needed or stored.
The refresh token lives in `.runtime/spotify-session.json` (mode `0600`) and is deleted on
logout. The callback can only land on the machine running the service, so when the studio is
open on a phone or tablet, paste that unreachable `127.0.0.1` URL back into the panel to
finish the login.

Once connected, search, playlists (including Liked Songs), track selection, pause,
previous/next, seeking, switching the Connect device, and volume all go through the Web
API — **and the reverse holds too**: change the song on your phone and the clock and the
studio follow within two seconds. Connect playback control requires a Premium account; a
free account gets a clear message instead of a silent failure. Playback itself stays in your
own Spotify clients — the studio is not a web player, because that would mean pulling in
Spotify's CDN script, widening the page CSP, and handing an access token to the frontend,
while the client is already at hand.

Apps still in Development Mode have their paging parameters restricted (an explicit `limit`
is rejected outright with `Invalid limit`), so no list ever asks for a page size: each walks
`offset` with whatever the server gives and dedupes by ID. The same code keeps working once
the quota is extended.

Spotify exposes no lyric API, so lyrics come from [LRCLIB](https://lrclib.net) (no key),
falling back to NetEase's timed lyrics for Chinese-language tracks; with neither, the player
degrades to showing the track title rather than failing.

### Sources and attribution

NetEase Cloud Music uses unofficial endpoints and its credentials stay on this machine;
Spotify uses the official Web API and Spotify Connect, needs your own developer app, and
requires Premium for Connect control. This project is not affiliated with or endorsed by
NetEase, Spotify, or Ulanzi; Spotify audio is DRM-protected and is never downloaded,
proxied, or transcoded here.

The preview and the device share one theme system: four display modes (ticker / skyline /
spotlight / cascade) × four palettes (signal green / tape orange / blueprint / arcade red),
plus a color-picker accent override. They also share one font: rather than rasterising a
webfont at runtime, the browser reads the firmware's own offline-generated tables — 12×12
CJK and 6×12 half-width ASCII — so the preview, the frames pushed to the stock firmware,
and the native firmware are identical pixel for pixel.

Details of the two display paths:

- **Device mirror (stock firmware, no flashing)**: pushes the rendered lyric frames (up to
  400 frames, 33–50fps) through the stock firmware's Custom App channel; audio plays in the
  browser. Frame delays are multiples of 10ms because GIF only has centisecond precision;
  a line too long for 400 frames gets a longer delay rather than fewer frames, so the GIF
  always covers the whole line. The lyric GIF does not loop — it holds the last frame until
  the next line arrives.

  The frame rate was measured on hardware and is **budgeted per content motion** rather than
  applied uniformly. A ruler animation (three speeds staged inside one GIF) showed the stock
  firmware honors frame delays faithfully, staying smooth even at 10ms/100fps — the end of
  the GIF format, whose delay field is in centiseconds — and it accepts a 400-frame, 48KB
  body in 109ms. But that headroom has nothing to consume it: ticker/skyline/cascade scroll
  text in whole 12px cells, the spectrum is quantized to 8fps, and the progress cursor has
  only 47 positions, so those modes saturate at 33fps and extra frames just repeat a frame.
  Only spotlight sweeps text per pixel and needs one frame per pixel of travel, so it scales
  up to 50fps based on text width. What actually caps the frame count is how many frames the
  browser rasterizes per line, not device capacity.
- **Native music firmware (non-persistent sideload)**: the FlyThings C++ player is
  cross-compiled in Docker — no Windows IDE; the service address is injected onto the
  device at sideload time, so a new network never requires a rebuild. One firmware covers
  both sources: on NetEase it downloads the track and plays it locally; on Spotify it
  downloads no audio at all and instead follows the Connect player's reported position
  (correcting only past 0.9 s of drift, with the local 30 ms tick carrying the frames in
  between), the side keys become previous/next, and the knob sets the Connect device's
  volume. The firmware downloads the audio on-device, plays it through the speaker with
  millisecond seeking,
  drives the LED matrix with offline-rasterised 12×12 Chinese and Japanese glyphs, and
  ships a six-second boot animation plus a "pick a song" idle screen. Web and firmware stay
  in bidirectional real-time sync over a control-sequence + heartbeat protocol: web-side
  select/pause/theme/seek reaches the device within 2 s, device keys flow back instantly,
  and the preview clock anchors to the real playhead. Within seconds of the firmware coming
  online the studio switches into remote mode and locks Content / Canvas / Library and
  General settings (they ride the stock-firmware channel, which is gone during the
  session); restoring the official firmware unlocks them again. The stock firmware has no
  player that decodes network audio — speaker output requires a device-side app calling
  `AudioManager`, which is exactly why the sideloaded firmware exists (MQTT can carry
  control messages but cannot replace it).

Sideloading is always non-persistent: the firmware only ever runs from the device tmpfs, and
hitting **Restore official firmware** — or any power cycle — brings the stock firmware back
because flash is never written. Sideloading requires the bundle to match its per-file SHA-256
manifest, the official HTTP API and Wi-Fi ADB to both identify the device, and an explicit
restore acknowledgement. Firmware sources, the protocol, build, and deployment live in
[device/tc002-lyrics-player](../device/tc002-lyrics-player/README.md).

## Architecture and extension

Content renderers only produce 52×16 frames and delays — they cannot write to the device or
start background loops. The central controller owns market caching, frame limits, GIF
encoding, serialized device writes, failure isolation, and scheduling (see
[ADR 0001](adr/0001-extensible-content-channels.md)). Adding trusted built-in content
means registering one `ContentDefinition` in `src/content-registry.ts`; the registry
deliberately does not load arbitrary third-party JavaScript — an untrusted plugin system
would need an out-of-process protocol and its own ADR.

Device transport is the TC002-native `POST /api/custom?name=...` (no broker, one request per
complete Custom App, explicit delete semantics), injected behind
`pushPayload(appName, payload)` — a future Home Assistant or MQTT adapter changes no
renderer. The music architecture boundary (web / service / firmware responsibilities) is
[ADR 0002](adr/0002-native-music-player-boundary.md).

## Local API

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
| `GET` | `/api/device/info` | Live device facts (SN, SSID, IP, MAC, MCU / SOC versions), matching the clock's own info page; 503 when the clock does not answer |
| `GET` / `PUT` | `/api/device/host` | Read or repoint the clock's LAN address; applied immediately and persisted to `.runtime/clock-host.json`. `PUT` also reports one reachability probe, and a failed probe never blocks the save |
| `DELETE` | `/api/device/host` | Drop the override and fall back to the installed `CLOCK_HOST` |
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
| `GET` / `POST` | `/api/music/providers`, `/api/music/provider` | List both sources with their login state; switch the live source |
| `GET` | `/api/music/session`, `/api/music/avatar` | Sanitized login state and proxied avatar for the live source (`?provider=` picks one) |
| `GET` | `/api/music/art` | Same-origin album-art proxy (only the sources' own image hosts) |
| `POST` | `/api/music/qr`, `/api/music/qr/check`, `/api/music/logout` | Server-held NetEase QR session; logout deletes the local credential |
| `GET` / `PUT` | `/api/music/spotify/app` | Read or store the Spotify app Client ID (PKCE, no secret) |
| `POST` | `/api/music/spotify/login`, `/api/music/spotify/complete` | Mint a PKCE authorize URL; finish a login from a pasted callback URL |
| `GET` | `/api/music/spotify/callback` | Spotify's redirect target (self-contained result page, state-checked) |
| `GET` | `/api/music/spotify/devices` | List available Spotify Connect devices |
| `POST` | `/api/music/remote` | Connect transport: play/pause/next/previous/seek/volume/transfer |
| `GET` | `/api/music/search`, `/api/music/playlists`, `/api/music/playlists/:id/tracks` | Search tracks, read playlists and their tracks on the live source |
| `GET` | `/api/music/tracks/:id`, `/api/music/tracks/:id/stream` | Track metadata + timed lyrics; same-origin audio proxy (Range, NetEase only) |
| `GET` / `POST` | `/api/music/device-app/*` | Validate the firmware bundle, probe the device, sideload / restore (tmpfs session) |
| `POST` / `DELETE` | `/api/music/mirror` | Push lyric frames (≤400) to a stock-firmware Custom App (device mirror) |
| `POST` | `/api/music/device/select`, `/api/music/device/control` | Web-side track selection and control patches |
| `GET` | `/api/music/device/state`, `/api/music/device/current` | Plain-text control state polled by the firmware; legacy current-track poll |
| `POST` | `/api/music/device/report`, `/api/music/device/heartbeat` | Firmware key-action reports and playhead heartbeats |
| `GET` | `/api/music/device/now`, `/api/music/device/audio` | Firmware-side lyric fetch and audio download |

Writes accept JSON only and require same-origin requests (except the firmware-facing
`report` / `heartbeat` endpoints, whose caller is the clock itself); the request-body limit is
256 KiB.
Limits: 24 channels, 48 items per channel, 360 rendered frames per channel; app names are
unique and restricted to 1–32 ASCII letters, digits, underscores, or hyphens.
