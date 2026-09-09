# ADR 0014: Two tiers — the official firmware, and ZOS

- Status: Accepted
- Date: 2026-09-09
- Supersedes: [ADR 0004](0004-arcade-firmware.md) (the arcade sideload).
  Narrows [ADR 0002](0002-native-music-player-boundary.md): the sideloaded music
  player becomes transitional.

## Context

The device side of this project grew by accretion, and every step was justified
at the time:

1. Custom Apps pushed to the **official firmware** (`POST /api/custom`) — zero
   risk, no input, no sound.
2. A **sideloaded music player** (ADR 0002), because the official firmware
   cannot decode audio.
3. A **sideloaded arcade** (ADR 0004), because games need the knob and the
   official firmware exposes no key events.
4. **ZOS** — a full replacement firmware, because two mutually exclusive
   sideloads that each own the whole panel could not become one product.

By September 2026 the numbers had settled the question. Of the last two hundred
commits, four hundred file touches were in `device/tc002-os`, sixty-eight in the
arcade and a hundred and eight in the music player — most of those in the
toolchain the other two borrow. ZOS compiles the arcade's seven engines
unchanged from the arcade tree (`EXTRA_SRC_DIRS`), builds in the music player's
`flythings-build/`, and has its own music page, sleep, settings, provisioning,
mirror and upgrade chain. The arcade's only remaining function was to be a
directory ZOS pointed at; the music player's only remaining function was
playing audio through the clock's own speaker.

Meanwhile the console carried four `FirmwareMode`s, two `SideloadProfile`s
besides ZOS's own, two firmware panels, three release tasks, three READMEs and
their tests. That surface is what made the project feel scattered, not the
feature count.

## Decision

The project has **two device tiers**, and everything else is derived from them.

- **Tier 1 — the official firmware.** The device is untouched; the service
  renders and pushes. Channels, the live frame channel (ADR 0003), notify and
  the lyric mirror live here. This is the zero-risk entry point and it stays.
  **No new feature targets this tier**; it is frozen at what pushing a Custom
  App can express.
- **Tier 2 — ZOS.** The device pulls. Input, games, music, VIBE, night sleep,
  mirror and the upgrade chain live here. Every new device-side feature targets
  ZOS, whether the unit runs it flashed (ADR 0012) or sideloaded from `/tmp`.

The two sideloaded firmwares are **transitional artifacts**, not products:

- **The arcade is removed now.** Its engines and their self-check move into
  `device/tc002-os` (`app/src/games/`, `hostcheck/games-selfcheck.cpp`); the
  bridge header, the `EXTRA_SRC_DIRS` indirection, the arcade profile, its
  routes (`/api/arcade/*`), panel, release task and tests go with it. Nothing
  is lost: ZOS already ran the same seven games natively.
- **The music player is retired after one gap closes.** ZOS gains device-side
  audio — the same `/api/music/device/*` protocol the sideloaded player speaks
  — behind a device-side switch that defaults to off. When the speaker is
  verified on hardware, the sideloaded player, its profile, panel, mode and
  tests are deleted in one commit. Until then it is documented as transitional
  and receives no changes.
- **The toolchain is shared, so it lives at the top**: `device/flythings-build/`
  rather than under the firmware that happened to need it first.

The repository stays one repository. The CJK font, the VIBE marks and the state
document fixtures are held bit-for-bit between TypeScript and C++ by tests that
only work because both sides are checked out together.

## Consequences

- The console distinguishes `official | music | zos` (then `official | zos`).
  The "sideload panel" is the music player's alone until it goes.
- `mise run os-hostcheck` is the one firmware self-check; `os-build`,
  `os-linkaudit` and `os-image` are the one build chain. `arcade-hostcheck`,
  `arcade-release` and `music-release` are gone or going.
- The link-audit size budget for ZOS moves: linking the MP3 decode path was the
  *accident* it guarded against, and it is now a feature. The new ceiling is
  set against the measured size of the two firmwares this unit already ran.
- ZOS's "try it without flashing" story is its own `/tmp` sideload, which already
  exists and restores the flashed firmware on power cycle. The sideloads were
  never the safe option; they were the only option before ZOS had one.
- The legacy single-market path (`src/controller.ts`, `/api/settings`,
  `/api/preview`) had no caller left and is deleted in the same pass.
