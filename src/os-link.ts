/**
 * The link between the service and the tc002-os firmware.
 *
 * Replacing the official app deletes its `POST /api/custom` receiver, which is
 * how every host->device write in this project used to work. The direction is
 * therefore inverted: the device pulls. That is not just a workaround — it
 * removes the service's need to know the device's address at all, which is the
 * same class of problem that made the notify webhook fail (a launchd service
 * cannot open a LAN socket on this host).
 *
 * The wire format is line-oriented `KEY\tVALUE`, not JSON. The firmware parses
 * it with a split loop and no allocator pressure; a JSON parser would be another
 * dependency on a device with ~1 MB free, for a document with a dozen fields.
 */

import { encodeLyricCells, lyricCells } from "./music/lyric-timing.ts";
import type { MusicLyricWord } from "./music/core.ts";

export interface OsMenuEntry {
  /** Stable id the firmware echoes back when the user activates it. */
  id: string;
  /** UTF-8 label as shown on the panel. */
  label: string;
  kind: "channel" | "music" | "game" | "settings";
  /**
   * Fingerprint of the frames behind this entry, when it has any.
   *
   * The device fetches a channel's pixels once and holds them, and until this
   * existed the document could not say that the pixels changed: an options edit
   * moves neither the id nor the label, so the menu compared equal, the
   * sequence never bumped, and the only way to see a new 灯牌 colour was to turn
   * the knob to another channel and back. The revision is what an edit actually
   * changes on the wire.
   */
  rev?: string;
  /**
   * How long this entry's frames stay true, in milliseconds.
   *
   * A time-driven face — 大字天气钟, 取景框钟 — renders ten seconds of frames of a
   * clock, and a device that loops them forever is showing a minute that has
   * already passed. The service is the only side that knows how long a channel's
   * render is good for, so it says so rather than making the firmware guess.
   */
  ttlMs?: number;
}

export interface OsDisplayCommand {
  /** Menu entry the firmware should be showing, or null to leave it alone. */
  focus: string | null;
  /** True while the console is driving the panel and the ring is locked. */
  pinned: boolean;
}

export interface OsMirrorFrame {
  /** Base64 of 52*16*3 raw RGB bytes, exactly as the panel received them. */
  rgbBase64: string;
  receivedAt: number;
}

/**
 * A press the console made on the device's behalf.
 *
 * The device has a knob and three buttons and no other way in. Reproducing them
 * remotely is what turns the console from a viewer into a control surface —
 * every screen the firmware has is reachable by the knob, so a console that can
 * turn the knob needs no per-screen remote API.
 */
export type OsInputAction = "cw" | "ccw" | "press" | "hold" | "left" | "right";

export interface OsInputEvent {
  seq: number;
  action: OsInputAction;
}

export const OS_INPUT_ACTIONS: readonly OsInputAction[] = [
  "cw", "ccw", "press", "hold", "left", "right",
];

export interface OsDeviceSettings {
  /** 0..6, the device's own notch scale. */
  volume: number | null;
  /** 1..10. */
  brightness: number | null;
}

/**
 * The console's 主题设置, carried to whichever firmware is on the device.
 *
 * These are the same two enums and the same accent the sideloaded lyrics player
 * already reads from /api/music/device/state — deliberately not a second set.
 * ZOS's music screen is a port of that firmware's renderer (ADR 0007), and the
 * console offers exactly one theme panel for both, so a second store would only
 * be a copy somebody has to keep equal by hand: pick 磁带橙 under ZOS, sideload
 * the player for local audio, and get 信号绿 back.
 *
 * ORDER IS LOAD-BEARING. The index into these arrays is the integer that
 * crosses the link — ticker=0, skyline=1, spotlight=2, cascade=3 and
 * signal=0, tape=1, blueprint=2, arcade=3 — matching LYRIC_MODES / LYRIC_SKINS
 * in src/control-api.ts, MusicScreen::Mode / Skin, and the sideloaded player's
 * own visual/Palette.h. Renumbering any one of them repaints the panel in a
 * colour the console is not showing, silently and with nothing to fail.
 */
