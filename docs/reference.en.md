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
| `CONSOLE_DISCOVERY` | `on` | LAN beacon: announces the console's address to the local subnet every 10 s so a ZOS device that lost it can find it again. `off`/`0`/`false` disables it; an unrecognised value throws rather than defaulting to on |
| `CONSOLE_DISCOVERY_PORT` | `43821` | UDP port the beacon is sent to. **The firmware's listener is a compile-time constant**, so changing this makes the device deaf; the console's own port travels in the payload instead |
| `VIBE_INGEST_TOKEN` | unset | Shared secret for usage pushed by the remote collector (`vibe-agent`). **Unset refuses every push**: `POST /v1/push` takes no same-origin check, so without a secret anything on the LAN could put invented quota on the panel |

## Control-panel behavior

Phone portrait mode splits **Channel composition** and **Add content** into two workspaces,
with bottom navigation and single-column forms laid out for touch; the canvas asks for
landscape. The UI ships a Web App Manifest and an offline static shell for add-to-home-screen
use; full PWA installation requires a trusted HTTPS origin, while plain LAN HTTP keeps the
responsive panel fully working.

When installation is actually possible, an install card appears in the bottom-left corner:
Chromium browsers hand over `beforeinstallprompt`, so its **安装** button opens the native
install dialog; Safari and iOS never fire that event, so the card states the manual steps
instead (menu bar **File → Add to Dock**, or the share sheet's **Add to Home Screen**). Where
installation cannot work the card stays away — Firefox has no install flow, and Chrome on a
plain LAN HTTP origin fails the secure-context requirement. Dismissing it hides it for 14
days; `appinstalled` hides it for good, and a window already running standalone never asks.

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

## Weather and sunrise/sunset

"Weather particles", "bold weather clock", "viewfinder clock", and the sunrise/sunset color
clock locate by place-name search: type a place name (English or pinyin) in the content
settings, the server queries Open-Meteo Geocoding (no key) for candidates, and picking one
fills in the latitude/longitude — no raw coordinates. The weather-particles face shows the
selected place's English name in 5px ASCII at the top-left (truncated by pixel width when it
doesn't fit); live conditions come from Open-Meteo Forecast at roughly 10-minute
granularity, and geocoding results are likewise cached server-side for 10 minutes.

## Library

The Library talks to the official Ulanzi community live (every browse, search, and page
requests the official API, so upstream changes appear immediately) and also imports
`ugc.ulanzistudio.com/contentView/...` links. Imported assets are restored to 52×16 with
nearest-neighbor sampling, keep GIF timing, and are snapshotted under
`.runtime/pixel-assets` — later previews and pushes don't depend on the upstream site, and a
snapshot is never silently replaced by upstream edits. Community artwork is not bundled with
this repository, and author/source attribution is retained.

## AI usage (VIBE)

VIBE is **an app on ZOS**, peer to 音乐 and 游戏 on the knob's root ring (order: 音乐 / 游戏 /
轮播 / **VIBE** / 设置). Inside it the knob pages: an overview of two agents side by side
first, then one page per agent (metric rows, meters, reset countdown); press toggles used vs
left, hold goes back. It is deliberately **not a channel** — a channel is an animation fetched
on a timer, with no input and no way to be pushed to, and VIBE's next step is reacting live to
the vibe-coding session on this machine ([ADR 0011](adr/0011-vibe-is-a-firmware-app.md)). The
official firmware and the two sideloaded ones have no root ring to add to, so **VIBE exists
only under ZOS**.

The service collects the numbers itself and **nothing extra has to be installed**: one adapter
per vendor (`src/vibe/providers/<vendor>.ts`) reads the credential that vendor's own CLI already
left on this Mac, then calls that vendor's usage endpoint
([ADR 0010](adr/0010-vibe-native-usage-collection.md)).

Four vendors are supported: **Claude** (its Keychain item, or `~/.claude/.credentials.json`),
**Codex** (`~/.codex/auth.json` or `~/.config/codex/auth.json`), **Grok** (`~/.grok/auth.json`),
and **OpenCode** (`OPENCODE_DATA_DIR` / `XDG_DATA_HOME` / `~/.local/share/opencode`). All four
borrow a CLI login this machine already carries, so **no vendor needs a hand-typed API key**.
`PUT /api/vibe/key` and `.runtime/vibe-keys.json` (mode `0600`) remain as the slot for the next
vendor with no local login; the key-vendor list is empty today and every id is refused.

Reading the Keychain is one `security` call against an item you already authorised for your own
CLI, so it **raises no new prompt**; on a non-macOS host the reader is inert and those vendors
simply never detect. Credentials are read, used to sign one request, and discarded — never
logged, never persisted.

### Remote collection (service and logins on different machines)

All of the above assumes **the service process can read those credentials**. In a Docker
deployment, on a NAS, or on any host that is not the machine you code on, all four adapters
truthfully find nothing — the panel is empty and no error is raised, because "no credential" is a
state rather than a fault. Move the collection to the machine that has the logins instead:

```bash
# On a machine with this repo and Bun, just run it
bun run agent -- --url http://<service>:43820/v1/push --token <token> --once   # verify first
bun run agent -- --url http://<service>:43820/v1/push --token <token>          # then leave it running

# No Bun over there: compile a single self-contained binary on any machine that has the repo
bun run agent-build -- --target darwin-arm64   # or darwin-x64 / linux-x64 / linux-arm64 / windows-x64
```

`src/vibe-agent.ts` is a second entry point into the same collection code: the same four
adapters, the same refresh discipline, the same per-vendor isolation — it just `POST`s the result
to `/v1/push` instead of keeping it in process
([ADR 0013](adr/0013-vibe-remote-usage-agent.md)). Arguments may also come from the environment:
`VIBE_PUSH_URL` / `VIBE_INGEST_TOKEN` / `VIBE_MACHINE` / `VIBE_PUSH_INTERVAL`.

The service needs `VIBE_INGEST_TOKEN` set, or **every push is refused** (503, with the variable
named in the error).

To avoid memorising any of it, the **远程采集** button on the console's VIBE tab walks the whole
thing. It asks exactly two questions — **how this service was started** (Docker / autostart /
shell) and **which machine holds the logins** (this one / another Mac / Linux / Windows) — then
shows only the commands for that one path, token already generated and address already filled in.
Autostart (launchd plist, systemd user unit, schtasks) and uninstall are folded away, the latter
appearing only once a machine is actually pushing.

Pushed rows fold into **the same snapshot**, and the console, the renderers, the star table and
the ZOS document cannot tell a local row from a pushed one. The rules:

- When both sources have the same vendor, **the local read wins** — a credential this process
  just read itself outranks one relayed over the network.
- A push **invalidates the controller's snapshot cache** and reaches the clock at once; otherwise
  the new numbers would sit behind the 15-minute window.
- **Failures travel with the round.** The collector pushes that round's `errors` too; without them
  a vendor that failed over there simply vanished from the panel here with no reason attached —
  local collection writes «sign-in rejected (HTTP 401)» and the remote path used to say nothing at
  all, which is the harder of the two to debug and the one nobody is watching. A failing vendor has
  no row to hang a machine badge on, so with several machines the name goes into the message; and a
  remote failure is dropped when the local read of that same vendor succeeded — it explains nothing
  the user is looking at.
- Pushed data lives in memory, is flagged `stale` after 5 minutes and dropped after 15. A restart
  shows an empty panel for one push interval rather than replaying a snapshot nobody can vouch for.
- Several machines may push (up to 8). One vendor still gets one row, taken by **the most recent
  push**, which names its machine in `note`.
- The `ingest` field on `GET /api/vibe/status` tells the console whether this deployment can
  receive at all, whether a token is set, and which machines are pushing. **The token itself is
  never echoed back.**

