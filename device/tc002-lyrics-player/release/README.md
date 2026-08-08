# Release artifacts

This directory is empty by design in source control. It becomes usable only when it has:

- `bundle/` — the FlyThings build output (executable entry + resources) as a plain
  directory. The device busybox has no tar/unzip, so the bundle is pushed as a
  directory, not an archive.
- `manifest.json` — produced by `mise run music-release -- <bundle-source-dir> <semver> [entry]`.
  It records the entry name and a per-file SHA-256 list plus a `bundleId` digest.

Both `bundle/` and `manifest.json` are ignored by Git. The Pixel Studio session
manager re-reads them and re-checks every file's size and SHA-256 immediately
before a session. The bundle is pushed to the TC002 tmpfs (`/tmp/tc002-music`)
with `adb push bundle/. /tmp/tc002-music/` — nothing is written to flash, and a
power cycle always restores the official firmware.
