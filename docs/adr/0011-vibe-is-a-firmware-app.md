# ADR 0011: VIBE is a ZOS app, not a channel

- Status: Accepted
- Date: 2026-08-14
- Builds on: [ADR 0001](0001-extensible-content-channels.md) (channels),
  [ADR 0010](0010-vibe-native-usage-collection.md) (where the numbers come from)

## Context

VIBE shipped as two content types — `tools:vibe-duo` and `tools:vibe-agent` —
which the console placed as workspace channels. That is the path ADR 0001 lays
out for new content, and for a market ticker or a clock face it is the right
one: a channel is a renderer plus a refresh interval, and the device pages
through the enabled ones with the knob.

Usage is not that kind of content, and the gap widens with what VIBE is for
next: reacting to the state of the vibe-coding session running on this machine
— a quota window crossing 90 %, a limit resetting, a long run finishing. Three
properties of a channel make that impossible rather than merely awkward:

- **A channel is a cached animation.** The device downloads a frame bundle,
  loops it, and re-downloads when `ttl` expires. Numbers that must be current
  the moment they move cannot live in a bundle whose whole design is that it
  does not change until it is fetched again.
- **A channel has no input.** In ZOS the knob inside 轮播 changes *channel*;
  there is no way for a page to claim rotation to mean "next agent", and a
  button press cannot reach a picture at all.
- **A channel competes with the user's own content.** Ten agents on a ring that
  shows one item at a time would push the tickers and clock faces the user
  actually arranged off the end of it.

## Decision

VIBE becomes a top-level destination on the ZOS root ring, peer to 音乐 and
游戏: its own `Screen`, its own input vocabulary, its own data on the wire, and
native drawing on the device.

- **Root ring**: 音乐 / 游戏 / 轮播 / VIBE / 设置. Appended before 设置 so
  the first three keep their positions and settings stays last.
- **Wire**: four new keys in the pull document — `vibe` (count), `vibea`
  (agent), `vibes` (stale), `vibem` (metric row). New *keys*, never new fields
  on an existing key: the deployed firmware arity-checks `item` at exactly four
  fields and drops the line otherwise, while unknown keys are ignored by design.
  That asymmetry is what lets this ship to a panel that has never heard of VIBE.
- **Percentages are resolved server-side.** The device receives `used`, `limit`
  and a *relative* `resetSec`; it does no unit arithmetic and needs no synced
  wall clock. A metric with no ceiling arrives as `limit: 0` and is drawn as a
  bare number, because a meter without a limit would imply one we invented.
- **The device draws it.** Not server-rendered frames: a screen that draws its
  own pixels can animate, answer the knob in the same frame, and later react to
  a pushed event — which is the entire reason for this ADR.
- **The marks are one source, two panels.** `src/vibe/vibe-icons.ts` (hand-drawn
  pixel art) generates `visual/VibeIcons.h`, and `test/vibe-icons-parity.test.ts`
  holds them together bit for bit — the same guard the shared CJK font already
  has.

## Consequences

- **The two content types are gone.** With them go `src/vibe/vibe-render.ts` and
  the console's channel-placement UI. A user who had already placed VIBE
  channels is migrated on load: a channel whose appName is `vibe`/`vibe_<id>`
  *and* whose items are all `tools:vibe-*` is dropped and the workspace
  re-saved. This is not a nicety — those content ids no longer resolve, and
  workspace validation would refuse to start the service.
- **VIBE exists only under ZOS.** On the official firmware and on the two
  sideloaded firmwares there is no root ring to add to, so the feature simply is
  not there and the console says so. Putting usage back into a channel as a
  fallback would reintroduce exactly what this ADR removes.
- **The console keeps the data, loses the placement.** Agent list, stars, API
  keys and a preview of both pages stay; 频道布置 becomes 上屏, which explains
  where the app now lives and can jump the panel to it with the existing
  `PUT /api/os/display {focus:"vibe"}`.
- **Two entry-style slots were free** (`Shell::kMaxEntryStyles` is 8, six were
  used). A future peer app has one left before that constant has to move.
- The five-minute republish is deliberately the same cadence as the collector's
  own floor, so publishing costs no vendor request — it only moves numbers the
  collector had already refreshed. Live event pushes, when they land, will ride
  the same document and the same long poll rather than a second channel.
