# ADR 0008: A lyric line ends when the singing does

- Status: Accepted
- Date: 2026-08-13

## Context

A line's end was defined as the next line's start. `src/music/lyrics.ts` and
`src/netease-music.ts` both wrote

```ts
endMs: original[index + 1]?.startMs ?? Math.max(line.startMs + 2_000, trackDurationMs)
```

and all three renderers — the browser preview, `MusicScreen.cpp` on ZOS, `LyricsPage.cpp` on the
sideloaded player — derived their highlight from one scalar,
`clamp01((playhead - start) / (end - start))`, then spread it evenly over the glyphs with
`focus = (int)(prog * n)`.

That definition is wrong whenever a line is followed by anything other than another line, which
is the last line of every verse in every song. Measured on 孤勇者 (id 1901371647): the line
"谁说站在光里的才算英雄" is sung from 110330 for 5.29 s, and the next line does not begin until
128880. The pipeline handed the highlight an 18.55 s window for eleven glyphs — 1686 ms per
character against the singer's actual 481 — so the wipe crawled at under a third speed and was
still six glyphs from the end four seconds after the voice had stopped. Over a 50-track corpus,
56% of lines are followed by a real gap; the 184 lines where the naive rule overshoots by ≥2 s
overshoot by 8.2 s on average and up to 45 s.

The information to fix it properly was already being fetched and discarded. `lyric_new` — the
module `src/netease-music.ts` already calls — describes itself as 新版歌词 - 包含逐字歌词, asks
for `yv/ytv/yrv`, and returns a `yrc` field carrying NetEase's word-level timings.
`parseLyricResponse` read only `lrc` and `tlyric`.

## Decision

**A line's `endMs` is when it stopped being SUNG. The next line's start is only a ceiling.**

Three sources, in descending order of confidence, recorded in a required `endSource` field on
`MusicLyricLine` so no consumer can mistake a guess for a measurement:

| `endSource` | Where it comes from |
| --- | --- |
| `words` | The last word's end, from `yrc`. Exact. ~19-25% of NetEase tracks. |
| `marker` | A bare `[mm:ss.xx]` line in the LRC — the source's own end mark. |
| `estimate` | Our singing-rate cap. A guess, and an honest one. |
| `next` | Nothing below the successor was tighter, so nothing had to be guessed. |

Without word timings the three remaining bounds are **min'd**, not ranked — see below. `words`
is the only source that answers outright.

`endSource` is **required, not optional**, because "never fabricate market data" has a sibling
here and the type system is the cheapest place to enforce it: every construction site has to
answer where its number came from, and the console shows the answer (逐字 / 估算).

### The estimate: 630 ms per unit, floored at 900 ms

A unit is one CJK codepoint or one English syllable — the corpus puts them at 415 ms and 362 ms
median, close enough that one constant covers both rather than a branch that does not move the
scores. 630 is the measured **p90**, not the median, and the reason is the one counter-intuitive
finding of the whole exercise:

> **A singing-rate model is a bad estimator and a good cap.** Scored against yrc ground truth,
> using the median rate (420 ms) as the estimate is *worse* than the naive next-line rule — every
> line ends on a held note that no rate model predicts, so it undershoots almost half of all
> lines by more than 250 ms. Taking the p90 and using it only as an upper bound cuts the mean
> error on the lines the user complains about from 8175 ms to 1923 ms while touching almost
> nothing else.

The 900 ms floor keeps a one- or two-character line from reading as a flash.

This is deliberately imperfect and the code says so. The worst residual in the corpus is
"I just wanna let go (I, I just wanna let go)", genuinely sung for 48.6 s and estimated at 5.05:
that line will finish early and hold. **A line that stops early and waits is far better than one
crawling at an eighth speed**, which is the defect being removed.

### The bare `[mm:ss.xx]` line is data — but it is a bound, not an answer

`parseLrc` dropped timestamp-only lines because they carry no text. They are LDDC's
`add_end_timestamp_line` output — what gets written whenever word-level lyrics are downgraded to
line-level LRC — and lrclib is full of entries produced that way. This is the **only** duration
information the Spotify path ever receives, since lrclib has no word-level field at all.

They are also ambiguous: an end mark and a section separator are the same token, and nothing in
the format distinguishes them. Measured on 21 tracks that carry both an LRC and a `yrc` for the
same NetEase recording — 65 of 1057 NetEase LRC lines and 88 of 870 lrclib lines are followed by
a usable mark, 139 of which can be scored against word-level truth:

