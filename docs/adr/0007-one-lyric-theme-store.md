# ADR 0007: One lyric-theme store, two firmwares

- Status: Accepted
- Date: 2026-08-13

## Context

The console's 主题设置 panel offers three things — 显示形式 (`ticker` / `skyline` / `spotlight`
/ `cascade`), 像素配色 (`signal` / `tape` / `blueprint` / `arcade`), and an `rrggbb` accent that
overrides the palette's primary tier. Until now they reached exactly one reader: the sideloaded
lyrics player (ADR 0002), which polls `GET /api/music/device/state` and gets them out of the
module singleton `sDeviceState` in `src/control-api.ts`.

ZOS reads a different endpoint. `GET /api/os/pull` serves a line-oriented document that carried
`np/track/artist/playing/pos/dur/lyric` plus `setseq/setvol/setbri` and `input`, and nothing
about appearance at all. Its music screen was a bespoke renderer — a 12×12 equalizer at x=0 and
text from x=14, on a 52 px panel — so the theme panel was not broken under ZOS, it had never
been connected. The user's report was two symptoms of that one fact: a spectrum animation
covering the lyric, and a theme panel with no effect.

Porting the lyrics player's renderer into ZOS (`ui/MusicScreen.cpp`, sharing
`visual/LyricVisuals.h`) closes the visual half. The remaining question is where the *setting*
lives once two firmwares can render it.

## Decision

**The pull document exposes the same `sDeviceState` the sideload endpoints already own.** Three
new always-present lines — `mode`, `skin`, and `accent` (omitted when null) — are republished to
`OsLinkHub` after every `applyControlPatch`, from both `/api/music/device/control` (the console)
and `/api/music/device/report` (a key press on the player).

1. **The console already reads it that way.** `music-player.tsx` polls
   `/api/music/device/state?viewer=web` every 2.5 s and adopts `SKIN`/`MODE`/`ACCENT` back into
   React *in every firmware mode*. A separate ZOS store would leave the console displaying the
   sideload's theme while driving ZOS's — a disagreement that is invisible until someone is in
   the room with the clock.
2. **The two firmwares are mutually exclusive** (ADR 0004, `/tmp/tc002-sideload.id`), so there is
   never an arbitration problem — but the same user, same song and same panel cross between
   them. Two stores would mean picking 磁带橙 under ZOS, sideloading the player for local audio,
   and silently getting 信号绿 back.
3. **The values are the same enums with the same rendering semantics.** That is the parity
   requirement itself; a second store is a copy someone has to keep equal by hand.
4. **The device→console return path already exists.** `HostLink` posts to
   `/api/music/device/report` for transport commands, and that endpoint is `applyControlPatch`.
   A local theme control on ZOS would land in the store the console is already watching.

Three consequences follow, each a decision in its own right:

- **No `themeseq`.** This is the one console→device channel without a sequence. `setseq` exists
  because volume has a second writer — the knob — so a stale console value riding in every
  document would spring back the instant the user let go. The theme has no local control to
  fight: ZOS's music screen spends the knob on prev/next and the press on play/pause, and
  deliberately refuses the side buttons so volume keeps working. Applying it unconditionally on
  every document is idempotent, and is also what makes a device correct on its *first* poll
  rather than on the first click after boot. A theme cycle added later (the 设置 page is its
  natural home, not 音乐) must arrive with a `themeseq` and rising-edge gating.
- **The theme never expires.** It is a *setting*, not a *reading*: one writer, no external source
  that can die. The now-playing block has a 15 s staleness sweeper because it describes something
  happening elsewhere; a sweeper here would be the bug — the panel reverting to green because
  nobody clicked recently. The only gate on the device side is `sLink.online`, which means
  "adopt documents we actually received" rather than "expire what we adopted".
- **The device caches it in `/data/zos-prefs.ini`** as a warm start, through the existing
  debounced `DeviceControls::flushIfDue` commit. A cold boot has no link for seconds, and a
  flashed unit with no `/tmp/zos-host` never gets one, so the defaults would repaint the panel in
  front of a user who chose otherwise months ago. `/data` is jffs2 on raw NAND; committing per
  document would put a flash erase in the poll path.
