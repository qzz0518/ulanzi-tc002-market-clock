/**
 * The karaoke clock, against real numbers.
 *
 * This is a timing bug: nothing in a screenshot can show it and nothing in the
 * type system can prevent it, so the assertions here are the only thing holding
 * the fix in place. Every figure below is either taken verbatim from a NetEase
 * `lyric_new` response or measured over a 50-track / 2567-line yrc corpus, and
 * the tests that matter most name the OLD answer next to the new one.
 */
import { describe, expect, test } from "bun:test";
import {
  decodeLyricCells,
  encodeLyricCells,
  estimateSungEndMs,
  lyricCells,
  lyricCursorAt,
  lyricUnits,
  lyricWindowProgress,
  LYRIC_MIN_LINE_MS,
  LYRIC_MS_PER_UNIT,
  parseLrcEndMarkers,
  parseYrc,
  type LyricCell,
} from "../src/music/lyric-timing.ts";
import { buildLyricLines, parseLrc } from "../src/music/lyrics.ts";

/* ------------------------------------------------------------------ */
/* Fixtures — verbatim from the wire                                    */
/* ------------------------------------------------------------------ */

// 孤勇者 (id 1901371647), the line the user reported. Sung from 110330 for
// 5.29 s; the next line does not begin until 128880.
const GUYONGZHE =
  "[110330,5290](110330,350,0)谁(110680,250,0)说(110930,460,0)站(111390,400,0)在"
  + "(111790,400,0)光(112190,400,0)里(112590,640,0)的(113230,380,0)才(113610,390,0)算"
  + "(114000,340,0)英(114340,1280,0)雄";
const GUYONGZHE_NEXT = "[128880,5210](128880,320,0)他(129200,120,0)们(129320,770,0)说 ";

// Blinding Lights — Latin script, where yrc puts the space INSIDE the word.
const BLINDING = "[27360,1290](27360,240,0)I've (27600,90,0)been (27690,360,0)tryna (28050,600,0)call";

// The credit blobs really are the first records of the `yrc` field.
const CREDITS = '{"t":-1000,"c":[{"tx":"作词: "},{"tx":"唐恬","li":"http://p.jpg"}]}';

function line(raw: string, trackDurationMs = 260_000) {
  return buildLyricLines(parseYrc(raw), trackDurationMs)[0]!;
}

function cellsOf(raw: string, trackDurationMs = 260_000): LyricCell[] {
  const built = line(raw, trackDurationMs);
  return lyricCells(built);
}

/* ------------------------------------------------------------------ */