export type OsLyricMode = "ticker" | "skyline" | "spotlight" | "cascade";
export type OsLyricSkin = "signal" | "tape" | "blueprint" | "arcade";

export const OS_LYRIC_MODES: readonly OsLyricMode[] = [
  "ticker", "skyline", "spotlight", "cascade",
];
export const OS_LYRIC_SKINS: readonly OsLyricSkin[] = [
  "signal", "tape", "blueprint", "arcade",
];

export interface OsLyricTheme {
  mode: OsLyricMode;
  skin: OsLyricSkin;
  /** "rrggbb" replacing the skin's primary tier only, or null for the skin's own. */
  accent: string | null;
}

export interface OsNowPlaying {
  track: string;
  artist: string;
  playing: boolean;
  /** Playhead as of `stampedAt`; the firmware extrapolates from there. */
  positionMs: number;
  durationMs: number;
  /** The lyric line covering `positionMs`, or "" when there are no lyrics. */
  lyric: string;
  /**
   * The current lyric line's window in track time.
   *
   * Every display mode's geometry, colouring and beat is a function of progress
   * WITHIN the line, not of the track — the sung column, the cascade band, the
   * skyline's kick. `positionMs`/`durationMs` describe the song and one resolved
   * lyric string has neither a start nor an end, so without this window the
   * device has nothing to animate against.
   *
   * `lyricEndMs <= lyricStartMs` means "this line has no timing": a caller that
   * cannot answer passes zeroes and the panel falls back to a single sweep,
   * rather than the service inventing a window it does not know.
   */
  lyricStartMs: number;
  /**
   * When the line stopped being SUNG — the number this whole change exists to
   * produce, as opposed to the next line's start it used to be.
   *
   * It reaches the panel as `lyricend` only for a firmware that has said it
   * understands the split (OS_PROTO_LYRIC_WINDOW); an older build is still sent
   * the display window under that key, because that is what its cascade
   * choreography is built on.
   */
  lyricEndMs: number;
  /**
   * When the NEXT line takes over — the line's display window, as opposed to
   * its singing.
   *
   * Only the cascade mode's entrance/exit choreography may use it. With
   * `lyricEndMs` now pinning at the moment the voice stops, keying the exit ramp
   * on it would fly the line off the panel at the start of a 13 s instrumental
   * and leave the screen blank until the next line. Equal to `lyricEndMs` when
   * the two coincide, in which case it is left off the wire.
   */
  lyricUntilMs: number;
  /**
   * Per-word timings for this line, when the source really has them. Absent
   * means line-level timing only and the panel sweeps as it always did.
   */
  lyricWords?: MusicLyricWord[];
}

/**
 * Who reported a now-playing.
 *
 * Two writers exist because the two providers put the audio in different
 * places. Spotify plays on a Connect device, so the service polls it and is the
 * only one who can see it (`remote`). NetEase is `device-audio`: the browser
 * IS the player, and nothing but that browser knows what came out of the
 * speakers (`console`). Neither can answer for the other, so both write.
 */
export type OsNowPlayingSource = "remote" | "console";

/**
 * How long a report keeps the panel after its source stops talking.
 *
 * Both writers refresh well inside this — the Connect poll every 2 s, the
 * console every 4 s — so it only ever fires on a source that actually went
 * away: a browser tab killed without firing `pagehide`, a laptop lid closed
 * mid-song. Holding the last lyric on the clock forever after that would be a
 * lie the user cannot correct without restarting the service.
 */
const NOW_PLAYING_STALE_MS = 15_000;

export interface OsTelemetry {
  screen: string;
  focus: string;
  wifi: string;
  ip: string;
  uptimeMs: number;
  freeKb: number;
  supplicantRestarts: number;
  /** 0..100, or -1 before the device has a reading. */
  batteryPercent: number;
  charging: boolean;
  /**
   * Which revision of the state document this firmware understands. Absent or 0
   * means the build predates the sung/display split — see OS_PROTO_LYRIC_WINDOW.
   */
  proto: number;
  /**
   * True when ZOS is running from flash rather than from a sideload.
   *
   * Only the device can answer this, and the console needs it to say what a
   * power cycle brings back. On a sideload the answer is the stock firmware; on
   * a flashed unit it is ZOS, and telling a user the former when the latter is
   * true is the failure that matters — they power-cycle expecting their clock
   * back and get the thing they were trying to leave.
   */
  flashed: boolean;
  receivedAt: number;
}

