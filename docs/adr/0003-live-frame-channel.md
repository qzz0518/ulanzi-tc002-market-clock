# ADR 0003: Interactive content streams frames from the browser through a generalized live channel

- Status: Accepted
- Date: 2026-08-10
- Amended: 2026-08-10 — hardware testing surfaced the flicker risk as real: the service spent
  ~170 ms per write spawning a curl subprocess, so a 30 ms single-frame stream degraded to ~6 fps
  with visible tearing. Latency-critical writes (live, notify) now inject Bun's native fetch
  (~16 ms), and producers ship record-and-replay batches
  (4 frames × 25 ms per 100 ms push, `web/src/lib/live-screen.ts`) instead of single frames.
  Measured after the fix: 28 ms median per batch, continuous ~25 fps on the device.
- Amended: 2026-08-11 — that fetch transport also dropped `CLOCK_HTTP_PROXY`, which silently broke
  every live frame and notification on hosts that need the proxy. A launchd-started service on
  macOS holds no local-network permission: connecting to the clock's LAN address fails to open a
  socket in ~5 ms ("Was there a typo in the url or port?") while curl-through-proxy channel pushes
  keep working, so the failure looked device-specific. Bun's fetch takes a per-request `proxy`, and
  proxied writes measure 24–35 ms — the latency argument never required bypassing the proxy.

## Context

ADR 0001 renders bounded animations ahead of time and lets the device play them; that model cannot
express interactive content (games, real-time visualizers, collaborative drawing). Three transport
facts, measured on real hardware, frame the decision:

- A single-frame 52×16 GIF is ~152 bytes and `POST /api/custom` completes with a median RTT of
  16 ms (p95 32 ms) — the official-firmware channel sustains ~60 serialized pushes per second.
- The music mirror path already streams browser-rasterized frames to the official firmware
  (400 frames / 48 KB in 109 ms), but is hard-wired to one app name (`music_lyrics`).
- The sideloaded player polls the service every 2 s, so any input loop routed through it has a
  worst-case latency of ~4.5 s.

The official firmware exposes no key or knob events over HTTP, so the physical knob cannot drive
interaction without the sideloaded player.

## Decision

1. Interactive content runs its loop **in the browser**: input is local (touch/keyboard), the page
   renders the authoritative 52×16 frame, and the device acts as a second screen fed over HTTP.
2. The mirror endpoint's decode/validate/encode pipeline is generalized into a live channel:
   `POST /api/live/frames` with a caller-chosen app id, published to the device as `live_<app>`.
   `/api/music/mirror` remains as a thin delegate with unchanged behavior and limits
   (400 frames, 2496 bytes/frame, 2 MiB body).
3. Live writes share one serialized queue (latest-frame-wins at the producer via the existing
   latest-task-runner); the channel scheduler keeps its own FIFO queue. The two stay separate:
   carousels need ordered completeness, live streams need freshness.
4. `notify`, `music_lyrics`, and the `live_*` prefix become reserved app names, rejected by
   workspace validation.
5. Game logic on the device itself (knob input, <30 ms loop) is explicitly deferred to the
   sideloaded player (ADR 0002's boundary), not to this channel.

## Consequences

- Games and visualizers ship as plain TypeScript with zero firmware risk; anyone on the LAN can
  play from a browser while the clock displays.
- Display latency on the device is ~20–50 ms and only affects the second screen, not input.
- Rapid same-name republishing is the one unverified behavior (possible flicker); the fallback —
  batching 2–3 predicted frames per push at 60–100 ms intervals — changes only the push cadence,
  not the engine.
- A future WebSocket ingress for multi-device input (two-phone Pong) can feed the same channel
  without changing the device-facing side.