describe("yrc parsing", () => {
  test("reads the grammar NetEase actually emits", () => {
    const [parsed] = parseYrc(GUYONGZHE);
    expect(parsed!.startMs).toBe(110_330);
    expect(parsed!.text).toBe("谁说站在光里的才算英雄");
    expect(parsed!.words).toHaveLength(11);
    // Word starts are ABSOLUTE track time, not offsets into the line.
    expect(parsed!.words![0]).toEqual({ startMs: 110_330, endMs: 110_680, text: "谁" });
    // 雄 is held for 1.28 s — nearly four times the length of 谁. This is the
    // information a single scalar progress can never carry.
    expect(parsed!.words![10]).toEqual({ startMs: 114_340, endMs: 115_620, text: "雄" });
  });

  test("keeps the space yrc puts inside a Latin word", () => {
    const [parsed] = parseYrc(BLINDING);
    // Verbatim: the text must be the words laid end to end, because the wire
    // protocol identifies a glyph by its index into exactly this string.
    expect(parsed!.words!.map((word) => word.text)).toEqual(["I've ", "been ", "tryna ", "call"]);
    expect(parsed!.text).toBe("I've been tryna call");
    expect(parsed!.words!.map((word) => word.text).join("")).toBe(parsed!.text);
  });

  test("skips the credit metadata rather than timing it at zero", () => {
    // Without this the JSON blob parses as a line whose "words" are punctuation
    // and whose start is 0 — it would be the first thing the panel showed.
    const parsed = parseYrc(`${CREDITS}\n${GUYONGZHE}`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.text).toBe("谁说站在光里的才算英雄");
  });

  test("survives every shape a real album throws at it", () => {
    expect(parseYrc(undefined)).toEqual([]);
    expect(parseYrc("")).toEqual([]);
    // A header with no words at all.
    expect(parseYrc("[1000,2000]")).toEqual([]);
    // Words with no header — the header is not what the renderer walks.
    expect(parseYrc("(500,300,0)a(800,300,0)b")[0]).toMatchObject({ startMs: 500, text: "ab" });
    // Blank lines, and a line that is nothing but whitespace words.
    expect(parseYrc("\n\n(0,100,0) (100,100,0)  \n")).toEqual([]);
    // Out-of-order lines are sorted; the panel walks them by index.
    const sorted = parseYrc(`${GUYONGZHE_NEXT}\n${GUYONGZHE}`);
    expect(sorted.map((entry) => entry.startMs)).toEqual([110_330, 128_880]);
  });

  test("trusts the words over a header that disagrees with them", () => {
    // Measured on 131 of 2659 corpus lines. The words are what gets rendered,
    // so a header claiming otherwise is simply wrong about this line.
    const [parsed] = parseYrc("[100000,1000](100000,300,0)a(100300,900,0)b");
    expect(parsed!.startMs).toBe(100_000);
    expect(line("[100000,1000](100000,300,0)a(100300,900,0)b").endMs).toBe(101_200);
  });

  test("trims the whitespace at a line's edges but not inside it", () => {
    const [parsed] = parseYrc("[0,900](0,300,0) 你(300,300,0) 好 (600,300,0) ");
    expect(parsed!.text).toBe("你 好");
    expect(parsed!.words!.map((word) => word.text).join("")).toBe(parsed!.text);
  });
});