| rule | MAE | p90 | lines still crawling >2 s |
| --- | --- | --- | --- |
| naive (successor's start) | 7545 | 16740 | 78 / 139 |
| marker wins outright | 1636 | 3982 | 36 |
| estimate only, marker ignored | 2794 | 7676 | 37 |
| **min(successor, marker, cap)** | **1162** | **2840** | **15** |
| marker accepted if ≤ 2× cap | 1374 | 3290 | 29 |

Letting the mark win outright is the user's own complaint back again: on 孤勇者 the mark after
谁说站在光里的才算英雄 sits 300 ms before the next line and claims 18.06 s for a line `yrc`
measures at 5.27 s. Every tolerance band tried (1.5× to 4× the cap) scored worse than the plain
minimum on both error and crawl count, so there is no separator/end-mark discriminator to be
had — only the cap. A mark shorter than the 900 ms floor is clamped up to it for the same
reason in the other direction.

### The cursor replaces the scalar

`prog` cannot express non-uniform advance, so the renderers take a `LyricCursor`
(`{index, frac, progress, phase}`) instead. It is a **strict generalisation**: with no cell table
it reproduces `floor(p·n)` and `p` bit for bit, so a line-level-only track — the entire Spotify
catalogue — behaves exactly as it did. `test/lyric-timing.test.ts` asserts that over 200 random
inputs against the retained old function.

Words are split into **one cell per codepoint on the service**, not on the device: the split is a
pure function with tests, both firmwares get the same answer, and the wire table's index *is* the
glyph index, so there is no device-side arithmetic to disagree about. A table that does not
reconstruct the line's text exactly, or whose onsets run backwards, is refused outright — one
cell out of step lights the wrong character for the rest of the song and is invisible on a
screenshot.

### Two clocks, and only one of them is the highlight

`endMs` (sung) and `untilMs` (when the next line takes over) are now different numbers, and the
cascade mode is the one place that must use the second. Its exit ramp starts at 0.86 of its
input; keyed on the sung progress the line would fly off the panel the instant the voice stopped
and leave the panel blank for the whole instrumental. Colouring, focus glyph, fill bar, beat and
scroll all run on the sung clock; only the entrance/exit choreography runs on the window.

### Transport

- **ZOS** (`/api/os/pull`): `lyricend` **keeps its key and gains a tighter meaning, but only for
  a firmware that asks for it.** ZOS is flashed, not sideloaded, so a device in the field keeps
  its build across service restarts and there is no moment where the two are guaranteed to move
  together — and `MusicScreen::lineProgress()` feeds `lyricend` straight into `cascadeBandY`,
  whose exit ramp reaches y = -16 at progress 1.0. Tightening the key underneath an un-upgraded
  build would fly the line off the panel the instant the singer stops and leave 升降 blank for
  the whole instrumental (13.3 s on 孤勇者). So the device reports a `proto` in
  `/api/os/report` and `OsLinkHub.serialize()` writes the encoding it asked for: `proto >= 2`
  gets the sung `lyricend` plus the new `lyricuntil` and `lyricw` keys, anything else gets byte
  for byte the document it got before this change. A change of `proto` bumps the sequence once
  per device boot so a freshly flashed unit does not wait for the next lyric line. `lyricw` must
  be a single comma-separated field because `StateDoc::splitTabs(line, fields, 4)` stops after
  three tabs. Measured cost: a 24-cell table is ~207 bytes on a 319-byte document.
- **Sideload player** (`/api/music/device/now`): **versioned by query parameter**, because the
  deployed parser splits on the first tab and treats any key that is not `DUR` as a start time —
  a new record type would land as a garbage line at 0 ms and an extra column would render as
  literal tab-separated text. No `?v` returns the old bytes verbatim, and a test locks that byte
  for byte; `?v=2` returns `V`/`DUR`/`L`/`W` records.

## Consequences

- `lyricend`'s meaning changed under a stable key, so the key is now capability-gated rather than
  unconditional. The alternative — ship the tighter meaning to everyone and fix three of the four
  modes on un-upgraded devices for free — was rejected because the fourth mode goes black, and
  nothing in the repo forces the service and the firmware to deploy together. The cost is that an
  un-upgraded ZOS gets no improvement at all until it is reflashed; the legacy branch in
  `serialize()` can be deleted once no such device can still be running.
- Glyph layout is now **protocol**. The browser preview previously skipped whitespace when
  counting focus spans and collapsed all whitespace runs where the service collapses only tab and
  newline; both were cosmetic mismatches with the firmwares and are now correctness bugs. Both
  are fixed here, and the cell table and the label are truncated together by construction rather
  than by a comparison somebody has to remember.
- About three quarters of tracks have no `yrc`, so the estimate is the main path, not a fallback.
- The Spotify non-official `color-lyrics` endpoint was considered and rejected: it needs an
  `sp_dc` cookie, violates the terms of service, and carries only `LINE_SYNCED` anyway. The
  Spotify path stays lrclib (with its end marks) plus the NetEase fallback — which, because that
  fallback now preserves word timings instead of re-deriving ends from the next line, is the one
  way a Spotify track can reach karaoke-grade timing.
