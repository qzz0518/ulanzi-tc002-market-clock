# FlyThings adapter boundary

This is intentionally an overlay, not a generated FlyThings IDE project. Start from Ulanzi's
official `Z21_TC002_Demo`, then add the pure C++ core from the parent directory.

The adapter still has to provide and verify these device-specific pieces:

1. A generated EasyUI Activity and `.ftu` screen entry.
2. A LAN HTTP client that polls playback state without receiving the NetEase cookie.
3. A bounded audio cache under `/tmp`, followed by the official Demo's
   `AudioManager::playAudio(localPath)` path. URL playback is not assumed because the official
   example only proves local-file playback.
4. A renderer that writes the core's 52×16 frame through the Demo's MCU/LED path.
5. Top-button and knob mappings for play/pause, previous/next, and volume.
6. Backoff, stale-state, storage-limit, and disconnect behavior.

Do not copy `Manifest.xml` over a generated project blindly. Compare it with the packages
resolved by the installed FlyThings IDE and keep the IDE's lock/project metadata authoritative.
