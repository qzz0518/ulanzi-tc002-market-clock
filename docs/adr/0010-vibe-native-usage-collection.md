# ADR 0010: VIBE collects agent usage itself, in TypeScript

- Status: Accepted
- Date: 2026-08-14
- Amended: 2026-08-15 — the collected set was cut from ten vendors to four
  (claude, codex, opencode, grok). The decision below is unchanged; only its
  scope is. Numbers in this document that counted vendors have been updated.
- Supersedes: the first cut of this ADR, which consumed OpenUsage's local HTTP API

## Context

VIBE puts AI coding-agent quota (Claude Code, Codex, OpenCode, Grok) on the panel and
in the console. The reference product is OpenUsage (MIT, robinebers/openusage), a
macOS menu-bar app that supports ten vendors and exposes a read-only loopback API
at `127.0.0.1:6736`.

The first implementation consumed that API. It worked, and the numbers matched
the menu bar exactly, but it made a pixel clock depend on a third-party GUI app
being installed, running, and signed in — for data the clock could read itself.
Everything OpenUsage does to get those numbers happens on this machine: it reads
the credential each vendor's own CLI already wrote (a Keychain item, a JSON file
under `~`), calls that vendor's usage endpoint, and maps the response. None of it
requires a menu-bar app; it requires knowing where each vendor keeps its token
and what its endpoint returns.

## Decision

Collect usage ourselves, in TypeScript, with one adapter per vendor.

OpenUsage remains the **reference**: its Swift source was read to extract, per
vendor, the credential locations and precedence, the endpoint URL, the exact
header set, the response field paths, the plan-string mappings and the reset-time
arithmetic. Nothing of theirs is linked, bundled, called or required at runtime.

The shape:

- `src/vibe/providers/types.ts` — the adapter contract. An adapter gets a context
  (fetch, env, keychain reader, file reader, clock, timeout) and returns metrics;
  it never touches the device, never caches, never schedules. Same discipline as
  a content renderer (ADR 0001), and the reason a vendor can be tested with a
  fake fetch and no login.
- `parse.ts` / `http.ts` / `keychain.ts` — the shared floor: defensive field
  readers, a hard per-request timeout, the 401→refresh-once dance, and a
  `/usr/bin/security` wrapper (exit 44 = "nothing stored", which is a state).
- `providers/<vendor>.ts` ×4, `providers/index.ts` as the registry.
- `usage-service.ts` — probes every adapter, fetches the ones with a credential
  **in parallel**, folds the results into one snapshot.

Consequences of collecting rather than consuming:

- **Detection replaces configuration.** A vendor with no credential on this
  machine is silently absent — not an error, not a setting. We probe all four
  collected vendors rather than showing whichever ones another app had enabled.
- **Failure is per vendor.** One dead endpoint costs that vendor's row; its last
  good values stand in for 15 minutes flagged `stale`, then it drops out. A 429
  parks that vendor until Retry-After passes and nothing else.
- **No vendor needs a key.** All four borrow a CLI login this machine already
  carries. The key store (`.runtime/vibe-keys.json`, `0600`, never echoed back
  and never in `/api/vibe/status`) stays wired for the next vendor that has no
  local login, but its vendor list is empty and every key request is refused.
- `OPENUSAGE_URL` is gone from the environment; there is no upstream to point at.

Correctness was verified against the reference on this machine: for the vendors
OpenUsage had enabled, our numbers are identical (Claude weekly 72 %, Fable 69 %,
extra usage $0/85; Codex weekly 4 %; Grok weekly 4 %), with the rolling
five-hour session figure differing only by the minutes between the two calls.

## Consequences

- **We now own vendor churn.** Four private, undocumented endpoints will change,
  and when one does its adapter breaks and that vendor shows no data. The blast
  radius is one file and one row; the alternative was a hard dependency on
  someone else shipping a fix. Adapters are written defensively (every field
  narrowed, missing fields dropped rather than defaulted) so a shape change
  degrades to "no data" instead of a wrong number.
- Credentials never leave the process: they are read, used to sign one request,
  and discarded. Nothing is logged, nothing is persisted except the user's own
  pasted API keys.
- The Keychain read is a `security` spawn, so it inherits the user's existing
  authorisation for their own CLI's item and raises no new prompt. On a
  non-macOS host the reader is inert and those vendors simply never detect.
- **The Keychain is read-only to us, and that decides where a refresh may
  happen.** `security add-generic-password -w` takes its value through
  `getpass(3)`, which truncates at 128 bytes *and still exits 0* — measured
  here, a 336-byte blob came back 128 bytes long with no error, which would
  have replaced a real Claude login with a fragment. Passing the blob as an
  argument instead would put a live OAuth token in `ps` output for every
  process on the machine. So neither is done: an adapter whose credential lives
  in the Keychain never spends a refresh at all. It uses the access token as it
  stands, and when that expires the panel says the sign-in expired — the user's
  next `claude` run repairs it. Only file-backed logins (`~/.codex/auth.json`,
  `~/.grok/auth.json`, `.credentials.json`) are refreshed, because only those
  can be written back atomically at 0600. Every write-back merges into the file
  it just read rather than rebuilding it: a real credential carries keys we do
  not model — `mcpOAuth` holds the user's MCP server tokens — and rebuilding
  would silently delete them.
- Icon artwork is unchanged in origin — third-party brand marks used
  nominatively — but the LED grids are now hand-drawn pixel art rather than
  rasterised vectors, because area-averaging a mark into 10–12 px destroys it.
  See the header of `src/vibe/vibe-icons.ts`.
- A future spend-line pass (Today / Yesterday / Last 30 Days) means scanning the
  agents' local JSONL logs and pricing the tokens. The adapter contract already
  carries `spendLines`; nothing else has to move.