The console does not make you guess where the numbers came from: beside 「已接入 N 个代理」 the
strip carries a **source** chip (`本机直采 4 家` / `远程推送 2 家（work-laptop）`, or both halves
when the panel is mixed), and every pushed row wears a 「来自 <machine>」 badge. Local rows carry
none — that is the default topology, and tagging all four would be noise. This comes from a
`source` field on each row (`{kind:"local"|"remote", machine?}`), and a pusher **cannot claim to
be local**: ingest never reads that field off the wire, it stamps `remote` on everything it stores.

The empty state splits the same way. In a container (detected at boot from `/.dockerenv` or the
`container` env var, surfaced as `ingest.containerized`) it says outright that the service reads
the container's own credentials and cannot see yours. Otherwise it names both possibilities —
never logged in here, or the service is not on the machine you code on — and offers the setup
button.

> The collector reads — and when the access token is about to expire, refreshes — each CLI's
> login (`~/.claude/.credentials.json`, `~/.codex/auth.json`). Vendors retire the old refresh
> token on every exchange, so **run this binary only on the machine those credentials belong
> to**: pointed at someone else's home directory it will sign them out of their own CLI.

The console's **VIBE** tab lists the four agents, at most two starred metrics per agent
(`PUT /api/vibe/starred` — those are the ones that reach the panel), a preview of both pages,
and one "open it on the clock" button (the existing `PUT /api/os/display` `{focus:"vibe"}`).
The metric catalog, labels, default stars and the 80 % / 90 % meter bands follow OpenUsage's
semantics (it is the reference implementation for this collection; nothing of it is required
at runtime).

The device gets its data as **new keys in the pull document**, on the same long poll as the
menu: `vibe` (agent count), `vibea` (agent: id / name / plan), `vibes` (this vendor is standing
on its last good values), `vibem` (metric row: label / used / limit / seconds until reset).
They are new *keys* rather than extra fields on an existing one — deployed firmware arity-checks
`item` and would drop the whole line, while unknown keys are ignored by design, which is what
makes these safe to send to a panel that has never heard of VIBE. Percentages are resolved
server-side so the device does no unit arithmetic; a metric with no ceiling arrives as
`limit: 0` and is drawn as a bare number, because a meter without a limit would imply one we
invented. A star change republishes immediately; otherwise it refreshes every five minutes,
the same cadence as the collector's own floor, so republishing costs no vendor request.

**Nothing rather than something wrong — and degradation is per vendor**:

- No credential for a vendor on this machine → it does not appear in the snapshot at all. A
  state, not an error: the console greys it out with a sign-in hint.
- A vendor's endpoint fails → only that row is lost. Its last good values stand in for
  **15 minutes** flagged `stale`, then it drops out entirely and only the error remains; every
  other vendor keeps refreshing.
- A vendor answers 429 → it is parked until its Retry-After passes. The cooldown is per vendor,
  so a rate-limited Claude never stops Codex.
- A vendor whose **access token lapsed and which we may not renew** → the doomed request is not
  sent at all. The row carries a note instead (「访问令牌已过期，等下次运行 Claude Code 会自动
  续期」), and this counts as **neither a failure nor a cooldown**. This one matters: on macOS the
  Claude Code login lives in the keychain, and we only ever read the keychain (`security` silently
  truncates writes past 128 bytes — see `providers/keychain.ts`), so only the CLI can renew that
  access token. It lasts about eight hours, so **every stretch where you are not running the CLI**
  hits the window. The blob already carries `expiresAt`, so expiry never needed a 401 to discover —
  asking anyway is what used to report「登录已过期」for a perfectly good login and then park the
  vendor for thirty minutes, so that by morning — CLI run, token long since renewed — the panel was
  still repeating the stale reason.
- A credential the vendor **actually rejected** (401/403) → that, and only that, is
  `sign-in expired`: parked for thirty minutes, with the HTTP status carried in the message
  (`sign-in rejected (HTTP 401)`). 401 and 403 mean different things, and flattening them into one
  sentence sends debugging the wrong way from the first minute. Pressing 刷新 in the console clears
  every per-vendor cooldown — that is what the button means, and someone who has just repaired a
  login should not have to wait half an hour to find out.
- **Nothing at all is signed in** (or everything refused) → the document carries `vibe\t0` and
  the ZOS panel draws a single centred CJK word, **saying which emptiness this is**: 未配置 when
  the device has no console address yet, 离线 when it has one and nothing arrived, 未登录 only
  when the link is up and no agent is signed in on this Mac
  (`device/tc002-os/app/src/ui/VibeScreen.cpp`) — one shared word for all three would send the
  user hunting for a login they already have. The console's own 52×16 preview still draws the
  `AI USAGE` / `NO LOGIN` pair (`web/src/lib/vibe.ts`). Like the weather faces' "not
  configured", a named state rather than a failure, while the console shows its sign-in /
  paste-a-key pointer.

