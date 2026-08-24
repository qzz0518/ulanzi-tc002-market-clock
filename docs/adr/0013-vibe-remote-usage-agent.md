# ADR 0013: The VIBE collector can run out of process

- Status: Accepted
- Date: 2026-08-16
- Extends: [ADR 0010](0010-vibe-native-usage-collection.md) — it is unchanged, not superseded

## Context

ADR 0010 decided that VIBE collects agent quota itself, with one TypeScript
adapter per vendor, each reading the credential that vendor's own CLI already
left on this machine. That decision assumed something it never said out loud:
that the service process and the CLI logins are on the same machine.

They are not always. The console can be deployed with `scripts/install-docker.sh`,
or on a NAS, or on a box that is not the laptop anyone codes on. In those
deployments every adapter behaves exactly as designed — no Keychain item, no
`~/.claude/.credentials.json`, therefore "not signed in", therefore silently
absent — and the panel is empty. Nothing is broken and nothing says anything,
which is the worst possible presentation of a fixable situation.

The obvious repair is to consume a third-party collector's local API. That is
what the first cut of ADR 0010 did with OpenUsage's `127.0.0.1:6736`, and the
reason it was dropped stands: it makes a pixel clock depend on a GUI app being
installed, running and signed in. It also does not actually solve this problem —
that API is loopback-only, so a container cannot reach it either.

