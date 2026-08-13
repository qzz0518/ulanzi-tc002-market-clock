# ADR 0010: VIBE usage data comes from OpenUsage's local API, not ported providers

- Status: Accepted
- Date: 2026-08-14

## Context

The VIBE feature puts AI coding-agent quota usage (Claude Code, Codex, Cursor, …) on the 52×16
panel and in the console. The obvious source is what the user already trusts: the OpenUsage menu
bar app (MIT, robinebers/openusage), which supports ten providers and whose numbers the user
looks at daily.

Two ways to get those numbers:

1. **Port the provider layer.** OpenUsage's Swift providers read local credentials (files *and*
   the macOS Keychain), refresh OAuth tokens, and call ten vendors' private usage endpoints,
   each with its own shape, plan-string mapping and failure modes.
2. **Consume OpenUsage's local HTTP API.** The app serves a read-only, loopback-only API at
   `http://127.0.0.1:6736` explicitly documented for local integrations: `/v1/limits` is a
   stable machine contract (`openusage.limits.v1` — stable provider/resource IDs, raw scalars
   with units, `fetchedAt`/`stale`), `/v1/usage` carries the UI-oriented extras (labels, spend
   text, trend points). No credentials ever cross the socket.

## Decision

Consume the local API (`OPENUSAGE_URL`, default `http://127.0.0.1:6736`). "Aligning with
OpenUsage" is implemented at the semantic layer instead of the transport layer: the provider
catalog and order, metric keys and labels, default starred metrics, the hide-when-no-data rule,
staleness thresholds, icon artwork and the two-value strip layout are all replicated from
OpenUsage's source; the numbers themselves are whatever the running app publishes.

Reasons, in order of weight:

- **The numbers always match the menu bar.** Any port would eventually disagree with what the
  user sees at the top of the screen, and the disagreement would read as a VIBE bug.
- **Vendor churn lands on OpenUsage, not here.** Ten private endpoints, Keychain access and
  OAuth refresh are exactly the code that rots; updating one menu bar app fixes both consumers.
- **Loopback survives our launchd sandbox.** The service demonstrably cannot reach LAN peers
  from launchd (ADR context in `docs/research/`), but 127.0.0.1 is unaffected — verified with
  live data before this was accepted.
- The API is served with permissive CORS to *browsers*, but we consume it server-side in the
  Bun process (`VibeUsageClient`) so the console works from other LAN devices, where
  `127.0.0.1` would mean the phone, not the Mac.

The cost is an availability dependency: no OpenUsage process, no data.

## Consequences

- **Offline is a first-class state, not an error.** The renderer draws an `OPENUSAGE OFFLINE`
  frame (the weather "not configured" pattern), the console shows an install pointer, and the
  channel keeps its slot. Nothing retries aggressively: the poll rides the normal channel
  refresh cadence (60 s), and `VIBE_STALE_MS` (15 min = 3× OpenUsage's fixed 5-minute refresh)
  bounds how long last-good numbers may be served after the app dies — after that the
  no-fabrication rule applies and the page degrades honestly.
- Usage numbers stay out of `channelContentRevision` (the volatile-inputs rule), so ZOS pulls
  new pixels on `ttl`, not on every scalar change.
- Provider icons are third-party brand marks used nominatively, the same exposure OpenUsage
  itself accepts; OpenUsage's *own* name and logo stay out of our branding (their TRADEMARK.md
  reserves them) — the console credits it in text only.
- If OpenUsage ever drops the API or the schema moves past `openusage.limits.v1`, the seam to
  reimplement is `VibeUsageClient` alone: everything downstream consumes `VibeUsageSnapshot`,
  which was shaped so a direct-provider client could replace the HTTP one without touching
  renderers, store, routes or the console.
