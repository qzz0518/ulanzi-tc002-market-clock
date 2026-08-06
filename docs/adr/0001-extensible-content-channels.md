# ADR 0001: Extensible content registry and clock channels

- Status: Accepted
- Date: 2026-08-06
- Decision owners: Ulanzi Clock maintainers

## Context

The service currently renders one fixed market carousel and publishes it as one
TC002 Custom App. That model cannot represent standalone tools or visual
effects, and every new content type would otherwise add another special case to
the controller and control panel.

The TC002 already supplies the useful top-level navigation primitive: every
unique Custom App name becomes an item that can be selected with the physical
knob. Within a Custom App, an animated GIF can represent an ordered carousel.

PixDeck demonstrates a broader catalog (market data, notice board, timer,
visual effects, and a canvas), but its plugins own their own update loops and
push to the clock independently. Copying that execution model would allow
concurrent writers to replace one another and would make error handling,
rate-limiting, and cleanup difficult to reason about.

## Decision drivers

- One data model must cover both a single standalone item and a multi-item
  carousel.
- Existing market settings must migrate without losing the selected assets or
  timing preferences.
- Adding a built-in content type should require a registry entry and renderer,
  not changes throughout the service.
- A failing data source or renderer must not stop unrelated channels.
- Content code must not receive network credentials or direct clock-write
  capability.
- GIF generation and device writes need bounded CPU, memory, payload size, and
  frequency on a small always-on service.
- Disabled or removed channels must be removable from the device's knob list.

## Decision

Keep the application as a single-process modular monolith and introduce three
explicit layers:

1. **Content registry** — a typed list of trusted, built-in definitions. Each
   definition exposes metadata, an option schema, defaults, and a renderer that
   returns 52×16 pixel frames plus frame delays. Renderers never push to the
   clock directly.
2. **Workspace** — persisted versioned configuration containing channels. A
   channel has a unique TC002 `appName` and one or more ordered content items.
   One item is a standalone app; multiple items form one GIF carousel.
3. **Workspace controller** — validates the workspace, resolves data through
   shared cached clients, renders and bounds frames, encodes one payload per
   channel, serializes device writes, tracks per-channel health, and schedules
   the next refresh no sooner than a full animation cycle.

Configuration shape:

```ts
interface WorkspaceSettings {
  version: 3;
  channels: ChannelConfig[];
}

interface ChannelConfig {
  id: string;
  name: string;
  appName: string;
  enabled: boolean;
  refreshIntervalMs: number;
  items: ContentItemConfig[];
}
```

The initial registry is closed to code shipped with this repository. This is an
extension framework for maintainers, not an in-process loader for arbitrary
third-party JavaScript. A future out-of-process plugin protocol may be added in
a separate ADR if untrusted extensions become a requirement.

The old dashboard settings file is accepted as input and migrated atomically to
one channel. Each selected asset becomes one market content item, preserving
the old price/change durations as closely as the new item model permits.

When a channel is disabled or removed, the controller sends an empty object to
that channel's prior Custom App name. This is treated as a best-effort cleanup;
the persisted workspace remains authoritative even if the device is offline.

## Boundaries and non-functional requirements

- Workspace request bodies are limited to 256 KiB, 24 channels, 48 items per
  channel, and a 52×16 (832-pixel) canvas per canvas item.
- App names are unique and limited to 1–32 ASCII letters, digits, underscores,
  or hyphens, matching the existing clock API boundary.
- A rendered channel is limited to 360 frames and explicit frame delays. The
  controller refuses malformed output rather than attempting a partial push.
- Device writes are serialized. Failures are recorded per channel and do not
  prevent other due channels from being attempted.
- Market requests share the existing timeout, validation, stale-cache, and
  fallback behavior. Visual and canvas renderers perform no network access.
- Persistence keeps the existing temporary-file-plus-rename pattern. Invalid or
  corrupt saved data fails closed and is not silently overwritten.
- Control writes retain same-origin checks, JSON-only input, CSP, frame denial,
  and no-store API responses.
- A full channel animation is allowed to finish before the automatic scheduler
  refreshes it. This avoids repeatedly resetting the first item in a carousel.
- Rendering cost is proportional to the bounded number of 52×16 frames. No
  renderer may start a background timer or retain an unbounded history.

## Failure modes

| Failure | Behavior |
| --- | --- |
| One market source fails | Use a valid recent cache where allowed; mark the channel degraded. |
| One channel cannot render | Record its error, keep its last device content, continue other channels. |
| Clock is unreachable | Preserve configuration and retry on the next due cycle or manual push. |
| Workspace is invalid | Reject the write with HTTP 400; keep the previous in-memory and on-disk workspace. |
| GIF/frame bounds are exceeded | Reject rendering before device I/O. |
| Removed app cleanup fails | Record cleanup failure; do not roll back the user's saved workspace. |

## Alternatives considered

### One process and push loop per plugin

Rejected. It mirrors PixDeck closely but creates competing writers, duplicated
network/data caches, difficult shutdown semantics, and no reliable way to make
an ordered multi-plugin carousel.

### One permanent app containing every item

Rejected. It preserves the existing implementation but cannot expose standalone
content to the physical knob.

### One Custom App for every content item only

Rejected. It supports knob navigation but removes the useful combined-carousel
workflow and can create an unnecessarily long device list.

### Dynamically load arbitrary JavaScript plugins

Deferred. It materially expands the trust and compatibility boundary. The
typed built-in registry provides the desired maintainability without granting
extensions filesystem, process, or network authority.

## Consequences

- The same content can be reused in multiple channels with independent options
  and durations.
- Device navigation and in-app composition are represented by one simple model.
- Renderers become straightforward to test without a physical clock.
- The scheduler and control API are more substantial than the previous single
  loop, and the UI must expose channel identity as well as content options.
- Code and stock-icon assets adapted from PixDeck require preserved GPL-3.0
  provenance and a distribution review before publishing binaries.

## References

- PixDeck source snapshot: `cailurus/PixDeck@599f712d8ea086ce5b31041130f4353b3816fa0c`
- Local comparison notes: `docs/research/pixdeck-review.md`
