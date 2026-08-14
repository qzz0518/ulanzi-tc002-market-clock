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

/**
 * One agent's row on the panel's VIBE app.
 *
 * Percentages are already resolved here: the firmware draws, it does not do
 * unit arithmetic. A metric the vendor sends in dollars or requests arrives as
 * `limit: 0` and is shown as a bare number, because a meter without a ceiling
 * would imply one we invented.
 */
export interface OsVibeMetric {
  /** The vendor's own row label — "Session", "Weekly", "Credits". */
  label: string;
  used: number;
  /** 0 when the vendor gave no ceiling; the panel then skips the meter. */
  limit: number;
  /** Seconds until this window resets, or -1 when the vendor sends none. */
  resetSec: number;
}

export interface OsVibeAgent {
  /** Catalog id — also the key into the firmware's mark table. */
  id: string;
  label: string;
  plan: string;
  /** True while this vendor's last good numbers are standing in for a failure. */
  stale: boolean;
  /** The starred metrics, in order; at most two reach the panel. */
  metrics: OsVibeMetric[];
}

export interface OsMenuEntry {
  /** Stable id the firmware echoes back when the user activates it. */
  id: string;
  /** UTF-8 label as shown on the panel. */
  label: string;
  kind: "channel" | "music" | "game" | "settings" | "vibe";
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
 * 夜间息屏 — a night window, an idle timeout inside it, and a dark panel.
 *
 * A REQUEST, like OsDeviceSettings: the device's own 设置 screen is a second
 * writer and the telemetry block is what it actually ended up at. A console
 * that rendered this as the truth would show the wrong window for as long as
 * somebody had used the knob.
 */
export interface OsSleepConfig {
  enabled: boolean;
  /** Minutes since local midnight, 0..1439. */
  startMin: number;
  /**
   * Minutes since local midnight, EXCLUSIVE. Crossing midnight (23:00→07:00) is
   * the ordinary case; `endMin === startMin` means the whole day, which is the
   * only way to try the feature without waiting for night.
   */
  endMin: number;
  /** Seconds of no operation before the panel fades out. 30..7200. */
  idleSec: number;
}

/**
 * The same four fields, each `null` until the console has actually written it.
 *
 * NULL IS NOT A DEFAULT DRESSED UP. `serialize()` emits only the fields that are
 * not null, which is the entire reason this type exists: with concrete defaults
 * in the store, a console that PUT `{idleSec:600}` alone also shipped
 * `sleepon 0 / sleepfrom 1380 / sleeptill 420`, and the firmware — whose
 * per-field optionality is keyed on the LINE being absent, not on a sentinel —
 * dutifully adopted all four and wrote them to /data. Adjusting the timeout
 * turned the feature off and threw away the window. Exactly the treatment
 * OsDeviceSettings already gets, and for exactly the same reason: a volume-only
 * PUT must not carry a brightness the console never named.
 */
export interface OsSleepRequest {
  enabled: boolean | null;
  startMin: number | null;
  endMin: number | null;
  idleSec: number | null;
}

/** A sleep request together with the sequence the console made it at. */
export type OsSleepRequestSnapshot = OsSleepRequest & { seq: number };

/**
 * Where the sleep request is kept so it outlives the process.
 *
 * An interface rather than the concrete store, so the hub stays free of node:fs
 * and every existing test can keep constructing it with no arguments. The one
 * implementation is OsSleepRequestStore; see its header for why the sequence
 * cannot live in module memory alone.
 */
export interface OsSleepRequestSink {
  save(request: OsSleepRequestSnapshot): void;
}

// Bounds shared by the route and the hub. Below 30 s the panel blanks while the
// user is looking at it; above two hours the window is doing all the work.
export const OS_SLEEP_MIN_IDLE_SEC = 30;
export const OS_SLEEP_MAX_IDLE_SEC = 7200;
export const OS_SLEEP_MAX_MINUTE = 1439;

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
  /**
   * The request id the device has recorded on `/data` as installed.
   *
   * ABSENT on firmware that predates it, and that distinction is load-bearing:
   * 0 means "this device has installed nothing", which is a fact the hub acts
   * on, while undefined means "this device cannot tell me" and the hub falls
   * back to watching for a reboot.
   */
  upgradeSeqInstalled?: number;
  /**
   * 夜间休眠 as the DEVICE has it, plus whether the panel is dark right now.
   *
   * ABSENT means the firmware predates the feature — this is the capability
   * signal, deliberately not a `proto` bump: this build never sends `proto` at
   * all, and raising it would simultaneously claim the lyric-window support the
   * firmware does not have and change how lyrics are encoded.
   *
   * `asleep` is the whole answer to "a black panel is ambiguous". The console
   * must never infer sleep from the pixels — black is indistinguishable from a
   * working dark panel, which is the rule describeMirror already encodes for
   * the offline case — so the device says so instead.
   *
   * `clockSynced` exists so the console can explain a panel that is not
   * sleeping although sleep is on, rather than leaving it looking like a bug.
   */
  sleep?: {
    on: boolean;
    startMin: number;
    endMin: number;
    idleSec: number;
    asleep: boolean;
    clockSynced: boolean;
  };
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
/** Ten vendors exist; the ring would be unusable long before that many sign in. */
const MAX_VIBE_AGENTS = 10;
/** Two starred metrics per vendor is the panel's own budget (two 3x5 rows). */
const MAX_VIBE_METRICS = 2;
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

/** Whole percent, floored into what three digit cells can show. */
function clampVibeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(999, Math.round(value)));
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