/**
 * The document revision that understands `lyricend` meaning the SUNG end.
 *
 * ZOS is flashed, not sideloaded, so a device in the field keeps running its
 * build across service restarts and there is no moment where the two are
 * guaranteed to move together. That makes the meaning of `lyricend` a
 * compatibility problem rather than a naming one: `MusicScreen::lineProgress()`
 * feeds it straight into `cascadeBandY`, whose exit ramp reaches y = -16 at
 * progress 1. Tightening the key under an un-upgraded firmware would fly the
 * line off the panel the instant the singer stops and leave 升降 blank for the
 * whole instrumental — on 孤勇者, 13.3 seconds of black screen.
 *
 * So the device says what it can read, and `serialize()` writes the encoding it
 * asked for. A build that has never sent `proto` gets exactly the document it
 * got before this change; nothing regresses, and no deploy order is load-bearing.
 * Delete the legacy branch once no device can still be running such a build.
 */
export const OS_PROTO_LYRIC_WINDOW = 2;

const MAX_LABEL_CELLS = 24;
const MAX_ENTRIES = 32;
// A second is the floor because the device re-fetches a whole frame bundle when
// a ttl expires; anything shorter turns a clock face into a download loop on a
// single-core device with a 15 ms panel. A day is the ceiling because a larger
// number would not survive the firmware's atoi into an int32 as milliseconds.
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 86_400_000;

function sanitizeField(value: string): string {
  // Tabs and newlines are the record separators, so they can never appear in a
  // value. Channel names are user-authored and arrive from workspace.json.
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

/** Hex-ish token or nothing; the device compares it, so shape beats meaning. */
function normalizeRev(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return token === "" ? undefined : token;
}

function normalizeTtl(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.round(value)));
}

function clampLabel(value: string): string {
  const cells = Array.from(value);
  if (cells.length <= MAX_LABEL_CELLS) return value;
  // The firmware marquees anything too wide, so this cap only exists to stop a
  // pathological name from bloating every poll response.
  return cells.slice(0, MAX_LABEL_CELLS).join("");
}

