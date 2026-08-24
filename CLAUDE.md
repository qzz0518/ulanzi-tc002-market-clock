# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Bun service that turns the Ulanzi TC002 pixel clock (52×16 LED) into a multi-channel content
studio: market tickers, tools, visual effects, a drawing canvas, a music/lyrics workstation
(NetEase + Spotify Connect), and a game arcade. Two optional native C++ firmwares (music player,
arcade) can be sideloaded to the device. Runtime is Bun 1.3.14 (pinned in `mise.toml`);
`CLOCK_HOST` (the clock's LAN IP/hostname) is required for the service to start.

## Commands

```bash
bun install
bun test                          # whole suite (bun:test)
bun test test/workspace.test.ts   # one file
bun test -t "carousel"            # filter by test name
bun run typecheck                 # tsc --noEmit over src/ scripts/ test/ web/
bun run build                     # vite lib build → dist/assets, then Bun.build of service/status/preview
CLOCK_HOST=<ip> bun start         # build + run dist/service.js, console at http://127.0.0.1:43820/
bun run preview                   # render every saved channel to .runtime/previews/ (no device needed)
bun run status                    # query a running service
bun run agent -- --help           # VIBE usage collector, for when the service is not on the machine holding the CLI logins
bun run agent-build -- --all      # compile that collector to dist/agent/ for every platform
mise run arcade-hostcheck         # compile+run the arcade game-engine self-checks on the host (clang++)
```

There is **no Vite dev server**. The web UI is built as a library bundle (`dist/assets/studio.js`
+ `studio.css`) and served by the Bun process, so any change under `web/` requires `bun run build`
before it shows up in the browser. `dist/` and `.runtime/` are gitignored.

Firmware builds (Docker cross-compile, optional) and release packaging are documented in
`device/tc002-lyrics-player/README.md` and `device/tc002-arcade/README.md`.

## Architecture

One Bun process does everything. `src/service.ts` is the composition root: it constructs every
store/client, then runs (a) `Bun.serve` on `HEALTH_PORT` (default 43820) and (b) a scheduling loop
that calls `controller.pushDue()` and sleeps until the next channel is due.

**Request handling** — `Bun.serve` always binds `0.0.0.0` (the clock itself must reach the
device-facing endpoints); `CONTROL_HOST` only affects what the installer advertises. Every HTTP
route lives in one big handler in `src/control-api.ts`; WebSocket upgrades for `/api/game/socket`
are decided first by `src/game-socket.ts` (a pure relay for the phone gamepad and doodle wall).

**Content pipeline** — the core contract is `ContentDefinition` in `src/content-registry.ts`:
a renderer receives a context (market data, weather, pixel assets) plus item options and returns
**frames + frame delays only**. Renderers never touch the device and never run their own loops.
`src/workspace-controller.ts` owns everything stateful: market caching, per-channel frame budgets,
GIF/PNG encoding (`src/pixel-ui.ts`, `src/display.ts`), serialized device writes, per-content
failure isolation, and refresh scheduling. Adding a built-in content type = registering one more
`ContentDefinition`; the registry deliberately does not load third-party JS at runtime (ADR 0001).

**Device transport** — `src/clock-client.ts` posts a complete Custom App per request to the
clock's native `POST /api/custom?name=...`, injected into the controller as `pushPayload(appName,
payload)` so a future MQTT/Home-Assistant transport needs no renderer changes. There are two write
paths on purpose: channel pushes go through curl (carries `CLOCK_HTTP_PROXY`), while
latency-critical writes — `/api/live/frames` and `/api/notify` — use Bun's native `fetch` and
bypass the proxy, on their own serial `liveWriteQueue` (~16 ms vs ~170 ms per write; this is what
makes 25 fps live streaming work — ADR 0003).

**Sideload installers** — `src/tc002-music-installer.ts` is one parameterized `Tc002SideloadInstaller`
used twice via `MUSIC_SIDELOAD_PROFILE` / `ARCADE_SIDELOAD_PROFILE` (appId, remote dir, confirm
phrase, cleanup list). Sideloading is always non-persistent: files go to the device's tmpfs, flash
is never written, power-cycle restores the official firmware. The two firmwares are mutually
exclusive and distinguish sessions via `/tmp/tc002-sideload.id` (ADR 0004).

**Web UI** — React 19 + `@cladd-ui/react` + Tailwind v4, entry `web/src/main.tsx` → `web/src/app.tsx`,
alias `@/` → `web/src/`. Pure logic lives in `web/src/lib/` (game engines, live-screen batching,
lyric rendering, studio state) and is unit-tested from `test/` the same way as `src/`. The `/pad`
and `/draw` companion pages are intentionally standalone inline-script HTML strings in
`src/web-ui.ts` — a scanned QR code should get a working control in one request, with no bundle.

**Shared pixel glyphs** — the 12×12 CJK / 6×12 ASCII bitmaps are generated once offline and used
by both the firmware (`device/tc002-lyrics-player/app/src/visual/CjkFont.h`) and the web preview
(`web/src/lib/pixel-glyph-data.ts`). After regenerating fonts, run
`bun run scripts/gen-web-glyphs.ts`; `test/pixel-glyphs.test.ts` verifies the two sides bit-for-bit.
This is why preview, mirrored frames, and native firmware are pixel-identical.

**State on disk** — everything runtime lives in `.runtime/`: `workspace.json` (channels; migrated
atomically from the legacy `settings.json`), `pixel-assets/`, `market-instruments/`, `market-icons/`,
and credential files (`music-session.json`, `spotify-session.json`) written `0600`.

`src/controller.ts` (`DashboardController`) + `src/settings.ts` are the **legacy** single-market
path, kept only so `/api/settings` and `/api/preview` stay compatible. New work belongs in
`WorkspaceController`.

## Invariants worth preserving

- Display is fixed 52×16. Validation limits (`src/workspace.ts`): 24 channels, 48 items/channel,
  360 frames/channel, 256 KiB request body; live/mirror endpoints are the exception at 2 MiB and
  ≤400 frames; video import is multipart at 100 MB.
- Write endpoints require JSON and pass a same-origin check. Exceptions are deliberate: the
  firmware-called `/api/music/device/report`, `/api/music/device/heartbeat`,
  `/api/arcade/heartbeat`, and the external `/api/notify` (rate-limited, optional `NOTIFY_TOKEN`).
- App names are unique, 1–32 ASCII `[A-Za-z0-9_-]`; `notify` and `music_lyrics` are reserved.
- Never fabricate market data: quote failures fall back to cache within `SOURCE_STALE_MS`, then the
  item is skipped rather than shown wrong; icons are generated procedurally when a brand match is
  not certain.
- User-facing UI copy and content labels are Simplified Chinese; code comments are English and
  explain *why* (measurements, device constraints), matching the existing density.
- Style with cladd tokens/primitives (`bg-cladd-surface`, `Surface`, `Button`, size scale) rather
  than hand-rolled CSS.
- Docs are bilingual and paired: `README.md`/`README.en.md`, `docs/reference.md`/`docs/reference.en.md`.
  Update both sides when changing user-visible behaviour.

## Further reading

- `docs/reference.md` — env vars, data sources, full local API table, webhook payloads.
- `docs/adr/` — 0001 content registry, 0002 native music player boundary, 0003 live frame channel,
  0004 arcade firmware, 0005 runtime clock host, 0010 VIBE collects usage itself,
  0013 that collector can also run out of process and push in.
- `docs/design/` — pixel playground and arcade firmware designs; `docs/research/` — real-device
  probes and the no-IDE FlyThings build path.