// Shared by setSleep() and restoreSleepRequest(), because a value that came back
// off disk deserves the same treatment as one that came off the wire. Clamped
// rather than rejected: this is a hub, not a request handler — the route rejects
// out-of-range values first, and the firmware clamps again because it does not
// trust the wire either.
function clampSleepMinute(value: number): number {
  return Math.max(0, Math.min(OS_SLEEP_MAX_MINUTE, Math.round(value)));
}

function clampSleepIdleSec(value: number): number {
  return Math.max(OS_SLEEP_MIN_IDLE_SEC, Math.min(OS_SLEEP_MAX_IDLE_SEC, Math.round(value)));
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
  private vibe: OsVibeAgent[] = [];
  private upgradeSeq = 0;
  // The highest id ever issued, kept THROUGH a withdrawal. `upgradeSeq` goes
  // back to 0 when a reboot consumes the request, and reusing an id from that
  // zero would hand the device a number its own /data record already carries —
  // which it correctly refuses as "already installed".
  private upgradeSeqIssued = 0;
  private display: OsDisplayCommand = { focus: null, pinned: false };
  private telemetry: OsTelemetry | null = null;
  // Counts reports, not changes: a caller asking "has the device spoken since I
  // did X" needs a number that moves on every heartbeat, including one that
  // carries byte-identical telemetry.
  private reportSeq = 0;
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
  // ...and one sequence per field, because the document carries the console's
  // last request for BOTH levels forever and a value cannot say which one the
  // user just moved. Without these the device could only see "volume 4,
  // brightness 7" and had to act on both, so every volume change also ran the
  // brightness path: a zero-sized brightness nudge, and a brightness bar drawn
  // over the volume bar. The panel showed the wrong control while changing the
  // right one.
  //
  // Kept as sequences rather than a "which field moved" flag so a device that
  // reads two console writes as ONE document still applies both — the flag
  // would have to describe a single write, and the poll is free to coalesce.
  private volumeSeq = 0;
  private brightnessSeq = 0;
  // 夜间息屏. All four start as null — "the console has never said" — rather
  // than as a copy of SleepConfig's defaults. Holding defaults here looked
  // harmless because they matched the firmware's, but serialize() emits what
  // this holds: a console that only moved the timeout also re-sent
  // `sleepon 0 / sleepfrom 1380 / sleeptill 420`, and since the firmware reads
  // an ABSENT LINE as "unchanged" rather than a sentinel, it adopted all four
  // and persisted them. The device is the only place the effective config
  // lives; the hub's job is to carry requests, not to hold a shadow copy that
  // can overwrite the knob.
  private sleep: OsSleepRequest = {
    enabled: null,
    startMin: null,
    endMin: null,
    idleSec: null,
  };
  // ONE sequence for the four fields, not one each. Volume and brightness need
  // per-field sequences because the panel has a single bar and had to name
  // which control the user moved; there is no such display here, and the four
  // fields are always written together by one console form. Nothing is emitted
  // at all until this rises above 0, so a firmware that has never heard of the
  // block sees exactly the document it always did.
  private sleepSeq = 0;
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

  constructor(
    private readonly now: () => number = () => Date.now(),
    // Optional so the hub keeps working as pure in-memory state in tests and in
    // any caller that has no disk. Wired in service.ts, where the counterpart
    // restoreSleepRequest() call also lives.
    private readonly sleepStore: OsSleepRequestSink | null = null,
  ) {}

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

  /**
   * Publishes the AI-usage rows the panel's VIBE app draws.
   *
   * Idempotent like setMenu, and for the same reason: this is republished on a
   * timer, and a payload that compares equal must not bump the sequence or
   * every parked long poll wakes for nothing every five minutes.
   */
  setVibe(agents: OsVibeAgent[]): void {
    const next = agents.slice(0, MAX_VIBE_AGENTS).map((agent) => ({
      id: sanitizeField(agent.id),
      label: clampLabel(sanitizeField(agent.label)),
      plan: clampLabel(sanitizeField(agent.plan)),
      stale: agent.stale,
      metrics: agent.metrics.slice(0, MAX_VIBE_METRICS).map((metric) => ({
        label: clampLabel(sanitizeField(metric.label)),
        // The panel has three digit cells; anything wider is the vendor's
        // problem, not something to draw off the edge of a 52 px screen.
        used: clampVibeNumber(metric.used),
        limit: clampVibeNumber(metric.limit),
        resetSec: Number.isFinite(metric.resetSec) ? Math.max(-1, Math.round(metric.resetSec)) : -1,
      })),
    }));
    if (this.serializeVibe(next) === this.serializeVibe(this.vibe)) return;
    this.vibe = next;
    this.bump();
  }

  getVibe(): OsVibeAgent[] {
    return this.vibe.map((agent) => ({ ...agent, metrics: agent.metrics.map((metric) => ({ ...metric })) }));
  }

  /**
   * Asks the panel to install whatever image is staged on it.
   *
   * A deliberate act with a human behind it, never a background poll: the
   * device's own updater tears every service down and reboots, and it does not
   * remove the image it flashed — so a device that checked on its own would
   * reinstall the same image on every boot and never finish drawing a screen.
   *
   * The id is seconds-since-epoch, not a count, and that is load-bearing rather
   * than cosmetic. The firmware records the id it installed on `/data` so a
   * reboot does not read the still-standing request as a new one; a counter
   * restarting at 1 whenever this process does would collide with an id the
   * device had already installed, and that device could never be asked again.
   * `Math.max` keeps it strictly increasing even for two presses in one second.
   */
  requestUpgrade(): number {
    this.upgradeSeq = Math.max(this.upgradeSeqIssued + 1, Math.floor(Date.now() / 1000));
    this.upgradeSeqIssued = this.upgradeSeq;
    this.bump();
    return this.upgradeSeq;
  }

  getUpgradeSeq(): number {
    return this.upgradeSeq;
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
   *
   * Naming a field is what stamps its sequence, deliberately including a write
   * that asks for the level the device already has. The stamp is "the user
   * moved this control", not "this value differs" — a slider dragged back to
   * where it started still deserves its bar on the panel, and the device has no
   * other way to know the console did anything at all.
   */
  setDeviceSettings(next: Partial<OsDeviceSettings>): void {
    const clamp = (value: number, low: number, high: number) =>
      Math.max(low, Math.min(high, Math.round(value)));
    const named = (value: number | null | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const volume = named(next.volume);
    const brightness = named(next.brightness);
    if (volume === null && brightness === null) return;
    this.settingsSeq += 1;
    if (volume !== null) {
      this.settings.volume = clamp(volume, 0, 6);
      this.volumeSeq = this.settingsSeq;
    }
    if (brightness !== null) {
      this.settings.brightness = clamp(brightness, 1, 10);
      this.brightnessSeq = this.settingsSeq;
    }
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
   * Asks the device to adopt a 夜间息屏 configuration.
   *
   * BUMPS ON EVERY WRITE, exactly like setDeviceSettings and unlike
   * setLyricTheme. There is no bar to justify here, but there IS a second
   * writer to overrule: the device's own 设置 rows. A console PUT of values the
   * hub already holds must still reach a device whose knob had set something
   * else, so "did the number change" is the wrong question — "did the user ask"
   * is the right one, and only the sequence can carry that.
   *
   * A field the caller does not name stays unnamed FOREVER, not just for this
   * write: it is never emitted, so the device keeps whatever its own rows hold.
   * Once named it stays named — the document has to keep repeating it, because
   * the device may coalesce several writes into one poll.
   *
   * Fields are optional so a console can flip the switch without also having to
   * restate a window it is not showing. Out-of-range values are clamped rather
   * than thrown: this is a hub, not a request handler — the route rejects them
   * first, and the firmware clamps again because it does not trust the wire.
   */
  setSleep(next: Partial<OsSleepConfig>): void {
    const named = (value: number | null | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const startMin = named(next.startMin);
    const endMin = named(next.endMin);
    const idleSec = named(next.idleSec);
    const enabled = typeof next.enabled === "boolean" ? next.enabled : null;
    if (enabled === null && startMin === null && endMin === null && idleSec === null) return;
    this.sleepSeq += 1;
    if (enabled !== null) this.sleep.enabled = enabled;
    if (startMin !== null) this.sleep.startMin = clampSleepMinute(startMin);
    if (endMin !== null) this.sleep.endMin = clampSleepMinute(endMin);
    if (idleSec !== null) this.sleep.idleSec = clampSleepIdleSec(idleSec);
    // Written down BEFORE the bump releases the parked polls, so the number the
    // device is about to be handed is already the number a restarted service
    // will resume from. The store swallows its own failures — a bedtime must not
    // be able to fail a request — and skips a write that would change nothing.
    this.sleepStore?.save(this.getSleep());
    this.bump();
  }

  /**
   * Resumes the console's last request, and the sequence it was made at, from
   * disk. Call once at startup, before the first document is served.
   *
   * RESUMED AT, NEVER BUMPED PAST. The saved sequence is the highest one this
   * service ever emitted, so the device has either already applied it — and
   * refuses it again, which is what keeps the knob's later change alive — or has
   * not polled since and is owed exactly that document. Starting one above it
   * would manufacture a rising edge nobody asked for: a device that stayed up
   * across the restart (the ordinary case, since restarting the service does not
   * touch the clock) would apply the console's months-old request over whatever
   * its own 设置 rows now hold, which is precisely what the rising-edge rule
   * exists to prevent.
   *
   * The fields come back with the sequence for the same reason setSleep() keeps
   * re-emitting them: the document is pulled, so a request the device has not
   * read yet must still be in it. Restoring both means the first document after
   * a restart is byte-identical to the last one before it, and a device that had
   * already applied it has nothing to do.
   *
   * Does NOT bump: nothing is listening yet, and a restart is not a change.
   * Validated again here, as a hub always validates its inputs — the file is
   * outside this process's control and may have been hand-edited.
   */
  restoreSleepRequest(saved: OsSleepRequestSnapshot | null): void {
    if (saved === null) return;
    const seq = Number.isFinite(saved.seq) ? Math.max(0, Math.floor(saved.seq)) : 0;
    // max() rather than assignment: a restore that somehow ran after a write
    // must not walk the counter backwards, which would hand the device a
    // sequence it has already refused.
    this.sleepSeq = Math.max(this.sleepSeq, seq);
    this.sleep = {
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : null,
      startMin: saved.startMin === null ? null : clampSleepMinute(saved.startMin),
      endMin: saved.endMin === null ? null : clampSleepMinute(saved.endMin),
      idleSec: saved.idleSec === null ? null : clampSleepIdleSec(saved.idleSec),
    };
  }

  getSleep(): OsSleepRequestSnapshot {
    return { ...this.sleep, seq: this.sleepSeq };
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
    // A CONSUMED REQUEST IS WITHDRAWN. Leaving one standing is what turns a
    // single install into a device that reinstalls on every boot forever, and
    // the console is the half that can see it: the panel's own memory is wiped
    // by the reboot the install ends in, but the process holding the request
    // is not.
    //
    // The device's own record is the evidence, when it can send one. The
    // fallback — an uptime that went backwards — is a GUESS, and it is wrong in
    // a case that really happens: if the last report before the reboot came
    // early in that boot, the first report after it carries a larger uptime and
    // the reboot is invisible. So it is used only for firmware too old to
    // answer the question directly.
    //
    // Withdrawn on failure too, and deliberately: retrying is the user pressing
    // the button again, which is one act. A device retrying an image that just
    // took it down is a device nobody can reach to stop.
    const previous = this.telemetry;
    const installed = telemetry.upgradeSeqInstalled;
    const consumed = typeof installed === "number"
      ? installed >= this.upgradeSeq
      : previous !== null && telemetry.uptimeMs < previous.uptimeMs;
    this.telemetry = { ...telemetry, proto, receivedAt: this.now() };
    this.reportSeq += 1;
    if (consumed && this.upgradeSeq > 0) {
      this.upgradeSeq = 0;
      this.bump();
      return;
    }
    if (changed) this.bump();
  }

  /**
   * How many reports have arrived, ever. Monotonic and never reset.
   *
   * `isDeviceLive()` alone cannot answer "did the clock come back", because the
   * clock that is being re-provisioned was usually online when the flow started
   * and its last report is still inside the liveness window. A caller that
   * remembers this number before it acts can require a report that arrived
   * after — which is a witness, where "live" is only a memory.
   */
  reportCount(): number {
    return this.reportSeq;
  }

  /** The document revision the device last said it understands; 0 before any report. */
  deviceProtocol(): number {
    return this.deviceProto;
  }

  getTelemetry(): OsTelemetry | null {
    if (this.telemetry === null) return null;
    // `sleep` is the one nested object here, so it is cloned rather than
    // aliased: a caller that mutated it would be editing the device's report.
    const { sleep, ...rest } = this.telemetry;
    return sleep === undefined ? { ...rest } : { ...rest, sleep: { ...sleep } };
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

  /**
   * The VIBE block.
   *
   * New KEYS rather than new fields on an existing one — the same rule `rev`
   * and `ttl` follow, and for the same reason: the deployed firmware arity-
   * checks the keys it knows and ignores the ones it does not, so this ships
   * safely to a panel that has never heard of VIBE. Every record repeats the
   * agent id so a parser may index instead of relying on line order.
   */
  private serializeVibe(agents: OsVibeAgent[]): string {
    if (agents.length === 0) return "vibe\t0";
    const lines: string[] = [`vibe\t${agents.length}`];
    for (const agent of agents) {
      lines.push(`vibea\t${agent.id}\t${agent.label}\t${agent.plan}`);
      if (agent.stale) lines.push(`vibes\t${agent.id}\t1`);
      for (const metric of agent.metrics) {
        lines.push(`vibem\t${agent.id}\t${metric.label}\t${metric.used}\t${metric.limit}\t${metric.resetSec}`);
      }
    }
    return lines.join("\n");
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
      // Each level travels with the sequence at which the console last asked
      // for it, as a SEPARATE key rather than a third tab field — same reason
      // `rev`/`ttl` are separate from `item`: a firmware that grows an arity
      // check on `setvol` would drop the line entirely and silently stop
      // applying that level. A firmware that has never heard of these two keys
      // ignores them and behaves exactly as it did before they existed.
      if (this.settings.volume !== null) {
        lines.push(`setvol\t${this.settings.volume}`);
        lines.push(`setvolseq\t${this.volumeSeq}`);
      }
      if (this.settings.brightness !== null) {
        lines.push(`setbri\t${this.settings.brightness}`);
        lines.push(`setbriseq\t${this.brightnessSeq}`);
      }
    }
    // 夜间息屏, and only once the console has written one. Withheld before that
    // for the same reason the settings block is: an unwritten default sitting
    // in every document would be a request the device could act on, and the
    // device's own 设置 rows own this setting until a console says otherwise.
    //
    // FIELD BY FIELD, not the whole block. The firmware's per-field optionality
    // (`if (request.on >= 0)`) is only reachable if the line can be absent, and
    // a block that always emitted all four made a `{idleSec:600}` PUT carry an
    // `enabled:false` nobody asked for — which the device then persisted to
    // /data. Same withholding as `setvol`/`setbri` above.
    if (this.sleepSeq > 0) {
      lines.push(`sleepseq\t${this.sleepSeq}`);
      if (this.sleep.enabled !== null) lines.push(`sleepon\t${this.sleep.enabled ? 1 : 0}`);
      if (this.sleep.startMin !== null) lines.push(`sleepfrom\t${this.sleep.startMin}`);
      if (this.sleep.endMin !== null) lines.push(`sleeptill\t${this.sleep.endMin}`);
      // SECONDS, not ms: the value is minutes-scale, has no sub-second meaning,
      // and a short line is cheaper for the firmware's atoi.
      if (this.sleep.idleSec !== null) lines.push(`sleepidle\t${this.sleep.idleSec}`);
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
    // Emitted only once asked: a firmware that has never heard of the key
    // ignores it, and one that has must not see it on every document.
    if (this.upgradeSeq > 0) lines.push(`upgrade\t${this.upgradeSeq}`);
    lines.push(this.serializeVibe(this.vibe));
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
