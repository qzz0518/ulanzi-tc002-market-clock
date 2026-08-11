# ADR 0005: The clock's address is repointable at runtime, and the console outranks the environment

- Status: Accepted
- Date: 2026-08-11

## Context

`CLOCK_HOST` was the single source of the device address, read once by `loadConfig()` and
required for the service to start. On the macOS install it lives in a launchd plist that the
console cannot edit.

That is fine until the clock's DHCP lease moves. From then on every device request fails, and
the only repair is to hand-edit a plist (or rerun the installer) and restart the service — from
a UI whose whole purpose is to talk to the device that just became unreachable. The settings
dialog had no way to show what address it was even trying, so the failure read as "the clock is
broken" rather than "the address is stale".

Two facts shaped the fix:

- Every device entry point in `src/clock-client.ts` interpolates `config.clockHost` **inside**
  the request (`readClockDeviceInfo`, `readClockGeneralSettings`, `writeClockGeneralSettings`,
  `postCustomApp`), and `config` is a plain mutable object. One assignment therefore repoints
  channel pushes, live frames, notify, general settings and the sideload verify at once.
- Exactly three call sites captured the host eagerly at construction and would have gone stale.

## Decision

1. `.runtime/clock-host.json` holds an optional override and **outranks `CLOCK_HOST`** on every
   start. The environment variable stays required and becomes a first-run seed. Env-wins was
   rejected: the plist is not editable from the console, so it would silently revert the user's
   fix across the very restart the feature promises to survive.
2. Changing the address is a single in-place assignment to the shared `AppConfig`. This is legal
   **only** because every consumer dereferences `config.clockHost` per call — hoisting it into a
   local or a constructor argument is now a breaking change.
3. The three eager captures were converted: `discoverControlAccess` became a per-call factory
   (a boot-time same-subnet verdict is wrong after a repoint), and both `Tc002SideloadInstaller`
   options take `get clockHost()` so the ADB target follows. `test/tc002-music-installer.test.ts`
   guards the getter, because it looks like a pointless indirection to a future reader.
4. `validateClockHost` in `src/config.ts` is the one validator, shared by the boot path and
   `PUT /api/device/host`, so the UI can never be told a rule the service disagrees with. It is
   provably the same rule as the installer's `isSafeHost`, so no accepted host can become an
   unsafe ADB target. The web mirror `clockHostError` is a convenience only; the server decides.
5. `PUT /api/device/host` persists, applies, **then probes** and returns the result. A failed
   probe never rejects the save — the clock may simply be powered off — but answering "saved"
   without saying whether it worked would be useless in the one situation this exists for.
6. `readClockInfo` keeps its three-field shape and `readClockDeviceInfo` returns all six. The
   serial number and MAC reach the settings dialog but stay out of `/health`, which is an
   unauthenticated snapshot anything on the LAN can poll. The clock itself already serves the
   same six fields unauthenticated at `http://<clock>/getBase`, so the dialog exposes nothing
   that a peer on the same Wi-Fi could not already read.

## Consequences

- `CLOCK_HOST` is still required at boot, so the tab repairs a **wrong** address, not a missing
  one. Relaxing that would cascade through `AppConfig`, both config tests, `scripts/install.sh`,
  `compose.yaml`, and would make both installer constructors throw on an empty host — taking the
  service down, which is the opposite of a recovery mode. The real failure is a moved lease on a
  device that was once configured.
- Once the file exists, `scripts/install.sh --host` and the plist are seeds only. The divergence
  is made visible instead of hidden: `GET /api/device/host` returns the live host, the boot host,
  and a `source` discriminator, and `DELETE` genuinely hands authority back to the environment.
- The settings dialog trigger is still disabled while sideload firmware runs, so the recovery tab
  is unreachable in that state. Repointing would not help there — the official HTTP API is not
  what is serving — but it is a real gap if the address changes during a firmware session.
- `/health`'s `deviceReachable` is sticky-true in `WorkspaceController` (it is never reset after
  the first successful push), so the tab deliberately keys its recovery UI off a live
  `/api/device/info` probe instead. Fixing that flag is left as separate work.