- **The service persists it too**, in `.runtime/lyric-theme.json`, loaded into `sDeviceState`
  before `createControlHandler` primes the link. Not persisting is not a smaller version of
  persisting: `sDeviceState` is module memory, so a restart served the defaults, and because the
  device applies the theme unconditionally (no sequence, above) that single poll both repainted
  the panel *and* overwrote the `/data` cache that exists for exactly this — the user's own
  complaint, one restart later. Writes are queued rather than merely fired, because two renames
  in flight land in the order they finish rather than the order they were asked for.

**One line of the reference renderer is deliberately not ported literally**, and a future reader
diffing the two files will find it. `LyricsPage::paintSkyline` computes
`showText = hasLyric || !playing` and `maxLevel = showText ? 3 : 12` — but its own gate (a
painter runs only once a timed lyric line exists) makes `hasLyric` unconditionally true, so the
twelve-level branch is unreachable there and the bars have never been anything but a three-row
floor. ZOS has a second source for the row: the title/artist rotation for a track whose lyrics
never arrived, and 播放中 / 已暂停 under that. Copying the expression woke the dead branch and
answered the original complaint (频谱动画挡字) with a stronger version of it — a twelve-row
spectrum and no words at all — on the ordinary case of a Spotify track without lyrics. The web
preview, which is where the expression came from, could reach the same state and did; all three
now draw the floor unconditionally, which is the only behaviour any of them has ever shipped to
a user with lyrics on screen. `hasLyric` survives as what it actually means: the beat input.

Both directions of version skew degrade to the defaults, never to a blank screen. `StateDoc`
resets to spotlight/signal on every parse, so an older service that sends no theme lands
somewhere predictable rather than on whatever the last document happened to say; an unrecognised
mode or skin from a newer service resolves to the same defaults rather than being kept as a
half-parsed value. `MusicScreen::setTheme` ignores out-of-range ids on top of that.

The lyric *window* (`lyricat` / `lyricend`) travels the same path for a different reason: every
mode animates against progress within the line, and `pos`/`dur` describe the song. Both keys are
optional, and a line without them falls back to an untimed single sweep.

## Consequences

- The console's `localStorage` is demoted from a store to a first-paint cache. The page draws one
  frame from it and adopts the served theme on the first `/state` poll — which needs its own
  code path, because the echo below it is gated on the sequence advancing and a freshly started
  service answers the first poll with the same `seq 0` the page starts on. The page must NOT push
  `localStorage` back at the service, which is what it did while the service forgot: with a store
  behind `/state`, that would make whichever browser loaded last the authority, and a phone that
  has not opened the theme panel in a month would repaint the clock from memory.
  The price is paid once, and knowingly: on the first start after this change there is no
  `lyric-theme.json`, so a user who had picked a theme in the browser sees it revert and has to
  pick it again. Keeping the push for that one case would need the service to advertise whether
  it has a stored theme yet — a new field in a document the sideloaded firmware also parses,
  permanent, to smooth a single upgrade.
- `applyControlPatch` validates the whole patch into a candidate and commits it in one
  assignment. Field-by-field mutation with a throw in the middle could leave the two firmwares
  reading different values out of the one store this ADR exists to create — `{mode, accent}` with
  a bad accent answered 400 and still moved `mode` for the sideload's `/state`, while the ZOS
  document, republished only on the success path, kept the old one.
- `setLyricTheme` calls `bump()`, releasing every parked long poll. The accent picker is already
  `debounce={200}`, capping a drag at ~5 bumps/s of a ~400-byte document. Removing that prop
  would turn a colour drag into a poll storm.
- `test/os-link.test.ts` byte-compares `serialize()` against
  `device/tc002-os/hostcheck/fixtures/state-doc.txt`, which the C++ self-check parses. The two
  new always-present lines are in that fixture, so the cross-language contract fails on one side
  if only the other moves.
- `MUSIC_MODES` in the web console, `LYRIC_MODES`/`OS_LYRIC_MODES` in the service,
  `MusicScreen::Mode`, and the lyrics player's `Palette.h` are now four expressions of one
  ordering. The index is the wire value; reordering any of them for looks repaints the panel in
  something the console is not showing, with nothing to fail in between.
