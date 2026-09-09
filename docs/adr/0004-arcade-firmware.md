# ADR 0004: The arcade is a second sideloaded app on a parameterized sideload stack

- Status: Superseded by [ADR 0014](0014-two-tiers-official-and-zos.md) (2026-09-09) — the
  engines live in `device/tc002-os`; the sideloaded arcade app is removed.
- Date: 2026-08-10

## Context

Knob-controlled games need on-device input; the official firmware exposes no key events over
HTTP (ADR 0003 kept browser games on the live channel for that reason). The music player
(ADR 0002) proved the full path: FlyThings app in tmpfs, evdev input, SPI LED drive,
`AudioManager` sound, non-persistent ADB sideload with flash never written. The MCU serial
protocol carries battery/USB/version/power-off commands, and `base::AudioPlayer` is a
multi-instance PCM mixer suited to low-latency sound effects.

## Decision

1. Games on the device ship as a **separate sideloaded app** (`device/tc002-arcade/`), not as
   pages inside the music player. The two apps are peers and mutually exclusive by
   construction (both claim `/tmp/EasyUI.cfg` and restart `zkswe`).
2. The server-side sideload stack is **parameterized, not copied**: one installer class plus a
   `SideloadProfile` (appId, remote dir slug, confirmation phrase, release dir, cleanup list,
   copy). The tmpfs/busybox constraints encoded in the installer stay single-sourced.
3. Session identity becomes explicit: entry scripts write `/tmp/tc002-sideload.id`, and the
   alive check matches it, fixing the pre-existing ambiguity where both installers would
   recognize any `/tmp`-loaded firmware as their own session.
4. The arcade build **reuses the music player's `flythings-build/`** (toolchain, packages,
   device libs) via the Makefile's overridable `APP`/`OUT` variables; nothing is duplicated.
5. The web console shares one `<FirmwarePanel>` (API prefix as a prop) and one derived
   `firmwareOnline` state; the arcade reports liveness through a 5s heartbeat endpoint rather
   than the music player's 2s state poll.
6. Game engines are direct C++ translations of the verified web engines (same physics
   constants); the CJK font is omitted — menus and HUD are ASCII-only.

## Consequences

- Sideload safety, recovery semantics, and the release manifest (schema v3) are identical for
  both apps; users learn one flow.
- The music bundle's entry script gains the identity file too; an id-less legacy session is
  treated as the music player's own (backward compatible).
- Battery field semantics of MCU command 0x03 are unverified on hardware; the info page shows
  raw values until a device test settles the interpretation.
- Only one sideloaded experience can run at a time; switching apps is a stop/start cycle
  through the web console.