describe("the sung end", () => {
  test("THE REPORTED BUG: a verse-ending line closes when the voice does", () => {
    const lines = buildLyricLines(parseYrc(`${GUYONGZHE}\n${GUYONGZHE_NEXT}`), 260_000);
    const reported = lines[0]!;

    expect(reported.startMs).toBe(110_330);
    expect(reported.endMs).toBe(115_620);
    expect(reported.endSource).toBe("words");

    // The old rule was `endMs = next.startMs`. Named here rather than described,
    // because the size of the gap is the entire complaint:
    const oldEndMs = lines[1]!.startMs;
    expect(oldEndMs).toBe(128_880);
    expect(oldEndMs - reported.endMs).toBe(13_260);
    // 18.55 s of window for 5.29 s of singing — the highlight crossed eleven
    // glyphs at 1686 ms each while the singer averaged 481.
    expect((oldEndMs - reported.startMs) / (reported.endMs - reported.startMs))
      .toBeCloseTo(3.5, 1);
  });

  test("THE USER'S EXACT CASE, on a line-level-only track", () => {
    // "a line at t=10s followed by a 15-second instrumental and a next line at
    // t=27s". No word timings anywhere — this is what three quarters of NetEase
    // and the whole of Spotify look like.
    const lines = buildLyricLines(
      [{ startMs: 10_000, text: "谁说站在光里的才算英雄" }, { startMs: 27_000, text: "他们说" }],
      200_000,
    );
    const first = lines[0]!;

    // Eleven glyphs at the measured p90 rate. The highlight completes here…
    expect(first.endMs).toBe(10_000 + 11 * LYRIC_MS_PER_UNIT);
    expect(first.endMs).toBe(16_930);
    expect(first.endSource).toBe("estimate");
    // …and emphatically NOT at the next line's start, which is what it used to do.
    expect(first.endMs).not.toBe(27_000);
    expect(27_000 - first.endMs).toBe(10_070);

    const at = (playheadMs: number) =>
      lyricCursorAt({ ...first, cellCount: 11 }, playheadMs);
    // Ten seconds into the instrumental the line is simply finished.
    expect(at(20_000).phase).toBe("held");
    expect(at(20_000).progress).toBe(1);
    expect(at(26_999).phase).toBe("held");
    // The old formula would have been on glyph 6 of 11 at 20 s, still crawling.
    expect(Math.floor(((20_000 - 10_000) / (27_000 - 10_000)) * 11)).toBe(6);
  });

  test("only ever shortens a line, never pushes it past its successor", () => {
    // Property, over the whole space the estimator can be asked about: the next
    // line's start is a hard ceiling, and equality is exactly the "next" source.
    for (let units = 1; units <= 40; units += 1) {
      const text = "字".repeat(units);
      for (const windowEndMs of [200, 900, 1_500, 4_000, 9_000, 30_000, 120_000]) {
        const result = estimateSungEndMs({ startMs: 0, text, windowEndMs });
        expect(result.endMs).toBeLessThanOrEqual(windowEndMs);
        expect(result.endMs).toBeGreaterThan(0);
        if (result.source === "next") expect(result.endMs).toBe(windowEndMs);
        else expect(result.source).toBe("estimate");
      }
    }
  });

  test("uses the source's own end mark when it is the tightest bound", () => {
    // A bare [mm:ss.xx] is what LDDC writes when it downgrades word-level lyrics
    // to LRC, and lrclib is full of entries produced that way. parseLrc drops
    // these lines because they carry no text, which threw away the only end
    // information the Spotify path ever gets.
    const synced = "[00:13.42] I've been tryna call\n[00:15.90]\n[00:26.95] Yeah";
    expect(parseLrcEndMarkers(synced)).toEqual([15_900]);
    const lines = buildLyricLines(parseLrc(synced), 200_000, undefined, {
      endMarkersMs: parseLrcEndMarkers(synced),
    });
    expect(lines[0]).toEqual({
      startMs: 13_420,
      endMs: 15_900,
      text: "I've been tryna call",
      endSource: "marker",
    });
    // The naive rule gave the line 13.53 s; the rate cap would have allowed
    // 5 syllables x 630 = 3.15 s. The source says 2.48 s, and it is believed
    // because it is the tightest of the three bounds.
    expect(estimateSungEndMs({ startMs: 13_420, text: "I've been tryna call", windowEndMs: 26_950 }).endMs)
      .toBe(13_420 + 5 * LYRIC_MS_PER_UNIT);
    expect(26_950 - 13_420).toBe(13_530);
  });

  test("treats an end mark as a bound, never as an answer", () => {
    // A bare timestamp is ambiguous in the format — an end mark and a section
    // separator look identical — and 36 of the 139 marker-bearing lines that can
    // be scored against `yrc` ground truth are separators overshooting the real
    // end by more than 2 s. This is the worst of them, from 孤勇者's own LRC: the
    // mark sits 300 ms before the successor and claims 18.06 s for a line sung
    // in 5.27 s. Letting it win outright is the user's complaint back again.
    const separator = estimateSungEndMs({
      startMs: 110_350,
      text: "谁说站在光里的才算英雄",
      windowEndMs: 128_710,
      markerMs: 128_410,
    });
    expect(separator.source).toBe("estimate");
    expect(separator.endMs).toBe(110_350 + 11 * LYRIC_MS_PER_UNIT);

    // …and the degenerate direction: a mark on top of the line's own start is
    // not a 50 ms line, it is a separator that landed early.
    const flash = estimateSungEndMs({
      startMs: 10_000,
      text: "Hello world",
      windowEndMs: 30_000,
      markerMs: 10_050,
    });
    expect(flash.endMs).toBe(10_000 + LYRIC_MIN_LINE_MS);
    expect(flash.source).toBe("estimate");
  });

  test("does not mistake a separator timestamp for an end mark", () => {
    // A bare tag sitting exactly on the successor's start says nothing about
    // where the singing stopped; taking it would be the old bug in a new hat.
    const result = estimateSungEndMs({
      startMs: 1_000,
      text: "一二三四五六七八",
      windowEndMs: 20_000,
      markerMs: 20_000,
    });
    expect(result.source).toBe("estimate");
    expect(result.endMs).toBe(1_000 + 8 * LYRIC_MS_PER_UNIT);
  });

  test("a marker can only ever shorten a line", () => {
    // Property, over the whole space: adding a mark never moves the end later
    // than the same call without one, and never past the successor.
    const text = "站在光里的才算英雄";
    for (const windowEndMs of [1_200, 4_000, 9_000, 30_000]) {
      const bare = estimateSungEndMs({ startMs: 0, text, windowEndMs });
      for (const markerMs of [-500, 0, 1, 400, 900, 2_000, 5_670, 8_000, 29_999, 60_000]) {
        const marked = estimateSungEndMs({ startMs: 0, text, windowEndMs, markerMs });
        expect(marked.endMs).toBeLessThanOrEqual(bare.endMs);
        expect(marked.endMs).toBeLessThanOrEqual(windowEndMs);
        // …and never so short that the line reads as a flash rather than a line.
        expect(marked.endMs).toBeGreaterThanOrEqual(Math.min(windowEndMs, LYRIC_MIN_LINE_MS));
      }
    }
  });

  test("keeps a one-glyph line on screen long enough to read", () => {
    const result = estimateSungEndMs({ startMs: 0, text: "啊", windowEndMs: 8_000 });
    expect(result.endMs).toBe(LYRIC_MIN_LINE_MS);
    expect(result.endMs).toBeGreaterThan(LYRIC_MS_PER_UNIT);
  });

  test("counts CJK by glyph and Latin by syllable", () => {
    // One unit is one beat of singing. The corpus puts a Chinese character at
    // 415 ms and an English syllable at 362 — the same order of magnitude, which
    // is why one rate covers both.
    expect(lyricUnits("谁说站在光里的才算英雄")).toBe(11);
    expect(lyricUnits("I've been tryna call")).toBe(5);
    expect(lyricUnits("こんにちは")).toBe(5);
    expect(lyricUnits("안녕하세요")).toBe(5);
    // Mixed scripts add up rather than picking a side.
    expect(lyricUnits("Hey 你好")).toBe(3);
    // Punctuation is silent, but a line of it still gets a window.
    expect(lyricUnits("…—！")).toBe(1);
    expect(lyricUnits("")).toBe(1);

    // The two estimates that follow, so the constants are visible as durations
    // rather than as a multiplication somewhere else.
    expect(estimateSungEndMs({ startMs: 0, text: "谁说站在光里的才算英雄", windowEndMs: 99_000 }).endMs)
      .toBe(6_930);
    expect(estimateSungEndMs({ startMs: 0, text: "I've been tryna call", windowEndMs: 99_000 }).endMs)
      .toBe(3_150);
  });

  test("the estimate beats the old rule on the line that started this", () => {
    // Same line, word timings deleted — the honest comparison, since ~75-80% of
    // tracks land here.
    const truth = 115_620;
    const estimated = estimateSungEndMs({
      startMs: 110_330,
      text: "谁说站在光里的才算英雄",
      windowEndMs: 128_880,
    }).endMs;
    expect(estimated).toBe(117_260);
    expect(Math.abs(estimated - truth)).toBe(1_640);
    expect(Math.abs(128_880 - truth)).toBe(13_260);
    expect(Math.abs(estimated - truth)).toBeLessThan(Math.abs(128_880 - truth) / 8);
  });

  test("is honest that it can cut a genuinely long note short", () => {
    // The worst residual in the corpus: "I just wanna let go (I, I just wanna
    // let go)" is really sung for 48.6 s. The estimate gives it ~5 s and the
    // line then holds, finished, for the rest. Documented as a deliberate
    // trade — a line that stops early reads far better than one crawling at an
    // eighth of the speed of the voice, which is the defect being fixed.
    const held = estimateSungEndMs({
      startMs: 0,
      text: "I just wanna let go (I, I just wanna let go)",
      windowEndMs: 48_600,
    });
    expect(held.source).toBe("estimate");
    expect(held.endMs).toBeLessThan(10_000);
  });
});

