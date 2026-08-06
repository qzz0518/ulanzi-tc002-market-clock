# Ulanzi TC002 Pixel Studio

[简体中文](README.md) | English

An extensible, Bun-powered multi-channel content studio for the Ulanzi TC002. Market data, notices, timers, visual animations, and a 52×16 canvas all implement one frame-rendering contract and are composed and pushed by a central scheduler.

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

The left rail manages clock channels, the center edits and previews the selected channel, and the right-side catalog is grouped by Market, Tools, Visual, and Creative. The top navigation exposes three first-class views: **Content**, **Canvas**, and the wide three-column **Library**.

The frontend uses React, Cladd UI, and Tailwind CSS v4. Cladd standardizes controls, tabs, selects, deletion confirmation, tooltips, toasts, and draggable numeric inputs while the product keeps its existing black, white, and green Pixel Market visual language. Motion respects `prefers-reduced-motion`.

Configuration is stored in `.runtime/workspace.json`. A legacy `.runtime/settings.json` is atomically migrated into one market channel on first launch without overwriting the legacy file. Disabled, removed, or renamed channels are cleaned from the clock by posting an empty object to their former Custom App names.

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

The control API remains loopback-only by default.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/catalog` | Categories, option schemas, and defaults |
| `GET` / `PUT` | `/api/workspace` | Read or atomically save all channels |
| `POST` | `/api/channels/preview` | Render a saved channel or draft |
| `POST` | `/api/channels/push` | Push one channel |
| `POST` | `/api/push` | Push every enabled channel |
| `GET` | `/api/state`, `/health` | Device, channel, market, and cleanup status |
| `GET` | `/api/library/ulanzi/pixel-assets` | Browse, search, filter, and page through official community assets |
| `GET` | `/api/library/ulanzi/media` | Safely proxy official preview media |
| `POST` | `/api/library/ulanzi/import` | Validate and import an official `contentView` link or work ID |
| `GET` | `/api/library/ulanzi/imported/:ref` | Read a normalized local asset snapshot |

Legacy `/api/presets` and `/api/settings` endpoints remain available. Writes require JSON and same-origin browser requests. Limits are 256 KiB per request, 24 channels, 48 items per channel, and 360 rendered frames per channel.

## Extending the registry

Add a trusted built-in `ContentDefinition` in `src/content-registry.ts`. A renderer receives a time snapshot, shared market reader, and item options, and returns `PixelCanvas[]`, matching delays, and a label. It must not start timers, retain unbounded state, or access the clock directly.

The registry deliberately does not load arbitrary third-party JavaScript. An untrusted plugin system should use an out-of-process protocol and a separate ADR.

## License

This project is **GPL-3.0-only** because it adapts and modifies GPL-3.0 PixDeck material. Review [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before distributing source or binaries.
