# Ulanzi TC002 Pixel Studio

[简体中文](README.md) | English

An extensible, Bun-powered multi-channel content studio for the Ulanzi TC002. Market data, notices, timers, visual animations, and a 52×16 canvas all implement one frame-rendering contract and are composed and pushed by a central scheduler.

![Ulanzi TC002 multi-channel content studio control panel](docs/images/tc002-control-panel.png)

## Content model

- A **channel** maps to one TC002 Custom App name and therefore one item selectable with the physical knob.
- A **content item** is one segment inside a channel. One item is standalone; multiple ordered items become one animated GIF carousel.

Renderers only return 52×16 frames and explicit delays. They cannot write to the clock or start background loops. The controller owns shared data caching, bounds validation, GIF encoding, serialized device writes, failure isolation, cleanup, and scheduling. See [ADR 0001](docs/adr/0001-extensible-content-channels.md).

## Built-in catalog

| Category | Content |
| --- | --- |
| Market | BTC, ETH, BNB, SOL, gold, USD/CNY, AAPL, MSFT, NVDA, GOOGL |
| Tools | Notice board, interval timer column |
| Visual | Langton's ant, aquarium, fire, flip clock, Matrix clock, maze, pixel pet, falling sand, starfield |
| Creative | Persistent 52×16 canvas, plus Ulanzi community pixel assets imported through the dedicated library (PNG / GIF) |

The four stocks use Yahoo Finance's public Chart endpoint. Their 16×16 marks preserve the exact PixDeck source PNG bytes and opaque pixel layouts; provenance and SHA-256 hashes are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The canvas supports pen/eraser tools, colors, grid, undo/redo, ASCII pixel text, image pixelization, and PNG export. A saved canvas is a normal content item, so it can be standalone or part of a carousel.

The top-level **Library** tab sits next to **Content** and **Canvas** and provides a wide workspace for browsing, searching, filtering, or importing a public Ulanzi community asset from a `ugc.ulanzistudio.com/contentView/...` link. The channel rail selects the destination for **Add to channel**, while any work can also become a standalone app.

The upstream catalog is not hard-coded. Entering the Library, reloading, searching, changing filters, or paging requests the official API again, so upstream additions, removals, and edits appear on the next request. Imported media remains a stable local snapshot and is never silently replaced by later upstream changes. Assets are restored to 52×16 with nearest-neighbor sampling, GIF timing is preserved, and normalized media is stored under `.runtime/pixel-assets`, so later previews and pushes do not depend on the upstream site. The import endpoint only adds a channel item or creates a standalone app; it never bypasses the existing channel pipeline to write the device directly. Delivery then follows the project's existing scheduled and manual channel push behavior. Community artwork is not bundled, and author/source attribution is retained.

## Control panel

Start the service and open:

```text
http://127.0.0.1:43820/
```

The left rail manages clock channels, the center edits and previews the selected channel, and the right-side catalog is grouped by Market, Tools, Visual, and Creative. The top navigation exposes four first-class views: **Content**, **Canvas**, **Library**, and **Music**. The top-right **General settings** dialog reads and writes brightness, volume, paging, scrolling, timezone, date, weekday, and low-battery sleep settings. Its title-bar phone icon reveals the same-subnet QR code, current URL, and copy action only when needed instead of occupying the settings landing area.

Phone portrait mode separates **Channel composition** from **Add content** so the catalog is never buried below the editor. Adding an item returns directly to the new playlist row, while channel settings and the large device preview stay collapsed until requested. Bottom navigation, the horizontal channel picker, and single-column forms are laid out for touch. The canvas asks phone users to rotate to landscape so the 52×16 surface and tools retain accurate targets. Desktop keeps the existing three-column composition.

<p align="center">
  <img src="docs/images/tc002-mobile-content.png" width="390" alt="Ulanzi TC002 Pixel Studio mobile channel composition">
</p>

The UI ships a Web App Manifest, home-screen icons, standalone metadata, and an offline static shell. A supporting browser can add it to the home screen for an app-like window. Full PWA installation and Service Worker offline caching require a trusted HTTPS origin; plain LAN HTTP still provides the responsive control panel and any home-screen shortcut mode offered by the browser.

The frontend uses React, Cladd UI, and Tailwind CSS v4. Cladd standardizes controls, tabs, selects, deletion confirmation, tooltips, toasts, and draggable numeric inputs while the product keeps its existing black, white, and green Pixel Market visual language. Motion respects `prefers-reduced-motion`.

Configuration is stored in `.runtime/workspace.json`. A legacy `.runtime/settings.json` is atomically migrated into one market channel on first launch without overwriting the legacy file. Disabled, removed, or renamed channels are cleaned from the clock by posting an empty object to their former Custom App names.

## Pixel lyrics player

The first-class **Music** workspace is a complete music console: NetEase Music QR login, search
with 20-per-page pagination, signed-in playlists, timed lyrics with translations, a same-origin
audio proxy, and a live 52×16 pixel lyric preview. The login cookie stays only in
`.runtime/music-session.json` with mode `0600`; neither the browser nor the TC002 receives the raw
credential, and logout removes the file. Playback remains subject to account, subscription,
copyright, and regional availability. A 45-second preview is presented as a preview rather than a
full track.

The preview and the device share one theme system: four display modes (ticker / skyline /
spotlight / cascade) × four palettes (signal green / tape orange / blueprint / arcade red), plus a
color-picker accent override.

Two complementary paths put lyrics on the clock:

- **Device mirror (stock firmware, no flashing)**: pushes the rendered 52×16 lyric frames (up to
  60 frames, ~15fps) through the stock firmware's Custom App channel; audio plays in the browser.