describe("word timings become glyph cells", () => {
  test("one cell per codepoint, in the panel's own layout order", () => {
    const cells = cellsOf(GUYONGZHE);
    expect(cells).toHaveLength(11);
    expect(cells.map((cell) => cell.text).join("")).toBe("谁说站在光里的才算英雄");
    expect(cells[0]).toEqual({ startMs: 110_330, endMs: 110_680, text: "谁" });
    expect(cells[10]).toEqual({ startMs: 114_340, endMs: 115_620, text: "雄" });
  });

  test("splits a multi-glyph word evenly and gives whitespace a zero-width slot", () => {
    // AMLL's timePerUnit: a word's time divided over its non-whitespace
    // codepoints. The space still gets an index — both firmwares' layoutRow
    // counts every cell — but no duration, so the cursor can never rest on it.
    const cells = cellsOf(BLINDING);
    expect(cells).toHaveLength(20);
    expect(cells.map((cell) => cell.text).join("")).toBe("I've been tryna call");
    // "I've " is 240 ms over four lit glyphs.
    expect(cells.slice(0, 4).map((cell) => cell.endMs - cell.startMs)).toEqual([60, 60, 60, 60]);
    expect(cells[4]).toEqual({ startMs: 27_600, endMs: 27_600, text: " " });
  });

  test("gives a zero-duration word somewhere to be lit", () => {
    // 2.1% of yrc words are declared with duration 0. Left alone that glyph can
    // never be the focused one, which reads as a dropped character. Stretching
    // to the next onset keeps the source's own attack and infers only where the
    // note was released.
    const cells = cellsOf("[5000,600](5000,0,0)啊(5200,400,0)哈");
    expect(cells[0]).toEqual({ startMs: 5_000, endMs: 5_200, text: "啊" });
    // …and never past the glyph that follows it.
    expect(cells[0]!.endMs).toBeLessThanOrEqual(cells[1]!.startMs);
    expect(lyricCursorAt({ startMs: 5_000, endMs: 5_600, cellCount: 2, cells }, 5_100).index)
      .toBe(0);

    // Capped rather than run to the end of the line, when nothing follows.
    const trailing = cellsOf("[9000,3000](9000,2000,0)长(11000,0,0)音");
    expect(trailing[1]!.endMs - trailing[1]!.startMs).toBeLessThanOrEqual(400);
  });

  test("refuses to build a table that does not fit its line", () => {
    // The one failure that is invisible on a screenshot and impossible to
    // diagnose from the device: a table one cell out of step lights the wrong
    // character for the rest of the song. Nothing is better than wrong.
    expect(lyricCells({
      startMs: 0,
      endMs: 1_000,
      text: "谁说站在光里的才算英雄",
      words: [{ startMs: 0, endMs: 1_000, text: "谁说站在光" }],
    })).toEqual([]);
    expect(lyricCells({ startMs: 0, endMs: 1_000, text: "abc" })).toEqual([]);
    expect(lyricCells({ startMs: 0, endMs: 1_000, text: "abc", words: [] })).toEqual([]);
  });

  test("survives words that overlap or arrive out of order", () => {
    // yrc has not been seen doing either, but qrc/lys allow overlap for duets
    // and nothing upstream promises order. The table must still reconstruct the
    // text, and the cursor must still terminate.
    const overlapping = lyricCells({
      startMs: 0,
      endMs: 900,
      text: "abcd",
      words: [
        { startMs: 0, endMs: 600, text: "ab" },
        { startMs: 300, endMs: 900, text: "cd" },
      ],
    });
    expect(overlapping).toHaveLength(4);
    for (const at of [0, 150, 320, 450, 700, 899, 5_000]) {
      const cursor = lyricCursorAt({ startMs: 0, endMs: 900, cellCount: 4, cells: overlapping }, at);
      expect(cursor.index).toBeGreaterThanOrEqual(-1);
      expect(cursor.index).toBeLessThan(4);
      expect(cursor.progress).toBeGreaterThanOrEqual(0);
      expect(cursor.progress).toBeLessThanOrEqual(1);
    }

    // Words in the wrong order are refused outright. A karaoke wipe is
    // monotonic in glyph index by definition, so a table whose onsets run
    // backwards cannot drive one — it would send the cursor jumping around the
    // row. The line falls back to the level-timed sweep, which is at least
    // always left to right.
    expect(lyricCells({
      startMs: 0,
      endMs: 900,
      text: "ab",
      words: [
        { startMs: 600, endMs: 900, text: "a" },
        { startMs: 0, endMs: 300, text: "b" },
      ],
    })).toEqual([]);
  });
});