interface Waiter {
  resolve: (body: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** What the hub keeps: the report plus the wire form of its cell table. */
type StoredNowPlaying = OsNowPlaying & { lyricCells: string };

/**
 * The `lyricw` payload for a label that has already been sanitized and clamped.
 *
 * The table's index IS the glyph index on the panel, so it has to be built
 * against the same string the panel will lay out. Cells are derived from the
 * FULL line (that is the only text the word timings reconstruct) and then
 * truncated exactly as clampLabel truncated the label, which keeps the two in
 * step by construction rather than by a comparison somebody has to remember.
 * A line whose words do not rebuild its text yields no table at all — the
 * panel falls back to the line-level sweep rather than lighting wrong glyphs.
 */
function encodeLabelCells(
  fullText: string,
  label: string,
  line: { startMs: number; endMs: number; words?: readonly MusicLyricWord[] | undefined },
): string {
  if (!line.words || line.words.length === 0) return "";
  if (line.endMs <= line.startMs) return "";
  const cells = lyricCells({ startMs: line.startMs, endMs: line.endMs, text: fullText, words: line.words });
  if (cells.length === 0) return "";
  const kept = cells.slice(0, [...label].length);
  if (kept.length === 0) return "";
  return encodeLyricCells(kept, line.startMs);
}

export class OsLinkHub {
  private seq = 1;
  private menu: OsMenuEntry[] = [];
  private display: OsDisplayCommand = { focus: null, pinned: false };
  private telemetry: OsTelemetry | null = null;
  private mirror: OsMirrorFrame | null = null;
  private mirrorRequestedAt = 0;
  // Sticky, because the fact outlives the report. Sideloading music or arcade
  // over a flashed ZOS takes ZOS off the air, so telemetry stops and the console
  // would fall back to promising the stock firmware — the dangerous direction,
  // at exactly the moment the user is reading a restore guide.
  private zosEverFlashed = false;
  // Not sticky, unlike zosEverFlashed: this describes the build that is on the
  // device right now, and a downgrade has to be able to take the tighter
  // encoding away again.
  private deviceProto = 0;
  private settings: OsDeviceSettings = { volume: null, brightness: null };
  // Defaults identical to sDeviceState's in src/control-api.ts, so the two
  // agree before the first write rather than only after one.
  private theme: OsLyricTheme = { mode: "spotlight", skin: "signal", accent: null };
  // Every console write bumps this. The device applies a setting only when the
  // sequence is HIGHER than the last one it applied, which is what lets the
  // knob win afterwards: the document still carries the console's old value,
  // and without the sequence the device would snap back to it on the next poll
  // and the user could never turn the volume up by hand again.
  private settingsSeq = 0;
  // A short tail rather than a queue the device drains. The document is pulled,
  // not pushed, so anything the device has not read yet has to still be in it —
  // but a press the device missed by more than a few hundred milliseconds is a
  // press the user has already given up on, and replaying it later would be
  // worse than dropping it.
  private inputs: OsInputEvent[] = [];
  private inputSeq = 0;
  private nowPlaying: StoredNowPlaying | null = null;
  private nowPlayingStampedAt = 0;
  private nowPlayingSource: OsNowPlayingSource | null = null;
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  currentSeq(): number {
    return this.seq;
  }

  setMenu(entries: OsMenuEntry[]): void {
    const next = entries.slice(0, MAX_ENTRIES).map((entry) => {
      const rev = normalizeRev(entry.rev);
      const ttlMs = normalizeTtl(entry.ttlMs);
      return {
        id: sanitizeField(entry.id),
        label: clampLabel(sanitizeField(entry.label)),
        kind: entry.kind,
        ...(rev === undefined ? {} : { rev }),
        ...(ttlMs === undefined ? {} : { ttlMs }),
      };
    });
    if (this.serializeMenu(next) === this.serializeMenu(this.menu)) return;
    this.menu = next;
    this.bump();
  }

  setDisplay(command: OsDisplayCommand): void {
    const focus = command.focus === null ? null : sanitizeField(command.focus);
    if (focus === this.display.focus && command.pinned === this.display.pinned) return;
    this.display = { focus, pinned: command.pinned };
    this.bump();
  }

  getDisplay(): OsDisplayCommand {
    return { ...this.display };
  }

  getMenu(): OsMenuEntry[] {
    return this.menu.map((entry) => ({ ...entry }));
  }

  /**
   * What is playing, resolved to text the panel can actually show.
   *
   * The device-facing music endpoint carries a track *id*, which is useless on
   * a 52x16 panel — the title only exists after the provider's trackDetail call,
   * which needs credentials the firmware does not have. Resolving it here is
   * also what lets the same lookup feed the lyric line.
   *
   * The playhead deliberately does NOT bump the sequence. It moves a thousand
   * times a second and every bump releases every parked long poll; the firmware
   * gets a position plus the moment it was true and advances it locally, which
   * is both cheaper and smoother than any poll rate could be.
   *
   * ARBITRATION, because there are two writers (see OsNowPlayingSource):
   * whoever last wrote owns the field, and another source may only take it by
   * actually playing something. Silence never evicts sound. Concretely, the
   * Connect poll runs every 2 s and reports "nothing is playing" whenever
   * Spotify is signed in but idle — which is the normal state while the user
   * listens on NetEase through the browser — so without this rule it would
   * blank the console's track twice a second and the panel would never settle.
   * Staleness is the only other way to lose the field, so a source that dies
   * mid-song cannot hold it hostage.
   *
   * Two sources both claiming to play (two tabs, or Spotify left running) is
   * genuinely ambiguous; the incumbent keeps it, because the alternative is the
   * panel flapping between two songs every two seconds.
   */
  setNowPlaying(now: OsNowPlaying | null, source: OsNowPlayingSource = "remote"): void {
    if (!this.mayWriteNowPlaying(now, source)) return;
    const next = now === null ? null : ((): StoredNowPlaying => {
      const lyric = clampLabel(sanitizeField(now.lyric));
      const lyricStartMs = Math.max(0, Math.round(now.lyricStartMs));
      const lyricEndMs = Math.max(0, Math.round(now.lyricEndMs));
      return {
        track: clampLabel(sanitizeField(now.track)),
        artist: clampLabel(sanitizeField(now.artist)),
        playing: now.playing,
        positionMs: Math.max(0, Math.round(now.positionMs)),
        durationMs: Math.max(0, Math.round(now.durationMs)),
        lyric,
        lyricStartMs,
        lyricEndMs,
        lyricUntilMs: Math.max(0, Math.round(now.lyricUntilMs)),
        lyricCells: encodeLabelCells(
          sanitizeField(now.lyric),
          lyric,
          { startMs: lyricStartMs, endMs: lyricEndMs, words: now.lyricWords },
        ),
      };
    })();
    const before = this.nowPlaying;
    const textChanged = (before === null) !== (next === null) ||
      (before !== null && next !== null && (
        before.track !== next.track ||
        before.artist !== next.artist ||
        before.playing !== next.playing ||
        before.lyric !== next.lyric ||
        // The window, not only the words. A chorus that repeats a line verbatim
        // leaves `lyric` identical, so without this no bump fires, the device
        // never sees the new document, and it keeps animating the previous
        // line's window with progress pinned at 1 — the line sits there fully
        // sung while the song moves on.
        before.lyricStartMs !== next.lyricStartMs ||
        before.lyricUntilMs !== next.lyricUntilMs ||
        // The cell table can arrive AFTER the line it belongs to: the console
        // reports on a 4 s timer and a track switch can land a wordless report
        // first. Without this the refinement never reaches the device and the
        // panel keeps sweeping a line it could have been walking word by word.
        before.lyricCells !== next.lyricCells
      ));
    this.nowPlaying = next;
    this.nowPlayingStampedAt = this.now();
    this.nowPlayingSource = next === null ? null : source;
    if (textChanged) this.bump();
  }

  private mayWriteNowPlaying(next: OsNowPlaying | null, source: OsNowPlayingSource): boolean {
    const owner = this.nowPlayingSource;
    if (owner === null || owner === source) return true;
    if (this.now() - this.nowPlayingStampedAt >= NOW_PLAYING_STALE_MS) return true;
    // A different source, still fresh: only actual playback takes the panel.
    return next !== null && next.playing && this.nowPlaying?.playing !== true;
  }

  getNowPlaying(): StoredNowPlaying | null {
    return this.nowPlaying === null ? null : { ...this.nowPlaying };
  }

  /** Which writer currently owns the panel, or null when nothing is playing. */
  nowPlayingOwner(): OsNowPlayingSource | null {
    return this.nowPlayingSource;
  }

  /** True once a flashed ZOS has ever reported. Never unset by a later absence. */
  zosFlashed(): boolean {
    return this.zosEverFlashed;
  }

  /**
   * Asks the device to adopt a volume and/or brightness.
   *
   * A request, not a mirror of device state: the device is the authority on
   * what it is currently set to and reports that in telemetry. Passing null
   * leaves a setting alone rather than clearing it.
   */
  setDeviceSettings(next: Partial<OsDeviceSettings>): void {
    const clamp = (value: number, low: number, high: number) =>
      Math.max(low, Math.min(high, Math.round(value)));
    let changed = false;
    if (typeof next.volume === "number" && Number.isFinite(next.volume)) {
      this.settings.volume = clamp(next.volume, 0, 6);
      changed = true;
    }
    if (typeof next.brightness === "number" && Number.isFinite(next.brightness)) {
      this.settings.brightness = clamp(next.brightness, 1, 10);
      changed = true;
    }
    if (!changed) return;
    this.settingsSeq += 1;
    this.bump();
  }

  /** Queues a button or knob event for the device to inject. */
  pressInput(action: OsInputAction): OsInputEvent {
    this.inputSeq += 1;
    const event: OsInputEvent = { seq: this.inputSeq, action };
    this.inputs.push(event);
    // Eight is two full turns of the knob plus a press — more than anyone
    // produces between two polls of an endpoint that answers in milliseconds.
    if (this.inputs.length > 8) this.inputs.splice(0, this.inputs.length - 8);
    this.bump();
    return event;
  }

  pendingInputs(): OsInputEvent[] {
    return this.inputs.map((event) => ({ ...event }));
  }

  getDeviceSettings(): OsDeviceSettings & { seq: number } {
    return { ...this.settings, seq: this.settingsSeq };
  }

  /**
   * Adopts the console's 主题设置.
   *
   * NO SEQUENCE, unlike setDeviceSettings, and that is a decision rather than an
   * omission. `setseq` exists because volume has a second writer — the knob —
   * so a console value sitting in every document would be re-applied on each
   * poll and the user could never turn it up by hand. The theme has exactly one
   * writer: ZOS's music screen spends its knob on prev/next, its press on
   * play/pause, and refuses the side buttons so volume keeps working (see
   * ui/MusicScreen.h), so there is no local control to fight. Applying it
   * unconditionally on every document is therefore idempotent, and it is also
   * what makes a cold-booted device correct on its first poll. If a local theme
   * cycle is ever added it must arrive WITH a `themeseq` and rising-edge gating,
   * or the console's stale value will snap back on the very next document.
   *
   * Validated here as well as in applyControlPatch — same defence in depth as
   * sanitizeField and the clamp in setDeviceSettings. An unrecognised mode or
   * skin is ignored rather than thrown: this is a hub, not a request handler,
   * and dropping one bad field is better than failing a whole update.
   */
  setLyricTheme(next: Partial<OsLyricTheme>): void {
    let changed = false;
    if (typeof next.mode === "string" && OS_LYRIC_MODES.includes(next.mode)) {
      if (this.theme.mode !== next.mode) changed = true;
      this.theme.mode = next.mode;
    }
    if (typeof next.skin === "string" && OS_LYRIC_SKINS.includes(next.skin)) {
      if (this.theme.skin !== next.skin) changed = true;
      this.theme.skin = next.skin;
    }
    if ("accent" in next) {
      let accent: string | null | undefined;
      if (next.accent === null) accent = null;
      else if (typeof next.accent === "string" && /^[0-9a-fA-F]{6}$/.test(next.accent)) {
        accent = next.accent.toLowerCase();
      }
      if (accent !== undefined) {
        if (this.theme.accent !== accent) changed = true;
        this.theme.accent = accent;
      }
    }
    // No-op writes must not bump: the console primes this on every handler
    // construction and re-sends it after each poll echo, and waking every parked
    // long poll for a value that did not move is a broadcast storm on a LAN.
    if (changed) this.bump();
  }

  getLyricTheme(): OsLyricTheme {
    return { ...this.theme };
  }

  report(telemetry: Omit<OsTelemetry, "receivedAt">): void {
    if (telemetry.flashed) this.zosEverFlashed = true;
    const proto = Number.isFinite(telemetry.proto) ? Math.max(0, Math.floor(telemetry.proto)) : 0;
    // Telemetry never bumps the sequence: it flows device->console, and waking
    // every long poll on it would turn a status heartbeat into a broadcast storm.
    // The one exception is the document's own encoding changing, which happens
    // once per device boot and has to reach the parked poll the device is
    // sitting in — otherwise a freshly flashed unit reads the legacy encoding
    // until the next lyric line happens to move.
    const changed = proto !== this.deviceProto;
    this.deviceProto = proto;
    this.telemetry = { ...telemetry, proto, receivedAt: this.now() };
    if (changed) this.bump();
  }

  /** The document revision the device last said it understands; 0 before any report. */
  deviceProtocol(): number {
    return this.deviceProto;
  }

  getTelemetry(): OsTelemetry | null {
    return this.telemetry === null ? null : { ...this.telemetry };
  }

  /**
   * The last frame the device actually put on the panel.
   *
   * This is a real capture, not a re-render: the LED bus is write-only and
   * /dev/fb0 is unrelated to the matrix, so the only way to know what the panel
   * shows is for the compositor to tee it on the way out. A TypeScript
   * re-implementation of the firmware's UI would be free to drift from the C++
   * without any test noticing — the repo already has that cautionary tale in
   * seven C++ game engines beside four TypeScript ones.
   */
  putMirrorFrame(rgbBase64: string): void {
    this.mirror = { rgbBase64, receivedAt: this.now() };
  }

  getMirrorFrame(): OsMirrorFrame | null {
    return this.mirror === null ? null : { ...this.mirror };
  }

  /** True while the console has asked for frames; the device stops when nobody looks. */
  mirrorWanted(): boolean {
    return this.now() - this.mirrorRequestedAt < 10_000;
  }

  requestMirror(): void {
    const wasWanted = this.mirrorWanted();
    this.mirrorRequestedAt = this.now();
    // The device only learns to start streaming through the state document, so
    // the first request has to wake the parked poll. Refreshes of an already
    // active request must not, or opening the console would bump the sequence
    // every few seconds for nothing.
    if (!wasWanted) this.bump();
  }

  /** True when a report arrived recently enough to believe. */
  isDeviceLive(withinMs = 15_000): boolean {
    if (this.telemetry === null) return false;
    return this.now() - this.telemetry.receivedAt < withinMs;
  }

  /**
   * The change signature, not the wire format — this string is never sent.
   *
   * The revision and ttl are part of it on purpose: this comparison is the only
   * thing standing between a saved edit and a parked long poll, and keyed on
   * kind/id/label alone it answered "nothing changed" to every content edit the
   * user has ever made.
   */
  private serializeMenu(entries: OsMenuEntry[]): string {
    return entries
      .map((e) => `${e.kind}\t${e.id}\t${e.label}\t${e.rev ?? ""}\t${e.ttlMs ?? ""}`)
      .join("\n");
  }

  serialize(): string {
    const lines: string[] = [];
    lines.push(`seq\t${this.seq}`);
    lines.push(`pinned\t${this.display.pinned ? 1 : 0}`);
    // The device only streams while someone is watching: 2496 bytes a frame is
    // cheap on a LAN but not free on a device with one core and a 15 ms panel.
    lines.push(`mirror\t${this.mirrorWanted() ? 1 : 0}`);
    if (this.display.focus !== null) lines.push(`focus\t${this.display.focus}`);
    // Emitted unconditionally, and deliberately OUTSIDE the `np` block: the
    // panel needs a skin for its three empty states (未配置 / 离线 / 未播放)
    // too, and a theme that lived under `if (np)` would drop back to the
    // defaults the moment playback stopped — the user would watch their colour
    // leave the screen when they pressed pause.
    lines.push(`mode\t${this.theme.mode}`);
    lines.push(`skin\t${this.theme.skin}`);
    if (this.theme.accent !== null) lines.push(`accent\t${this.theme.accent}`);
    if (this.settingsSeq > 0) {
      lines.push(`setseq\t${this.settingsSeq}`);
      if (this.settings.volume !== null) lines.push(`setvol\t${this.settings.volume}`);
      if (this.settings.brightness !== null) lines.push(`setbri\t${this.settings.brightness}`);
    }
    for (const event of this.inputs) {
      lines.push(`input\t${event.seq}\t${event.action}`);
    }
    const np = this.nowPlaying;
    if (np !== null) {
      lines.push(`np\t1`);
      lines.push(`track\t${np.track}`);
      lines.push(`artist\t${np.artist}`);
      lines.push(`playing\t${np.playing ? 1 : 0}`);
      // Advanced to now rather than sent as captured: a document that parked in
      // a long poll for eight seconds would otherwise hand the firmware a
      // playhead eight seconds stale the instant it arrived.
      const drift = np.playing ? Math.max(0, this.now() - this.nowPlayingStampedAt) : 0;
      const position = np.durationMs > 0
        ? Math.min(np.durationMs, np.positionMs + drift)
        : np.positionMs + drift;
      lines.push(`pos\t${Math.round(position)}`);
      lines.push(`dur\t${np.durationMs}`);
      if (np.lyric !== "") {
        lines.push(`lyric\t${np.lyric}`);
        // The line's own window, and only when it is real. A caller with no
        // timing sends zeroes; emitting `lyricat 0 / lyricend 0` for that would
        // hand the device a degenerate span it has to detect anyway, so the
        // absence carries the meaning instead — which is also what an older
        // service looks like to a newer firmware.
        if (np.lyricEndMs > np.lyricStartMs) {
          const windowEndMs = Math.max(np.lyricUntilMs, np.lyricEndMs);
          const understandsWindow = this.deviceProto >= OS_PROTO_LYRIC_WINDOW;
          lines.push(`lyricat\t${np.lyricStartMs}`);
          // Legacy builds read this as "when the next line takes over" and key
          // the cascade choreography on it, so they keep getting that number.
          // See OS_PROTO_LYRIC_WINDOW.
          lines.push(`lyricend\t${understandsWindow ? np.lyricEndMs : windowEndMs}`);
          if (understandsWindow) {
            // Only when the line really is held past its singing. Emitting it
            // unconditionally would put 18 bytes in every document to say what
            // `lyricend` already says.
            if (windowEndMs > np.lyricEndMs) lines.push(`lyricuntil\t${windowEndMs}`);
            // One field, comma separated: StateDoc::splitTabs stops after three
            // tabs, so a tab-separated table would arrive truncated. Withheld
            // from a legacy build not because it would misparse — unknown keys
            // are ignored — but because a per-glyph table is up to 207 bytes on
            // every document, for a renderer that cannot read it.
            if (np.lyricCells !== "") lines.push(`lyricw\t${np.lyricCells}`);
          }
        }
      }
    }
    lines.push(`menu\t${this.menu.length}`);
    for (const entry of this.menu) {
      lines.push(`item\t${entry.kind}\t${entry.id}\t${entry.label}`);
      // Annotations of the item that just went by, emitted as NEW KEYS rather
      // than as two more tab fields on `item`. This is load-bearing: the
      // deployed firmware matches `fields[0] == "item" && n == 4` — a strict
      // arity check — so a fifth field would make it drop every menu entry and
      // lose the channel ring entirely until it is reflashed. Its parser
      // ignores keys it does not know, on purpose, which is what lets these
      // ship to a device that has never heard of them.
      //
      // Each record repeats the id even though it directly follows its item, so
      // a firmware that indexes rather than appends is not forced to rely on
      // ordering it never agreed to.
      if (entry.rev !== undefined) lines.push(`rev\t${entry.id}\t${entry.rev}`);
      if (entry.ttlMs !== undefined) lines.push(`ttl\t${entry.id}\t${entry.ttlMs}`);
    }
    // A trailing newline lets the firmware treat every record identically
    // instead of special-casing the last one.
    return `${lines.join("\n")}\n`;
  }

  private bump(): void {
    this.seq += 1;
    const body = this.serialize();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(body);
    }
    this.waiters.clear();
  }

  /**
   * Long poll. Resolves immediately when the caller is behind, otherwise parks
   * until something changes or `holdMs` elapses — and then still answers with
   * the current document rather than a 204, so the firmware's parser has exactly
   * one shape to handle and a poll loop that never branches on status.
   */
  waitForChange(sinceSeq: number, holdMs: number): Promise<string> {
    if (!Number.isFinite(sinceSeq) || sinceSeq < this.seq) {
      return Promise.resolve(this.serialize());
    }
    return new Promise<string>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(this.serialize());
        }, holdMs),
      };
      this.waiters.add(waiter);
    });
  }

  /** Releases every parked poll; used when the service shuts down. */
  drain(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.serialize());
    }
    this.waiters.clear();
  }

  pendingWaiters(): number {
    return this.waiters.size;
  }
}