The controller keeps its own 15-minute snapshot cache on top of that (`GET
/api/vibe/status?refresh=1` forces a re-collection), which is why `SOURCE_STALE_MS` and its
120 s is not reused. The amber pixel in the panel's top-right corner is **per vendor**, not the
age of the whole snapshot: it lights when a vendor on the page being drawn is standing on its
last good values (the document's `vibes` key — the 15-minute window above), which on the
overview means either of the two and on a detail page means that one (`VibeScreen.cpp`, and the
console preview follows the same rule). The number is still the best one there is, so it is
marked rather than hidden. A metric with no data is dropped entirely rather than drawn as a
placeholder dash. The console's agent list carries a separate 10-minute "Outdated" hint
(`VIBE_OUTDATED_MS` in `web/src/lib/vibe.ts`, OpenUsage's own threshold) — that one is the age
of the whole snapshot on the web page, and is not the same thing as the pixel on the panel.

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

## ZOS system firmware (tc002-os)

The first two firmwares are temporary lodgers beside the official app; **ZOS**
(`device/tc002-os/`) is a replacement. It takes the official app's place and *is* the
device's system, which means it inherits all of that app's duties — the menu, the network,
the setup page. All three firmwares claim the same `/tmp` load path and the same
`/tmp/tc002-sideload.id` session identity, so they are mutually exclusive by construction
([ADR 0004](adr/0004-arcade-firmware.md)).

There is exactly one architectural rule: **a Screen only draws into a Surface and never
touches SPI; `platform/Presenter` is the only writer of the LED bus in the whole project.**
Time arrives as the `nowMs` parameter, so a Screen must be a pure function of
`(state, nowMs)`. The LED bus is write-only and `/dev/fb0` is unrelated to the matrix — a
frame cannot be read back on hardware — so UI regressions can only be caught on the Mac:
`mise run os-hostcheck` compiles `ui/`, `core/` and `net/` with clang++ and asserts exact
pixels. The same rule gives the console mirror exactly one tee point, immediately after
`Shell::render`.

### Menu and controls

Boot is a 2460 ms ZOS wordmark animation (a spark gathers, a shockwave develops the mark out
of embers, three pens trace the letters, a flash and hold, then a CRT-style collapse) —
entirely procedural, carrying no glyph data, so it runs before the font tables exist. It
cross-fades into the root menu.

The root menu is a **fixed five**: Music / Games / Channels / VIBE / Settings. A list is a lie
on 52×16 — four 12 px CJK cells fill the width, so anything showing a selected row plus its
neighbours ends up with three unreadable rows — so a page shows exactly one entry,
full-bleed, and a knob detent slides the next one in, with a one-pixel rail on the bottom row
carrying the ring's size and position. VIBE sits between Channels and Settings: the first
three keep the position three firmware releases of muscle memory put them in, and Settings
stays last. Channels are not on this ring: they are content, not destinations, and ten of them
would push the other four off a ring that shows one item at a time. They live one level down,
the same way the seven games do.

| Input | Behaviour |
| --- | --- |
| Knob left / right | Move along the current ring; on Music it is previous / next, in a game it reaches the engine |
| Knob or middle button, short press | Enter / confirm; pause-resume on a channel page, play-pause on Music |
| Any button held (600 ms) | Back, one level, everywhere; a game can be left in any phase |
| Side button, short press | Volume ±1 (0–6 notches, the device's own scale, the one the official firmware also exposes) |
| Side button, long press | Brightness ±1 (10 steps; the hardware takes 0–100, but below ~10 the panel is effectively off and single percents are invisible) |

Both adjustments raise a HUD — a 12×12 icon plus a segmented bar — because both are blind
otherwise: the speaker may be muted and a brightness step on an already-dim panel is easy to
miss. It is an **overlay, not a screen**: changing the volume must not take the user out of
what they were looking at, and pushing a screen for it would make "back" ambiguous. While the
bar is up, further short presses keep adjusting brightness rather than snapping back to
volume mid-adjustment.

The five destinations share four entry motions, lifted from the boot screens of the two
firmwares ZOS replaces: channels as a CRT power-on (320 ms), music as a spectrum rise
(300 ms), games as a cartridge shine-sweep (280 ms), settings as a drop-and-bounce (260 ms).
**VIBE reuses music's spectrum rise** (300 ms) rather than earning a sixth motif: the card
just pressed is already three bars rising into their ceiling, so bars rising into the room is
that same gesture carried through rather than one borrowed from elsewhere. Every one is a pure
compositing operator over two finished rasters, and leaving is the same function evaluated
backwards — so an entry can never look right going in and wrong coming out.

- **Channels**: the console's enabled channels, one per page, and **each page is its
  channel** — no icon, no label. The picture is content the service already composed;
  drawing a badge and a name in front of it would describe what the user is looking at. The
  name appears only while the frames are still downloading. Only the settled channel is
  fetched — prefetching neighbours would mean several bundles of a few hundred KB resident
  to show one, on a radio that is also carrying the long poll.
- **Games**: seven of them, with the engines compiled in unchanged from
  `device/tc002-arcade` rather than ported — they are hardware-verified and already covered
  by the arcade's own self-check, and a port would fork that guarantee. One card each, with
  a per-game 12×12 animated icon (drawn in that engine's palette, not stored as a bitmap)
  and per-game sound. The sounds are **synthesised, not sampled**: square, triangle and noise
  waveforms with a frequency sweep and a decay envelope written straight into
  `base::AudioPlayer`. The arcade's .wav clips go through MediaPlayer, which drags in ffmpeg
  — measured at ~1.1 MB of .text plus 856 KB of .bss — an absurd price for a handful of beeps.
- **Music**: what the console is playing (title, artist, current lyric line, playhead). The
  device has no audio of its own, so a key press becomes a Connect command executed by the
  service; the playhead is advanced locally from the timestamp the service sent, which is
  what keeps it smooth at 25 fps over a link that updates a few times a minute. The side
  buttons are deliberately **not** taken over — volume is the one control a user reaches for
  while music is playing.
- **VIBE**: the AI coding agents' quotas — one overview page plus one page per agent. What it
  draws and how it degrades is the [VIBE](#ai-usage-vibe) section above.
- **Settings**: network, IP, console address, volume, brightness, MAC, the setup-page
  address, uptime, version. The panel holds exactly one text row (both glyph tables are 12 px
  tall and the panel is 16), so label and value share that row **in time**: landing on an item
  shows the label, and after a 1100 ms dwell the label slides up and out while the value
  slides in; turning the knob rewinds to the label.

### The console link (the device pulls)

Replacing the official app deletes its `POST /api/custom` receiver, which is how every
host→device write in this project used to work. The direction is therefore inverted: **the
device pulls**. That is not only a workaround — it removes the service's need to know the
device's address at all, which is the same class of problem that broke the notify webhook (a
launchd process on macOS has no local-network permission and cannot open a LAN socket).

The wire format is line-oriented `KEY\tVALUE` plain text rather than JSON: the firmware parses
it with a split loop, and a JSON dependency for a dozen fields is not worth it on a device
with ~1 MB free. Parsing is **total** — an unrecognised line is skipped rather than failing
the document, because a firmware that refuses a response it half understands would be bricked
by one forward-compatible field added service-side.

```
seq	7
pinned	1
mirror	1
focus	btc
mode	spotlight
skin	tape
accent	ff8844
setseq	3
setvol	4
setvolseq	2
setbri	7
setbriseq	3
input	12	press
np	1
track	Her Majesty
artist	The Beatles
playing	1
pos	18400
dur	23000
lyric	Her Majesty's a pretty nice girl
lyricat	18000
lyricend	21500
lyricuntil	26000
lyricw	0,300,300,180,480,240,…
menu	3
item	channel	btc	市场轮播
rev	btc	e90a8dc5b287
ttl	btc	30000
item	music	music	音乐
item	settings	settings	设置
```

`GET /api/os/pull?seq=` is a long poll: a caller that is behind is answered immediately,
otherwise the request parks until something changes or 8 s elapse — and **the timeout still
answers with the full document rather than a 204**, so the firmware's parser has exactly one
shape to handle. 8 s sits comfortably inside any home router's NAT idle timeout while letting
a device that missed a wake-up self-heal quickly. The device reads with a 13 s budget (it has
to clear the 8 s hold plus a round trip), backs off 1 s → 2 s → … → 10 s on failure, and only
reports offline after three consecutive misses — a single failed poll is the normal shape of
a router hiccup, and flashing "offline" for it would train the user to ignore the indicator.
The `seq` survives the backoff, so a service that merely restarted its socket is resumed
rather than replayed.

Only things that change the panel bump `seq`: the menu, the pin, the mirror flag, and the
now-playing **text**. The playhead deliberately does not — it moves a thousand times a second
and every bump releases every parked poll, so the document carries a position plus the moment
it was true and the firmware advances it locally. Telemetry flows device→console and never
bumps either. The document also advances the playhead to the instant it is served, or one
that parked for eight seconds would hand over a playhead eight seconds stale on arrival.

Each channel's `item` is followed by two records **of its own keys**: `rev` fingerprints what
that channel would render to (it moves when the content does, and not when the name or the
refresh interval does), and `ttl` says how long that render stays true (`max(refresh interval,
animation length)`). The device fetches a channel's frames once and caches them, and an
`item`'s kind, id and label are all identical after any content edit — so before these two,
"the sign changed colour" was not expressible on the wire at all: the menu compared equal,
`seq` never moved, the parked poll was never released, and the only way to reach new pixels
was to turn the knob to another channel and back. `ttl` covers the other half: 大字天气钟 is
ten seconds of clock frames, nobody edits anything, no `rev` ever moves, and the minute it is
showing recedes further into the past every second.

They are **new keys rather than a fifth and sixth field on `item`**: deployed firmware matches
`item` on a strict arity of four and would drop the whole menu — and with it the channel ring
— if that line grew, whereas unknown keys are ignored by design and so can ship to any build.
Each record repeats its id, so the firmware indexes by id rather than trusting line order. The
device applies its own floor to `ttl` (5 s): a refresh costs it up to ~900 KB over the same
radio that is carrying the long poll, and the service holds a render in a 5 s cache, so
anything faster can only fetch bytes it already has. `GET /api/os/frames` answers with
`X-Os-Rev`, so the device records the revision it **actually received** rather than the one
the document advertised when it decided to ask — a save landing between those two moments
would otherwise make a brand-new bundle look stale on arrival.

The settings block carries three sequences for the same kind of reason. `setseq` says how new
the request is and the device acts only when it rises; `setvolseq` / `setbriseq` say **which
level the user just moved**. Both are needed, because the document **always** carries volume
and brightness together (the console's last request for each), so a device reading only the
values cannot tell "the volume slider was just dragged" from "the brightness slider was" from
"nothing was touched" — it had to act on both, which made every volume change also run a
zero-sized brightness nudge and draw the brightness bar over the volume one: **the user saw
the brightness screen while the volume did change**. Sequences rather than a "which field
moved" flag, because the long poll may coalesce: the console moves volume at seq 5 and
brightness at seq 6, the device reads one document, and a flag describing a single write would
lose the earlier one. The panel has one bar, so when both moved it goes to the **later** one
(the slider still under the user's finger), and when both moved in the same PUT it goes to
volume — brightness is visible in every lit pixel while a muted speaker is not, and volume is
the only choice that does not silently switch the side buttons into brightness mode. Sent as
**new keys** rather than a third field on `setvol`, for the same reason as `rev`/`ttl`; older
firmware ignores them and behaves exactly as it did before they existed. A console re-sending
the level the device is already at still advances the sequence — it means "the user moved this
control", not "this number changed", or dragging a slider back to where it started would
produce no feedback at all.

**Night sleep** is the same request-plus-rising-edge shape, with **one sequence** rather than
three:

```
sleepseq	4
sleepon	1
sleepfrom	1380
sleeptill	420
sleepidle	300
```

`sleepfrom` / `sleeptill` are minutes since local midnight and the end is **exclusive** (07:00
is already morning); `sleepfrom == sleeptill` means **the whole day** — a zero-length window is
useless, whereas an all-day screensaver is something someone would ask for and is the only way
to try the feature without waiting for night. Crossing midnight (23:00→07:00) is the **ordinary
case, not an edge case**. `sleepidle` is in **seconds**, not milliseconds: the value is
minutes-scale, has no sub-second meaning, and a short line is cheaper for an `atoi` parser.

**Each of the four lines is independently optional, and an absent line means "leave this one
alone"** — the absence itself, not a sentinel value. So `PUT /api/os/sleep {idleSec:600}` puts
`sleepseq` and `sleepidle` on the wire and nothing else, exactly as `setvol`/`setbri` are
withheld until written. The block used to emit all five keys once it started: a timeout-only PUT
therefore also carried `sleepon 0`, the firmware adopted it and wrote it to `/data`, and
adjusting the wait turned the feature off and lost the window. A field that HAS been written
keeps appearing forever, because the device may coalesce several writes into one poll.

One sequence rather than four, because the three settings sequences exist to say *which control*
the user moved on a panel with a single bar. There is no such display here and the four fields
are always written together by one console form. **Do not copy the three-sequence pattern
across.** Nothing is emitted at all until the console has written once: an unwritten default
sitting in every document would be a request the device could act on, and until a console
speaks this setting belongs to the device's own 设置 screen.

**The sequence is written down, in `.runtime/os-sleep-request.json`.** It was plain instance
state in the Bun process, so it started again at 1 after `bun start` — routine, since every
`web/` change needs a rebuild — while the device was still up holding the last number it had
applied. The 02:00 `{enabled:false}` that is the remote escape hatch then silently did nothing,
with the route answering 200 in front of it, until it had been pressed as many times as before
the restart. The file holds **what the console last requested** — the four optional fields and
the sequence they were named at — not the setting: the device persists the effective config to
its own `/data` and is the authority on it. The whole request is kept rather than the counter
alone because the document is *pulled*, so a field the device has not polled yet has to still be
in it; resuming both makes the first document after a restart identical to the last one before
it. The sequence is **resumed at, never bumped past** — starting one above it would manufacture
a rising edge nobody asked for and replay the console's old request over a window the knob had
since changed. A missing file (first run) or an unreadable one starts at 0 and logs
`os_sleep_request_restored` / `os_sleep_request_unreadable`.

**A sequence that went backwards means the service restarted, not a replay.** That is the
device's own second line of defence for the case above — a service whose file was lost, or a
console talking to firmware flashed before this existed. The device resets its counter and
adopts (`applySleepRequest` / `applyConsoleSettings`). Replays are still refused: a replay
repeats a number, it does not lower it.

The device answers on `/api/os/report` with a `sleep` block:

```json
"sleep": { "on": true, "startMin": 1380, "endMin": 420, "idleSec": 300,
           "asleep": false, "clockSynced": true }
```

**The presence of the block is the capability signal**, and stays one now that `proto` exists
beside it: it went out on a build that sent no `proto` at all, so a service reading night-sleep
support off the version number would think every such device lacked it. `asleep` is the whole answer to
"a black panel is ambiguous": the console says 已息屏 from this flag and **never infers sleep
from the pixels**, because black is indistinguishable from a dead clock — the rule
`describeMirror` already encodes for the offline case. The four config fields are the
**effective** values, which differ from what the console asked for whenever the knob moved
them, and are the only truth a form should render. `clockSynced` lets the console explain "sleep
is on but the panel is not sleeping" instead of leaving it looking like a bug.

`asleep` **is reported immediately on its edge** rather than on the 10 s cadence. The rest of
telemetry is a display and can be ten seconds old; this one field is what makes a console clear
its canvas, so a stale `true` paints a panel the user just woke as a blank one — and their
obvious second press is no longer swallowed, so it changes the channel. The full console
contract is [`docs/design/zos-night-sleep-console.md`](design/zos-night-sleep-console.md).

**While ZOS is resident the push stops; the render does not.** ZOS replaced the official app and
`POST /api/custom` went with it; what answers now is a setup portal that returns the config
page and HTTP 200 for **every** unknown path, so each push "succeeded": `updateCount` climbed,
`lastError` stayed clear, the console showed a healthy channel, and the pixels went into a 404
wearing a 200. Once the device has reported `flashed` — a fact only the device can know —
`pushChannel` skips the device write, and **skips nothing else**. The scheduled render has to
keep its interval: `renderChannel(channel, true)` is the only periodic call that passes
`forceRefresh`, and `forceRefresh` is the only thing that sends `getMarket` / `getWeather` to
the network. The device's own frame pull renders with `forceRefresh=false`, straight out of
those caches and with no age bound — so suspending the loop freezes every quote and temperature
at whatever was true when the service started, on a panel that still looks alive because the
clock digits read a live `nowMs`.

The **frame bundle** (`GET /api/os/frames?app=`) is raw RGB rather than GIF: the official
firmware decodes a GIF, ours does not, and adding a GIF decoder to re-encode pixels we already
have as pixels would be pure loss. The header is a fixed 8 bytes:

```
offset  size  field
0       4     magic "TCF1"
4       2     frame count, little endian
6       1     width
7       1     height
8       ...   per frame: u16 LE delayMs, then width*height*3 bytes RGB
```

Little endian because the device is little-endian ARM; the two u8 dimensions keep the header
at 8 bytes and are validated by the firmware against its own panel rather than trusted. Frame
delays are clamped to 20–60000 ms (0 ms would spin the device's play loop, a minute is a stuck
panel).

The **mirror** is a real capture, not a re-render: the LED bus is write-only and `/dev/fb0` is
unrelated to the matrix, so the only way to know what the panel shows is for the compositor to
tee it on the way out. A TypeScript re-implementation of the firmware's UI would be free to
drift from the C++ without any test noticing — this repository already has that cautionary
tale in seven C++ game engines beside four TypeScript ones. The device ships frames at 10 fps
(the panel runs at 25, but the console preview is a monitor, not a video feed, and each frame
is a separate HTTP exchange) and **only while someone is watching**: each console
`GET /api/os/mirror` both reads the frame and renews the subscription, so a console that stops
polling stops the stream ten seconds later with no explicit teardown to leak.

**Now playing** is resolved to text service-side. The device-facing music endpoint carries a
track *id*, which is useless on a 52×16 panel — the title only exists after the provider's
trackDetail call, which needs credentials the firmware does not have — and resolving it here
is also what lets the same lookup feed the lyric line. That poll is gated on the device
actually being attached (the firmware reports every 10 s, so the gate opens on its own),
because otherwise it would hammer a third-party API for a device nobody connected.

`lyricat` / `lyricend` are the **current line's** start and end in track time. Every display
mode's geometry, colouring and beat is a function of progress *within the line*, not of the
track: `pos`/`dur` describe the song, and one resolved lyric string has neither a start nor an
end, so without this window the device has nothing to animate. Both keys are optional: an older
service sends neither and the device falls back to a single sweep rather than to a blank
screen. `lyricat` is also what detects a new line in a chorus that repeats itself verbatim —
keyed on the text alone no sequence bump fires, and the device keeps animating the previous
window with progress pinned at 1, the line sitting there fully sung while the song moves on.

**`lyricend` is when the line stopped being SUNG, not when the next one starts.** This is the
easy mistake and the expensive one: the last line of a verse is followed by an instrumental, so
defining its end as the successor's start hands the whole break to the highlight. Measured on
孤勇者, "谁说站在光里的才算英雄" is sung for 5.29 s and the next line does not arrive for 18.55 s —
the wipe crossed eleven glyphs at 1686 ms each while the singer averaged 481. So `lyricend` is
the moment the singing stopped: the last word's end when the track has word-level timing
(NetEase `yrc`), otherwise the **minimum** of the next line's start, the source's own bare
end-mark timestamp, and a singing-rate cap of 630 ms per unit (the p90 of a measured
50-track / 2567-line corpus). It is never later than the next line.

`lyricuntil` is when the **next line takes over** — the line's display window — and is emitted
only when it is later than `lyricend`. **Only the cascade mode's entrance/exit choreography may
read it.** With `lyricend` now reaching 1.0 the moment the voice stops, keying the exit ramp on
it would fly the line off the panel at the start of a 13-second instrumental and leave the
screen blank. Colouring, focus glyph, fill bar, beat and scroll all run on `lyricend`'s clock.

**These three keys are handed out per firmware capability.** ZOS is flashed, so a service restart
does not change the build on the device, which makes the tightened `lyricend` a compatibility
problem in itself: an older firmware feeds it straight into `cascadeBandY`, whose exit ramp
reaches y = -16 at progress 1.0. The device therefore reports a `proto` — the document revision
it can read — in `/api/os/report`. Only `proto >= 2` receives the tightened `lyricend` plus
`lyricuntil` and `lyricw`; a firmware that has never sent one gets **byte for byte the document
it got before this change** (`lyricend` = the next line's start, neither other key), so cascade
never goes blank on it. A change of `proto` bumps the sequence once — once per device boot — so
a freshly flashed unit switches encoding without waiting for the next lyric line.

`lyricw` is the **per-glyph timing table**, `d0,w0,d1,w1,…`, each pair an offset and a width in
milliseconds relative to `lyricat`. The entry count **must equal** the codepoint count of the
`lyric` field *after* its 24-cell truncation; a mismatch voids the whole table and the panel
falls back to the line-level sweep — one cell out of step lights the wrong character for the
rest of the song and is invisible on a screenshot. It has to be a single comma-separated field
because `StateDoc::splitTabs(line, fields, 4)` stops after three tabs. Roughly 19-25% of NetEase
tracks carry word timings; for the rest the key is simply absent. A full 24-cell table measures
about 207 bytes, against a typical 319-byte document.

`mode` / `skin` / `accent` are the console's **主题设置** panel: four display forms (ticker /
skyline / spotlight / cascade), four palettes (signal / tape / blueprint / arcade), and an
`rrggbb` override of the palette's primary tier (the whole line is omitted when there is
none). They are the **same** state the sideloaded lyrics player reads from
`/api/music/device/state` (`sDeviceState`, ADR 0007) — the console has one theme panel and the
device has one panel, so a second store would only be a copy somebody keeps equal by hand:
pick tape under ZOS, sideload the player for local audio, and get signal back.

Three things worth recording. **They sit outside the `np` block**, because the three empty
states (未配置 / 离线 / 未播放) need a palette too, and nesting them under `np` would drop the
theme to the defaults the instant playback stopped — the colour would walk off the panel with
the music. **There is no `themeseq`**, making this the one console→device channel without a
sequence: `setseq` exists because volume has a second writer (the knob), and the theme has no
local control to fight on ZOS's music screen (the knob is prev/next, the press is play/pause,
and the side buttons are deliberately left to volume), so applying it unconditionally on every
document is idempotent — and is also what makes a device correct on its *first* poll rather
than on the first click after boot. A local theme cycle added later must arrive with a
`themeseq` and rising-edge gating, or the console's stale value snaps back on the next poll.
**The device keeps its own copy in `/data/zos-prefs.ini`** as a warm-start cache: a cold boot
has no link for several seconds — and a flashed unit with no `/tmp/zos-host` never gets one —
so the defaults would repaint the panel green in front of a user who chose orange months ago.
Writes go through the existing debounced commit (`DeviceControls::flushIfDue`); `/data` is
jffs2 on raw NAND and committing per document would put a flash erase in the poll path. The
document is authoritative the instant one arrives.

**The service keeps a copy too**, in `.runtime/lyric-theme.json`, read back into `sDeviceState`
before the HTTP handler is built. `sDeviceState` is module memory, so without this a restart
served spotlight/signal — and because the device applies the document's theme unconditionally
(above), that one poll both repainted the panel green and overwrote the device's `/data`
warm-start cache, which is the situation the cache exists for. Three fields and nothing else, so
it is a whole-file rewrite rather than a merge, and no `0600`: there is a colour in here, not a
credential. Writes are queued rather than merely fired, because two racing renames land in the
order they finish rather than the order they were asked for. The console's `localStorage` is
demoted to a first-paint cache by the same decision: the page draws one frame from it and the
first `/state` poll replaces it. Pushing `localStorage` at the service instead would make
whichever browser loaded last the authority — a phone that has not seen the theme panel in a
month could repaint the clock from memory.

### Sideloading and the `host` file

Sideloading uses the same parameterized installer as the music and arcade firmwares
(`/api/os/device-app/*`, confirmation phrase `START_TC002_OS_SESSION`): per-file SHA-256
against the release manifest, the device identified through both its official HTTP API and
Wi-Fi ADB, and an explicit restore acknowledgement. Everything lives in tmpfs and flash is
never touched. **A power cycle restores the official firmware**: `/tmp` is wiped, the
framework falls back to `/res/etc/EasyUI.cfg`, and the official app returns with its own Wi-Fi
setup page. That is the universal rescue for anything this firmware gets wrong. The console
has no ZOS sideload panel yet (music and arcade each have one), so these four routes are
called directly for now.

ZOS adds one step the other two do not have: **the bundle must carry a `host` file with the
console's address.** Nothing on this LAN announces the service — it is a Bun process on
someone's laptop, not a router service with a name — so the device has to be told. The entry
script moves `host` to `/tmp/zos-host`, and the firmware reads it at startup (it also accepts
`/tmp/tc002-os/host`, where the push leaves it). All three shapes a human would write are
accepted:

```
http://192.168.8.185:43820     # complete
192.168.8.185:43820            # http:// added
192.168.8.185                  # http:// and :43820 added
```

A missing file is not an error — the firmware runs standalone, it just has no channels and no
mirror. The entry script's move is guarded for that reason: `set -e` would otherwise turn "no
console configured" into a failed launch and a blank panel.

**BLE provisioning updates this address in passing.** Changing Wi-Fi usually means the laptop
moved networks too — the two facts travel together — so the `join` command may carry an extra
`host` field. The device adopts it only after that join actually comes online, writing
`/data/zos-host` (temp file, fsync, rename — jffs2 will happily rename an unflushed file) and
restarting the pull loop in place, with no process restart. A failed or aborted join drops the
pending address, or a stale one would ride the next success. Which address the console sends:
the one the browser reached this page at, when it is not loopback (it has proven it routes),
otherwise the service's own LAN address — provisioning is normally done ON the machine running
the service, where the page address is 127.0.0.1 and useless to the clock. When neither is
usable it sends **nothing** and the device keeps the address it has: the write is an overwrite,
and a confidently wrong address costs more than silence. https is never sent — the firmware only
builds `http://` URLs.

**The six-digit code guards this one field and nothing else.** The code on the panel is gated on
the **capability**, not on the flow:

| Command | Code? |
|---|---|
| `scan` | No. It lists SSIDs already being broadcast to everyone in range |
| `join` with only `ssid`/`psk` | No. Exactly the stock firmware's power — and stock ships with **no** code, PIN or QR at all |
| `join` with a `host`, on a device that has adopted no console yet | No. There is nothing to take over; this is first-run setup |
| `join` with a `host` that **differs** from the adopted one | **Yes.** After this the clock answers to a different console |

The asymmetry is the whole rule. A stock join can only put the clock on a Wi-Fi network; ours can
also rewrite `/data/zos-host` — the address this firmware will poll for the rest of its life.
Accepting Wi-Fi credentials from a stranger is a nuisance; accepting a console address from a
stranger is handing over the device. So presence is proven at that one point and on none of the
other three paths.

The comparison is against the address the device is **actually polling** (`HostLink::baseUrl`, fed
to the session on every 160 ms tick) rather than a copy taken at boot — a single join changes it in
place. `host`, `host:port` and `http://host:port` are folded through `ble::consoleUrl` first and
hostnames compare case-insensitively (DNS does), so spelling the same address differently is not a
takeover. A refusal answers `evt state err=host-code` and changes **nothing**: the console raises
the code prompt, and on success re-sends the identical join — the password is not retyped. The code
itself is unchanged: minted per advertising session, five wrong tries then a 60 s lockout, never
logged.

### Console discovery (the LAN beacon)

The `host` file above is written **once**: the device records the address in `/data/zos-host`
and polls it for the rest of its life. But the console is a Bun process on a laptop holding a
DHCP lease. The day that lease moved from `.108` to `.114`, the clock kept knocking on `.108`.
The panel still told the time, so nothing looked wrong — but telemetry stopped, the console
could not see the device, and an OTA request could never reach it. **Silent from both ends**,
and the only fix was a cable and `adb push`.

So the console broadcasts a hint; the device takes it only when it is already lost, and only
after proving the hint is real.

**The payload.** One ASCII line, UDP, to the local subnet's *directed* broadcast address
(`address | ~netmask`, e.g. `192.168.8.255`), port 43821, roughly every 10 s:

```
ZOSCON1\t<host>\t<port>\n
```

`ZOSCON1` is a version tag — a future change gets a new tag so a device that only understands
this one cannot misread it. `<host>` is the address the device should poll: the machine's LAN
IPv4, not `127.0.0.1` and not a hostname. **The trailing newline is the frame**: a datagram
without it was cut short and is rejected, rather than read as a shorter address. Nothing is
sent to `255.255.255.255` — an unbound socket is refused with `EADDRNOTAVAIL` on macOS
(measured), and where a global broadcast does work it leaves the kernel to pick a route, which
on a laptop with a VPN or a container bridge up is the wrong interface.

**Which interface.** This reuses the console's existing rule (`selectControlAddress`, the same
one behind the phone-control popover): **the interface whose subnet contains the clock wins**,
then any private IPv4, then the first non-internal one. That is a deliberate refinement of
"prefer the interface carrying the default route", and the two diverge on a machine this
project actually runs on: with a corporate VPN up the default route is the tunnel, whose
address the clock cannot reach, while the clock's own /24 is unambiguous about which NIC faces
its LAN. Remaining ties fall to enumeration order, and the result is logged
(`console_beacon_announcing`, on **change** only).

**Four gates on the device, all of which must hold**
(`device/tc002-os/app/src/net/ConsoleDiscovery.*`):

| # | Gate | Test |
|---|---|---|
| 1 | **Already lost** | No successful pull for ≥ 60 s. A clock that is talking to its console does **not even parse** these — the datagram is drained and dropped |
| 2 | **On the device's own /24** | Compared with wlan0's current address (`platform/NetInfo`). Not much of a boundary, but it stops a hint from another subnet |
| 3 | **Different from the address in use** | All three spellings folded through `ble::consoleUrl` first, or every beacon would pointlessly restart the pull loop |
| 4 | **The candidate answers as a console** | **One** `GET /health` *before* `/data/zos-host` is touched, requiring a 200 whose body contains `"service":"ulanzi-tc002-content-hub"`. A host that merely shouts on the wire is not a console |

Only then is `/data/zos-host` rewritten (temp file, fsync, rename) and the pull loop restarted
in place — through the same `adoptConsoleHost` the BLE path already uses, not a second copy of
it. The event goes to `ProvisionLog` as
`host-discover from=<old> to=<new> outcome=adopt|not-a-console`. logcat is banned on this unit,
so that file is the **entire** record of a device that changed the address it polls; a refusal
is logged too, because otherwise a clock that stays lost while a console is plainly on the air
leaves no trace at all.

A device that was never given a console (`/data/zos-host` empty) counts as lost from its
sixtieth second, so it adopts the first service that both broadcasts on its subnet and answers
as a console. That is not an extra rule — it falls straight out of the four gates above.

**No crypto, no shared secret, no HMAC — deliberately.** The console's write API is guarded
only by a same-origin check, and a same-origin check stops browsers, not `curl`: anyone already
on this LAN can push firmware to the clock today. **The LAN is therefore already the trust
boundary** and this feature does not widen it. What the BLE pairing code guards is a
*different* attacker — someone in Bluetooth range who is **not** on the Wi-Fi — and that
defence is untouched.

### Wi-Fi and provisioning: how far it goes

**Working today:** the firmware runs its own HTTP server and serves the provisioning page on
the device's **normal address, port 8080** — `GET /` for the page, `GET /scan` for the network
list, `GET /status` for state, `POST /connect` for the submission. The page is entirely
self-contained: no CDN, no web font, no external stylesheet, because a phone attached to a
hotspot has no internet and any of those turn the setup screen into a spinner with no
explanation. The network list comes from wpa_supplicant's `SCAN_RESULTS` over its control
socket (the last sweep's cache — reading it does not start a sweep), sorted by signal and
de-duplicated, so the user only types a password: one wrong character in a hand-typed SSID
looks exactly like a wrong password, and the user cannot tell which they got wrong. The
settings screen shows this address.

Port 8080 rather than 80 because binding a privileged port would require still being root at
that point, and nothing needs the well-known port while the device has a normal address. The
server runs on its own thread — `serveOnce` blocks until a connection arrives or its timeout
expires, which is exactly wrong for a 25 fps UI tick.

**Deliberately inert:** the half that actually changes the link sits behind the guard file
`/tmp/zos-allow-link`. The device-side actuator (`platform/DeviceWifi.h`) is split down that
line: the read-only half (is it running, are there stored credentials, are we associated, do we
have an address, scan results) is always live because none of it can change what the radio is
doing; the mutating half (start the supplicant, connect, request DHCP, start/stop the hotspot,
start a scan) re-reads the guard file and refuses without it. So does the page's submit — and
it reports `link-locked` **at the moment of refusal** rather than pretending to work and letting
the status flip to "failed" a poll later. A page that accepts credentials and silently does
nothing is worse than one that reports the refusal: the user would sit waiting for a
reconnection that was never going to happen. The sideload installer does not create the file,
so on a normal install the code is compiled in, reachable from the UI, and physically incapable
of acting. It lives in tmpfs on purpose: `adb shell touch /tmp/zos-allow-link` arms an
experiment and a power cycle disarms it with no way to forget.

**Not implemented:** the hotspot (SoftAP). `WifiPolicy` has the states and the actuator has the
entry points, but `startSoftAp()` / `stopSoftAp()` currently log a line and return. The recipe
is known (stop wpa_supplicant, write hostapd.conf, run hostapd, hand out addresses), but every
step of it touches the link adb rides on — and the SDK's `SoftApManager` is exactly what
[ADR 0007](adr/0006-no-flythings-network-managers.md) forbids linking. **A device with no stored
credentials therefore cannot currently be provisioned by ZOS itself**, and the four-screen
hotspot flow in `docs/design/tc002-os-provisioning.md` remains a design rather than an
implementation.

That boundary is worth reading in full: those managers own the radio's power path and call
rmmod/insmod against module directories that **do not exist** on this unit. One trip through
that branch and `wlan0` is gone — and adb rides that link, so recovery is a physical power
cycle. ZOS therefore links libzknet for exactly one function
(`NetUtils::dhcpRequestIp`), does everything else over wpa_supplicant's control socket, and
enforces it at the binary level with `device/tc002-os/hostcheck/link-audit.sh`.

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
| `GET` | `/api/vibe/status` | The VIBE usage snapshot plus the provider catalog, the starred table, and `keys` (per key-based vendor: `stored` / `environment` / `unset` — **never the key itself**) (read-only, cross-origin). `?refresh=1` forces a re-collection; otherwise the cache answers. Nothing being signed in is **not an HTTP error**: still 200, with `snapshot: null` and an `error`, which is what the console renders its sign-in / paste-a-key pointer from |
| `PUT` | `/api/vibe/starred` | Choose which metrics an agent shows on the panel: `{providerId, starred}`, at most 2 after de-duplication; the reply is the full starred table merged with the catalog defaults (same-origin + JSON, 400 on validation failure) |
| `POST` | `/v1/push` | Usage pushed by the remote collector. **No same-origin check** (the agent is not a browser and sends no Origin), so `Authorization: Bearer $VIBE_INGEST_TOKEN` is the whole of its authentication. With `VIBE_INGEST_TOKEN` unset every push is 503 with the variable named in the error; a wrong token is 401; a malformed envelope is 400 saying what is wrong. The envelope is `{schema:"vibe.usage.v1", machine, sent_at, snapshots, errors}` (`errors` optional, absent from older agents), shaped like openusage's hub `/v1/push` ([ADR 0013](adr/0013-vibe-remote-usage-agent.md)) |
| `DELETE` | `/api/vibe/ingest/machine?machine=…` | Forget one machine's pushed rows (the console's 「移除」 button, same-origin). Replies `{forgotten, machines}`; `forgotten:false` means it was not known. This forgets only — an agent still running over there reappears on its next push |
| `PUT` | `/api/vibe/key` | Store an API key for a key-based vendor: `{providerId, key}`, an empty string clears it; the reply is only the `keys` state table and **never echoes the key back** (same-origin + JSON, 400 on validation failure). **All four agents borrow a CLI login today, so the key-vendor list is empty and every `providerId` gets a 400** |
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
| `GET` | `/api/music/netease/daily` | NetEase 每日推荐 (daily recommendations; needs the login cookie — an upstream failure is reported, never rendered as an empty list) |
| `GET` | `/api/music/netease/liked/random` | One random playable song from 喜欢的歌曲 (needs the login cookie; draws 8 and uses a single `song_detail` to skip ones taken down) |
| `GET` / `POST` | `/api/music/device-app/*` | Validate the firmware bundle, probe the device, sideload / restore (tmpfs session) |
| `POST` / `DELETE` | `/api/music/mirror` | Push lyric frames (≤400) to a stock-firmware Custom App (device mirror) |
| `POST` | `/api/music/device/select`, `/api/music/device/control` | Web-side track selection and control patches |
| `GET` | `/api/music/device/state`, `/api/music/device/current` | Plain-text control state polled by the firmware; legacy current-track poll |
| `POST` | `/api/music/device/report`, `/api/music/device/heartbeat` | Firmware key-action reports and playhead heartbeats |
| `GET` | `/api/music/device/now`, `/api/music/device/audio` | Firmware-side lyric fetch and audio download. `/now` is versioned by query parameter: no `?v` returns the original `DUR\t<ms>` + `<startMs>\t<text>` bytes verbatim (a deployed parser treats any non-`DUR` key as a start time, so a new record type would render as garbage), `?v=2` returns `V\t2`, `DUR`, `L\t<startMs>\t<sungEndMs>\t<text>` and an optional `W\t<d0,w0,…>` table for the line above it |
| `GET` / `POST` | `/api/os/device-app/*` | The same sideload lifecycle for ZOS (confirmation phrase `START_TC002_OS_SESSION`) |
| `GET` | `/api/os/pull` | ZOS long-polls the state document (`?seq=`, parks up to 8 s; line-oriented `KEY\tVALUE` plain text, cross-origin) |
| `GET` | `/api/os/frames` | ZOS fetches one channel's rendered frames by `?app=` (`TCF1` raw-RGB binary, cross-origin) |
| `GET` | `/api/os/firmware` | The device fetches the **armed** image (cross-origin). Resolution: `.runtime/tc002-os/uploaded/update.img` (uploaded) wins, and only then `.runtime/tc002-os/update.img` (what `mise run os-image` packs). Two writers, two paths, neither able to reach the other's — an upload landing on the packer's path would mean the next `os-image` silently replaces the image the owner chose. Carries `Content-Length` and `ETag` / `X-Build-Id` — **that id is the MD5 inside the container header**, the one the vendor updater itself verifies, not `ZOS_BUILD_ID`: the git rev is compiled into libzkgui.so behind an xz squashfs, and decompressing a megabyte per request is not a status endpoint. 404 when neither exists. The path is a constant named by the composition root; nothing on the request can move it |
| `POST` | `/api/os/firmware` | The owner uploads an image: `multipart/form-data`, field `file`, **same-origin**. Body ceiling 8 MiB + 768 bytes (the `res` partition plus a container header); anything larger is a 413 before the body is read. Validated before it is stored, by the module the packer itself uses (`device/tc002-os/release/zkswe-image.ts`): magic, length bounds, a self-consistent container (header CRC-32 and the per-item MD5), and **a flash target of type 3 `res`**. That last one matters most — an image aimed at another partition is not a failed install, it is a brick, and the device's updater is a bitmask over partition type that will do what it is told. A refusal is `{error, reason}` with `reason` ∈ `magic` `too-short` `too-long` `malformed` `digest` `partition`, and **nothing is written**: whatever was armed before is untouched. Success replies with the same document as `GET /api/os/firmware/status`. **Uploading is not installing**: this route never touches an upgrade sequence |
| `DELETE` | `/api/os/firmware` | Drop the upload so a locally packed image takes over again (same-origin). Replies `{removed, ...status}`. Without it, uploading once is a one-way door: the console could never get back to `os-image`'s output |
| `POST` | `/api/os/firmware/restore` | Arm the **stock-firmware restore point** (same-origin, body `{}`). Reads the path fixed in the composition root, `.runtime/tc002-stock/restore-live.img` — the path is not an input, because this route decides which bytes get written to flash and letting a caller name the file is letting a caller name the firmware. It goes through **exactly the same validation an upload takes** (`storeUpload`), so a restore point that has rotted on disk fails here, loudly, rather than at the moment the device has already erased mtd3. 404 when no restore point is configured, 409 when one is configured but absent (saying it cannot be recreated), 400 on an invalid container. On success it replies with the same document the status route serves, and `source.kind` is `upload` — so 移除上传 still puts the ZOS build back; arming the stock image is not a one-way door either. **Arming is not installing**: the install is still the separate, separately consented `/api/os/upgrade` |
| `POST` | `/api/os/report` | ZOS telemetry every 10 s: `{screen, focus, wifi, ip, uptimeMs, freeKb, supplicantRestarts, proto, batteryPercent, batteryMillivolts?, charging, sleep?}` (strings truncated at 64 chars, cross-origin; bumps seq only when `proto` changes). `sleep` is `{on, startMin, endMin, idleSec, asleep, clockSynced}`, and **its presence is the night-sleep capability signal**; out-of-range values inside it are clamped rather than failing the whole heartbeat. `charging` means USB power and nothing else — it is not derived from voltage. `batteryMillivolts` is the cell voltage (warn below 3600 mV, 30 s shutdown countdown below 3550 mV), and **the firmware's shutdown protection runs on it while `batteryPercent` is display only**. Both use `-1` for "no reading yet"; `batteryMillivolts` is **absent entirely** on firmware from before it existed, and absent means something different from `-1` — the console shows the voltage only when it is present |
| `POST` | `/api/os/mirror` | ZOS uploads a captured panel frame (body is 2496 raw RGB bytes, cross-origin); the reply `{wanted}` tells the device whether to keep streaming |
| `GET` | `/api/os/mirror` | Console reads the latest frame — **asking is the subscription**: stop polling and the device stops streaming 10 s later |
| `GET` | `/api/os/state` | Link snapshot `{seq, menu, display, telemetry, live, mirrorWanted, upgradeSeq, zosFlashed, requestedSettings, requestedSleep, pendingInputs, lyricTheme}` (live means a report arrived within 15 s). `upgradeSeq` counts installs ever asked for, so the console can see a request is outstanding — the device reboots to install, and there is no other receipt in between. `telemetry` also carries `ageMs` and `seq`: `seq` counts reports ever received and never resets — `live` only says the device spoke recently, which is still true of a clock being re-provisioned that never left its old network, so "the device came back" has to be decided against a `seq` captured before the join |
| `GET` | `/api/os/firmware/status` | For the console: `{packed, image, source, shadowedPacked, restore, upgradeSeq}`. `image` is `{bytes, buildId, builtAt, md5, partitionType, partitionLabel, payloadBytes, zosBuildId, filesystemBuiltAt}` or `null` — `md5` is the digest of the **whole file** (the number an owner can check by running `md5` on their own copy) while `buildId` is the in-band digest the device verifies; they are not the same number. `zosBuildId` is set only when the `<rev>-<stamp>` string is genuinely recoverable from the payload; in a packed image it sits inside an xz squashfs, so it is normally `null` and the console says 未知 — it must **never** derive something version-shaped from a size, an mtime or a digest. `filesystemBuiltAt` is the squashfs mkfs time, which the packer pins to the mtime of the `.so` it packed: the one "which build is this" clue that survives xz. `source` is `{kind:"upload"\|"packed", fileName, at}` — losing track of which is which is how someone installs yesterday's build believing it is today's. `shadowedPacked` is a locally packed image that exists and will **not** be installed (non-null only while an upload is armed). `restore` is the stock-firmware restore point — `{available, path, bytes, builtAt}`, or `null` on a service too old to say. "No restore configured" and "configured but the file is gone" are different facts and the console says different things about them. `builtAt` is the armed image's mtime; `packed` is stated rather than inferred from the presence of the other fields, because it sits next to a button that rewrites flash |
| `POST` | `/api/os/upgrade` | Ask the device to install the armed image: body `{}`, reply `{seq}`. **409 when nothing is armed** — the sequence would reach the device, the device would fetch the image, get a 404 and stop, while the console claimed an install was under way. The device honours a given sequence once per boot; installing reboots it, so the link going quiet mid-way is by design rather than a fault |
| `POST` | `/api/os/ble` | Ask the clock to advertise over Bluetooth for five minutes: body `{}`, reply `{seq}`. The remote equivalent of pressing 设置 → 配网 on the device — ZOS advertises only **while offline** or inside the five minutes that row opens, so a clock that is online and working (exactly the one whose owner is moving it to a new router) does not exist in the browser's chooser. **No precondition**, unlike `/api/os/upgrade`'s 409: there is nothing equivalent to "not packed" to be missing, and a clock too offline to read the request is already advertising by itself. The sequence is seconds-since-epoch and the device acts **only on a rising edge**, so a repeated `bleopen` does not re-open the window on every long poll |
| `PUT` | `/api/os/display` | Send ZOS to a channel and lock the knob: `{focus, pinned}` |
| `POST` | `/api/os/input` | Press one of the device's own controls on the user's behalf: `{action}` ∈ `cw` `ccw` `press` `hold` `left` `right`; the reply `{event:{seq,action}}` is the receipt. Only the last 8 stay in the document — a press the device missed by more than a moment is one the user has already given up on, and replaying it late is worse than dropping it |
| `PUT` | `/api/os/settings` | Ask the device to adopt a volume/brightness: `{volume?:0..6, brightness?:1..10}`; 400 when both are absent. Carries `setseq` and is applied **only on a rising sequence**, or the console's old value in every document would override the knob the user just turned. Only the field named in the request is stamped: the other one stays in the document with its own `setvolseq` / `setbriseq` unmoved, so the panel raises a bar only for the level the user actually touched |
| `PUT` | `/api/os/sleep` | Ask the device to adopt a night-sleep configuration: `{enabled?:boolean, startMin?:0..1439, endMin?:0..1439, idleSec?:30..7200}`; 400 when all four are absent, and 400 out of range. Replies `{requested:{enabled,startMin,endMin,idleSec,seq}}`, where a field the console has never written is **`null`** rather than a default — only written fields go on the wire, so a timeout-only PUT cannot also move the window. `startMin == endMin` means **the whole day** rather than a zero-length window and must be accepted. **Every write bumps the sequence, and the sequence is persisted to `.runtime/os-sleep-request.json`** — the device's own 设置 rows are a second writer, only a rising sequence can overrule the knob, and a counter that restarted at 0 with the service would have its next change refused. A rising sequence also counts as the user operating the clock, so `{enabled:false}` does not merely stop it sleeping again, it **lights the panel now**: the remote escape hatch for a clock that went dark with nobody in the room |
| `PUT` | `/api/os/now-playing` | The browser reports what it is playing: `{track, artist, playing, positionMs, durationMs, lyric, lyricStartMs?, lyricEndMs?, lyricUntilMs?, lyricWords?}` (`lyricEndMs` is when the line stopped being *sung*, `lyricUntilMs` when the next one starts; `lyricWords` is `[{startMs,endMs,text}]`, at most 64 entries of ≤16 chars and ≤200 chars total, dropped rather than rejected when malformed); a `null` body (or a missing `playing`) clears it. NetEase is device-audio — the browser *is* the player and nothing else can see it — while Spotify is polled service-side off Connect. The two writers arbitrate by "last writer owns it, silence never evicts sound, 15 s of quiet releases the field" |

Writes accept JSON only and require same-origin requests (except the firmware-facing
`report` / `heartbeat` endpoints and ZOS's `/api/os/pull`, `/api/os/frames`, `GET /api/os/firmware`,
`/api/os/report` and `POST /api/os/mirror`, whose caller is the clock rather than a browser and has no Origin
to send — note that only the image **GET** is exempt; the `POST` / `DELETE` on that same path are
writes and take the same-origin check like every other write; `POST /api/os/mirror`'s body is raw RGB rather than JSON, because a base64 JSON
envelope would cost a third more bytes per frame for nothing the firmware can use); the
request-body limit is 256 KiB.
Limits: 24 channels, 48 items per channel, 360 rendered frames per channel; app names are
unique and restricted to 1–32 ASCII letters, digits, underscores, or hyphens.

`POST /api/os/firmware` and `/api/library/video/import` are the only two `multipart/form-data`
writes: the body is a file, and a base64 JSON envelope would cost a third more bytes to say the
same thing. What that costs is worth stating — a cross-origin `<form>` can set
`multipart/form-data` by itself, so the `Content-Type` rule that quietly guards the JSON routes
does nothing here, and the same-origin check is the **only** door.