describe("the cursor", () => {
  const REPORTED = {
    startMs: 110_330,
    endMs: 115_620,
    cellCount: 11,
    cells: cellsOf(GUYONGZHE),
  };
  const GLYPHS = [..."谁说站在光里的才算英雄"];
  const at = (playheadMs: number) => lyricCursorAt(REPORTED, playheadMs);
  // The formula all three renderers shared, given the old 18.55 s window.
  const sweep = (playheadMs: number) => GLYPHS[Math.min(10, Math.floor(
    Math.min(1, Math.max(0, (playheadMs - 110_330) / (128_880 - 110_330))) * 11,
  ))];

  test("is on the glyph being sung at several real timestamps", () => {
    expect(at(110_000).index).toBe(-1);
    expect(at(110_000).phase).toBe("pending");

    expect(GLYPHS[at(111_000).index]).toBe("站");
    expect(at(111_000).frac).toBeCloseTo((111_000 - 110_930) / 460, 6);
    expect(sweep(111_000)).toBe("谁");

    expect(GLYPHS[at(113_000).index]).toBe("的");
    expect(sweep(113_000)).toBe("说");

    expect(GLYPHS[at(114_500).index]).toBe("雄");
    expect(at(114_500).phase).toBe("singing");
    expect(sweep(114_500)).toBe("站");

    // The complaint, exactly: 4.4 s after the singer stopped the old formula was
    // still six glyphs from the end.
    expect(at(120_000)).toEqual({ index: 10, frac: 1, progress: 1, phase: "held" });
    expect(sweep(120_000)).toBe("里");
  });

  test("holds on the glyph that just finished during a gap between words", () => {
    // 1.2% of adjacent yrc words do not butt up against each other. Advancing
    // into a glyph the singer has not reached is worse than waiting on the one
    // they just left — this is the semantics of AMLL's per-word clamp().
    const cells = lyricCells({
      startMs: 0,
      endMs: 400,
      text: "ab",
      words: [{ startMs: 0, endMs: 100, text: "a" }, { startMs: 300, endMs: 400, text: "b" }],
    });
    const cursor = lyricCursorAt({ startMs: 0, endMs: 400, cellCount: 2, cells }, 200);
    expect(cursor).toEqual({ index: 0, frac: 1, progress: 0.5, phase: "singing" });
  });

  test("REPRODUCES THE OLD ARITHMETIC EXACTLY when there are no word timings", () => {
    // The regression that would hurt most: lrclib is line-level LRC and it is
    // the entire Spotify catalogue. The cursor has to be a strict
    // generalisation, so for an untimed line it must equal floor(p·n) and p —
    // not approximately, bit for bit.
    let seed = 20240607;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const startMs = Math.floor(random() * 200_000);
      const span = 1 + Math.floor(random() * 30_000);
      const endMs = startMs + span;
      const count = 1 + Math.floor(random() * 24);
      const playheadMs = startMs - 500 + Math.floor(random() * (span + 1_000));
      const cursor = lyricCursorAt({ startMs, endMs, cellCount: count }, playheadMs);
      const progress = Math.min(1, Math.max(0, (playheadMs - startMs) / Math.max(1, span)));

      if (playheadMs < startMs) {
        expect(cursor).toEqual({ index: -1, frac: 0, progress: 0, phase: "pending" });
        continue;
      }
      expect(cursor.progress).toBe(progress);
      expect(cursor.index).toBe(Math.min(count - 1, Math.floor(progress * count)));
      expect(cursor.phase).toBe(progress >= 1 ? "held" : "singing");
    }
  });

  test("ignores a cell table that does not match the row it is drawing", () => {
    // The panel truncates a long label; a table built before that truncation
    // would light the wrong glyph. Length disagreement means fall back, always.
    const cells = cellsOf(GUYONGZHE);
    const mismatched = lyricCursorAt(
      { startMs: 110_330, endMs: 115_620, cellCount: 5, cells },
      113_000,
    );
    // 5 cells claimed, 11 supplied → the untimed sweep over five glyphs.
    expect(mismatched.progress).toBeCloseTo((113_000 - 110_330) / 5_290, 6);
    expect(mismatched.index).toBe(2);
  });

  test("does not divide by zero on a degenerate line", () => {
    expect(lyricCursorAt({ startMs: 0, endMs: 0, cellCount: 0 }, 0))
      .toEqual({ index: -1, frac: 0, progress: 0, phase: "pending" });
    // Zero-length window: the span floors at 1 ms rather than dividing by zero,
    // so the line is at its start on the instant it starts and finished
    // immediately after — never NaN, which would blank the row.
    expect(lyricCursorAt({ startMs: 5_000, endMs: 5_000, cellCount: 1 }, 5_000))
      .toEqual({ index: 0, frac: 0, progress: 0, phase: "singing" });
    expect(lyricCursorAt({ startMs: 5_000, endMs: 5_000, cellCount: 1 }, 5_001))
      .toEqual({ index: 0, frac: 1, progress: 1, phase: "held" });
    // An inverted line (end before start) still answers the two questions a
    // renderer asks — has it begun, is it finished — in that order.
    expect(lyricCursorAt({ startMs: 5_000, endMs: 4_000, cellCount: 3 }, 4_500).phase)
      .toBe("pending");
    expect(lyricCursorAt({ startMs: 5_000, endMs: 4_000, cellCount: 3 }, 5_500).phase)
      .toBe("held");
    // A negative count cannot index anything.
    expect(lyricCursorAt({ startMs: 0, endMs: 100, cellCount: -3 }, 50).index).toBe(-1);
  });

  test("keeps the display window separate from the singing", () => {
    // The one number the cascade choreography may use. Keyed on the sung
    // progress its exit ramp would fly the line off the panel the instant the
    // voice stopped and leave the screen blank for the whole instrumental.
    const window = { startMs: 110_330, endMs: 115_620, untilMs: 128_880 };
    expect(lyricWindowProgress(window, 115_620)).toBeCloseTo(0.285, 3);
    expect(at(115_620).progress).toBe(1);
    expect(lyricWindowProgress(window, 128_880)).toBe(1);
    // Without a window it degrades to the sung span, which is what a report
    // from a console that predates the field looks like.
    expect(lyricWindowProgress({ startMs: 0, endMs: 1_000 }, 500)).toBe(0.5);
    expect(lyricWindowProgress({ startMs: 0, endMs: 0 }, 500)).toBe(0);
  });
});

