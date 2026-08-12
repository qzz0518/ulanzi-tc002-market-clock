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

export interface OsMenuEntry {
  /** Stable id the firmware echoes back when the user activates it. */
  id: string;
  /** UTF-8 label as shown on the panel. */
  label: string;
  kind: "channel" | "music" | "game" | "settings";
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
  lyricEndMs: number;
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

const MAX_LABEL_CELLS = 24;
const MAX_ENTRIES = 32;

function sanitizeField(value: string): string {
  // Tabs and newlines are the record separators, so they can never appear in a
  // value. Channel names are user-authored and arrive from workspace.json.
  return value.replace(/[\t\r\n]+/g, " ").trim();
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
  private nowPlaying: OsNowPlaying | null = null;
  private nowPlayingStampedAt = 0;
  private nowPlayingSource: OsNowPlayingSource | null = null;
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  currentSeq(): number {
    return this.seq;
  }

  setMenu(entries: OsMenuEntry[]): void {
    const next = entries.slice(0, MAX_ENTRIES).map((entry) => ({
      id: sanitizeField(entry.id),
      label: clampLabel(sanitizeField(entry.label)),
      kind: entry.kind,
    }));
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
    const next = now === null ? null : {
      track: clampLabel(sanitizeField(now.track)),
      artist: clampLabel(sanitizeField(now.artist)),
      playing: now.playing,
      positionMs: Math.max(0, Math.round(now.positionMs)),
      durationMs: Math.max(0, Math.round(now.durationMs)),
      lyric: clampLabel(sanitizeField(now.lyric)),
      lyricStartMs: Math.max(0, Math.round(now.lyricStartMs)),
      lyricEndMs: Math.max(0, Math.round(now.lyricEndMs)),
    };
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
        before.lyricStartMs !== next.lyricStartMs
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

  getNowPlaying(): OsNowPlaying | null {
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
    // Telemetry never bumps the sequence: it flows device->console, and waking
    // every long poll on it would turn a status heartbeat into a broadcast storm.
    this.telemetry = { ...telemetry, receivedAt: this.now() };
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

  private serializeMenu(entries: OsMenuEntry[]): string {
    return entries.map((e) => `${e.kind}\t${e.id}\t${e.label}`).join("\n");
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
          lines.push(`lyricat\t${np.lyricStartMs}`);
          lines.push(`lyricend\t${np.lyricEndMs}`);
        }
      }
    }
    lines.push(`menu\t${this.menu.length}`);
    for (const entry of this.menu) {
      lines.push(`item\t${entry.kind}\t${entry.id}\t${entry.label}`);
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