A survey of what exists (openusage.sh's Go daemon with its hub + `Dockerfile.hub`,
robinebers/openusage's one-shot CLI, ccusage, CCDash's pull-mode `agent.py`,
Claude Code's native OTLP export) found no single collector that is both
multi-vendor and pushes across a machine boundary with quota — as opposed to
spend — semantics. The nearest match, openusage.sh, covers 35 vendors and
cross-compiles, but reads Claude Code's usage by推算 from local JSONL rather
than from the vendor's own quota endpoint, which is a different number from the
one VIBE promises.

## Decision

Ship the existing collection code as a second entry point, and let it push.

`src/vibe-agent.ts` compiles to a single self-contained binary with
`bun build --compile`. It constructs the same `VibeUsageService`, with the same
four adapters, the same refresh guards and the same per-vendor isolation, then
POSTs the resulting `VibeProviderUsage[]` to `POST /v1/push` on an interval.

This was almost free because `VibeAdapterContext` was always injectable: an
adapter never touches the device, never caches and never schedules (ADR 0010's
own rule, itself borrowed from ADR 0001). Everything about the outside world —
fetch, env, Keychain, file reads and writes, clock — already arrived as
parameters. Running the collection somewhere else needed a new `main`, not a
refactor.

Three things follow from the decision, and each is a rule:

- **A second source, not a second service.** `VibeIngestStore` is handed to
  `VibeUsageService` as `options.ingest`, and its rows are folded into the same
  snapshot. The console, the renderers, the star table and the ZOS document are
  all unchanged and none of them can tell where a row came from. When both
  sources have the same vendor, **the local read wins** — a credential this
  process read itself outranks one relayed over the network, and "local wins" is
  a rule a user can predict without knowing which clock ran first.

- **The wire format is openusage's, deliberately.** The envelope is
  `{machine, sent_at, snapshots}` on `/v1/push` with an optional
  `Authorization: Bearer`, which is openusage.sh's hub contract verbatim; a
  `schema` field discriminates. We gain nothing today from the similarity. We
  gain the exit: swapping our four-vendor collector for their thirty-five-vendor
  daemon becomes a mapping of the array elements, on a route that already exists,
  with the console and the firmware untouched.

- **No token, no ingest.** The route takes no same-origin check — the agent is
  not a browser and sends no Origin — and the server binds `0.0.0.0` like
  everything else. Without a shared secret, anything on the LAN could put
  invented quota on the panel, and "never fabricate market data" is the oldest
  rule in this codebase. `VIBE_INGEST_TOKEN` unset therefore means every push is
  refused with 503 and a message naming the variable. There is deliberately no
  `--allow-anonymous` escape hatch.

Pushed data is held **in memory** and ages like a local vendor does: `stale`
after 5 minutes, dropped after 15. It is perishable and the agent re-sends
within its interval, so a restart shows an empty panel for one interval rather
than replaying a snapshot nobody can vouch for.

## Consequences

- **The agent inherits the right to rotate credentials.** The adapters write a
  refreshed token back to the file it came from, because vendors retire the old
  refresh token on every exchange (ADR 0010). That is correct on the machine
  those files belong to and destructive anywhere else: a copy of this binary run
  against someone else's home directory signs them out of their own CLI. This is
  stated in the binary's `--help`, in the console dialog, and in both READMEs.
  It cannot be enforced in code — the binary has no way to know whose `~` it is
  looking at.

- **Setup is a cross-machine, per-OS chore**, which is where this kind of feature
  normally dies. So the console's 「远程采集」 dialog asks **two questions and
  shows one path**: how this service was started (Docker / autostart / shell),
  and which machine holds the logins (this one / another Mac / Linux / Windows).
  Every other branch stays hidden, the token is generated on open rather than
  behind a button, and each command arrives with the reader's own host already
  in it — nothing asks them to substitute a placeholder.

  The first cut laid all the branches out at once — three ways to set the token,
  two ways to get the binary, a verify step, an install step, nine code blocks —
  and the reader had to work out which lines were theirs before touching
  anything. Choosing for them is the whole design; autostart and uninstall are
  folded away, and uninstall only appears once a machine is actually pushing.

  `test/vibe-remote-setup.test.ts` feeds the generated run command back through
  the agent's own argument parser, and checks that what uninstall removes is
  what autostart installed — a walkthrough that has drifted from the CLI fails
  the build rather than the user.

- **Uninstalling is two different jobs.** Stopping the agent is a command on the
  other machine; clearing its rows is `DELETE /api/vibe/ingest/machine` here.
  The dialog puts them in that order and says why: forgetting first just means
  the row returns on the next push. The route forgets, it cannot reach across
  and stop anything, and the copy says so rather than implying otherwise.

- **A push invalidates the controller's snapshot cache.** Without that the new
  numbers would sit behind `VIBE_STALE_MS` and reach the clock up to fifteen
  minutes late. Rebuilding costs one local collection round, which on a
  deployment that receives pushes is four credential probes that all miss — no
  vendor traffic at all.

- **Several machines may push.** One vendor still gets one row on a 52×16 panel,
  so the most recent push takes it and names its machine in `note`. Averaging or
  alternating would make a quota look like it was moving when it was not.

- **Two supported topologies now exist** and the docs must keep saying so: the
  service reads local logins (unchanged, still the default), or an agent pushes
  from wherever the logins are. Both at once is legal and resolves by the
  local-wins rule above.

- **Identical rendering forced a visible origin.** Making a pushed row
  indistinguishable from a local one is what keeps the renderers and the
  firmware ignorant of all this — and it also left the console unable to answer
  the first question anybody has: *do I need to set this up or not?* Someone
  looking at four working rows could not tell whether they were being read here
  or relayed from elsewhere.

  So every row carries `source: {kind, machine?}`, the strip states the split
  (`本机直采 4 家` / `远程推送 2 家（work-laptop）`), and pushed rows wear a
  machine badge. Local rows carry none: it is the default topology, and tagging
  all four would be noise. The field is stamped by whoever produced the row, so
  a push **cannot claim to be local** — ingest never reads `source` off the
  wire.

  The empty state needed the same treatment, because two opposite situations
  produce it: nobody has logged in here, or this process cannot see the logins
  that exist. `/.dockerenv` (or `container=`) settles it whenever the answer is
  knowable, and where it is not the console names both rather than guessing.
  This is the same rule as everywhere else in VIBE: state what is known, never
  fabricate the rest.