describe("the wire table", () => {
  test("round-trips as offsets and widths relative to the line's start", () => {
    const cells = cellsOf(GUYONGZHE);
    const encoded = encodeLyricCells(cells, 110_330);
    expect(encoded.startsWith("0,350,350,250,")).toBe(true);
    // One field, comma separated: StateDoc::splitTabs stops after three tabs.
    expect(encoded).not.toContain("\t");
    expect(encoded.split(",")).toHaveLength(22);

    const decoded = decodeLyricCells(encoded, 110_330);
    expect(decoded.map((cell) => [cell.startMs, cell.endMs]))
      .toEqual(cells.map((cell) => [cell.startMs, cell.endMs]));
  });

  test("rejects a malformed table instead of half-decoding it", () => {
    expect(decodeLyricCells("", 0)).toEqual([]);
    expect(decodeLyricCells("0,350,350", 0)).toEqual([]);
    expect(decodeLyricCells("0,350,nope,250", 0)).toEqual([]);
  });

  test("never emits a negative offset or width", () => {
    // Absolute times from a foreign timeline can land before the line's start.
    const encoded = encodeLyricCells(
      [{ startMs: 900, endMs: 1_100, text: "a" }, { startMs: 1_100, endMs: 1_000, text: "b" }],
      1_000,
    );
    expect(encoded).toBe("0,100,100,0");
  });
});