- **Native music firmware (non-persistent sideload)**: the repository contains a complete
  FlyThings C++ player — cross-compiled in Docker, no Windows IDE required — that downloads the
  audio on-device, plays it through the speaker with millisecond seeking, and drives the LED matrix
  directly using offline-rasterised 12×12 CJK glyphs (Chinese + Japanese kana/kanji). Web and
  firmware stay in **bidirectional real-time sync** over a control-sequence + heartbeat protocol:
  web-side select/pause/theme/seek reaches the device within 2 s, device-side key presses flow back
  instantly, and the preview clock anchors to the real playhead. In this mode the web page is a
  silent remote. The UI detects the firmware automatically.

Sideloading is always non-persistent: the TC002 normally runs the official firmware, a session
only pushes the player into the device tmpfs, and ending the session — or any power cycle —
restores the official firmware because flash is never written. Starting a session still requires
the bundle to match its per-file SHA-256 manifest, the official HTTP API and Wi-Fi ADB to both
identify the device, and the user to acknowledge the restore path. Firmware sources, the protocol,
build, and deployment live in
[device/tc002-lyrics-player](device/tc002-lyrics-player/README.md); the architecture boundary is
[ADR 0002](docs/adr/0002-native-music-player-boundary.md).

MQTT alone cannot make the stock firmware play music: it can carry control messages, but only a
native device application can invoke `AudioManager` / `MediaPlayer` — which is exactly what the
sideloaded firmware does.

## HTTP and MQTT

The implementation intentionally keeps the TC002-native `POST /api/custom?name=...` HTTP transport. For a local renderer writing complete Custom Apps to one LAN device, it needs no broker and has explicit update and delete semantics.

Transport is injected behind `pushPayload(appName, payload)`. An MQTT adapter can be added later for Home Assistant, remote buses, or multiple subscribers without changing any renderer; no broker dependency is required today.

## Development

`mise.toml` pins Bun 1.3.14:

```bash
mise install
mise run test
mise run typecheck
mise run build
CLOCK_HOST=192.168.1.50 bun start
```

Generate channel images and preview strips under `.runtime/previews/`:

```bash
bun run preview
```

Install as a macOS LaunchAgent or Docker Compose service:

```bash
bash scripts/install.sh --host 192.168.1.50
bash scripts/install-docker.sh --host 192.168.1.50
```

The native macOS installer listens on `0.0.0.0` by default so phones on the same LAN can connect. Open General settings and use its title-bar phone icon to scan or copy the selected same-subnet URL. Pass `--control-host 127.0.0.1` to keep it Mac-only. Docker Compose remains published to host loopback only.

The installer also records the absolute `adb` executable as `ADB_BIN`, because a LaunchAgent does not inherit the interactive shell's Homebrew path. Use `--adb-bin /absolute/path/to/adb` or set `ADB_BIN` to override auto-detection.

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
| `GET` | `/api/access` | Report the same-subnet phone URL and listener status |
| `GET` | `/api/library/ulanzi/pixel-assets` | Browse, search, filter, and page through official community assets |
| `GET` | `/api/library/ulanzi/media` | Safely proxy official preview media |
| `POST` | `/api/library/ulanzi/import` | Validate and import an official `contentView` link or work ID |
| `GET` | `/api/library/ulanzi/imported/:ref` | Read a normalized local asset snapshot |
| `GET` | `/api/music/session`, `/api/music/avatar` | Read the sanitized NetEase login state and proxied avatar |
| `POST` | `/api/music/qr`, `/api/music/qr/check`, `/api/music/logout` | Create/confirm a server-held QR session; log out and delete the local credential |
| `GET` | `/api/music/search`, `/api/music/playlists`, `/api/music/playlists/:id/tracks` | Search tracks, read playlists and their tracks |
| `GET` | `/api/music/tracks/:id` | Read track metadata and timed lyrics |
| `GET` | `/api/music/tracks/:id/stream` | Same-origin, allowlisted audio proxy with Range support |
| `GET` / `POST` | `/api/music/device-app/*` | Validate the bundle, probe the device, and start/stop tmpfs debug sessions |
| `POST` / `DELETE` | `/api/music/mirror` | Push 52×16 lyric frames (≤60) to a stock-firmware Custom App slot (device mirror) |
| `POST` | `/api/music/device/select`, `/api/music/device/control` | Web-side track selection and control patches (play/theme/palette/accent/seek) |
| `GET` | `/api/music/device/state` | Plain-text control state polled by the music firmware (sequence + live echo) |
| `POST` | `/api/music/device/report`, `/api/music/device/heartbeat` | Firmware key-action reports and playhead heartbeats |
| `GET` | `/api/music/device/now`, `/api/music/device/audio` | Firmware-side lyric fetch and audio download |

Legacy `/api/presets` and `/api/settings` endpoints remain available. Writes require JSON and same-origin browser requests. Limits are 256 KiB per request, 24 channels, 48 items per channel, and 360 rendered frames per channel.

## Extending the registry

Add a trusted built-in `ContentDefinition` in `src/content-registry.ts`. A renderer receives a time snapshot, shared market reader, and item options, and returns `PixelCanvas[]`, matching delays, and a label. It must not start timers, retain unbounded state, or access the clock directly.

The registry deliberately does not load arbitrary third-party JavaScript. An untrusted plugin system should use an out-of-process protocol and a separate ADR.

## License

This project is **GPL-3.0-only** because it adapts and modifies GPL-3.0 PixDeck material. Review [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before distributing source or binaries.
