import { renderPixelText, type PixelTextBitmap } from "@/lib/pixel-font";
import { PIXEL_FONT_5X7, renderPixelText5x7 } from "@/lib/pixel-font-5x7";
import { VIBE_ICONS, type VibeIconGrid } from "@/lib/vibe-icon-grids";
import { VIBE_ICON_SVG } from "@/lib/vibe-icon-svg";
import { VIBE_PIXEL_LOGOS, type VibePixelLogo } from "@/lib/vibe-pixel-logos";

// Mirrors src/vibe/usage-service.ts (VibeMetric / VibeProviderUsage /
// VibeUsageSnapshot) and the GET /api/vibe/status envelope of design §5.
// Hand-written, like every other server shape in @/types — there is no codegen,
// and the design document is the contract both halves are written against.

export interface VibeMetric {
  key: string;
  label: string;
  kind: "consumption" | "balance";
  unit: string;
  used?: number;
  limit?: number;
  remaining?: number;
  utilization?: number;
  available?: number;
  resetsAt?: string;
  windowSeconds?: number;
}

export interface VibeSpendLine {
  label: string;
  value: string;
}

/** Where a row came from — local read or pushed by an agent (ADR 0013). */
export interface VibeUsageSource {
  kind: "local" | "remote";
  machine?: string;
}

export interface VibeProviderUsage {
  id: string;
  displayName: string;
  plan?: string;
  fetchedAt: string;
  stale: boolean;
  /** A non-fatal vendor hint ("re-login to restore live limits"), never an error. */
  note?: string;
  metrics: VibeMetric[];
  spendLines: VibeSpendLine[];
  /** Absent on a service older than the ingest route; treated as local. */
  source?: VibeUsageSource;
}

export interface VibeProviderError {
  providerId: string;
  message: string;
}

export interface VibeUsageSnapshot {
  fetchedAt: string;
  generatedAt: string;
  providers: VibeProviderUsage[];
  errors: VibeProviderError[];
}

export interface VibeCatalogEntry {
  id: string;
  displayName: string;
  order: number;
  percentKeys: string[];
  defaultStarred: string[];
  metricLabels: Record<string, string>;
}

/** One machine that has pushed usage to this service (ADR 0013). */
export interface VibeIngestMachine {
  machine: string;
  receivedAt: string;
  sentAt: string;
  providerIds: string[];
  stale: boolean;
}

export interface VibeIngestStatus {
  /** Whether this deployment can receive pushes at all. */
  available: boolean;
  /** Whether a token is set. Without one every push is refused. */
  enabled: boolean;
  path: string;
  /** This service runs inside a container, so local credentials are out of reach. */
  containerized: boolean;
  machines: VibeIngestMachine[];
}

export interface VibeStatusResponse {
  catalog: VibeCatalogEntry[];
  starred: Record<string, string[]>;
  snapshot: VibeUsageSnapshot | null;
  error: string | null;
  /** Absent on a service older than the ingest route; the dialog copes. */
  ingest?: VibeIngestStatus;
  /** Absent on a service older than 自动翻页; the panel reads it as 0 — off. */
  pageIntervalSec?: number;
  /**
   * How the clock splits a metric row's value cell between the number and the
   * reset countdown, in ms. Absent on an older service; the panel then shows
   * the firmware's shipped 3200 / 1600.
   */
  valueDwellMs?: number;
  resetDwellMs?: number;
}

export interface VibeStarredResponse {
  starred: Record<string, string[]>;
}

export interface VibeDisplayResponse {
  pageIntervalSec: number;
  valueDwellMs: number;
  resetDwellMs: number;
}

/**
 * How many agents this machine is actually signed into. It is the number the
 * status strip prints, so it comes from the snapshot and nowhere else: the
 * catalog lists four vendors and a signed-out one simply is not in `providers`.
 */
export function vibeSignedInCount(snapshot: VibeUsageSnapshot | null): number {
  return snapshot?.providers.length ?? 0;
}

/**
 * Where this panel's numbers come from, as one answerable sentence.
 *
 * The two topologies render identically on purpose, but that left the console
 * unable to answer the question everybody actually has — «do I need to set up
 * remote collection?» — so the strip states the split and the empty state says
 * which of the two situations it is in.
 *
 * A row with no `source` is counted local: only a service too old to have the
 * ingest route can produce one, and that service could only read locally.
 */
export interface VibeSourceSummary {
  local: number;
  remote: number;
  /** Machines contributing at least one visible row, in row order. */
  machines: string[];
  /** «直采 4 家» / «远程 2 家（work-laptop）» / «直采 2 家 · 远程 1 家» */
  label: string;
}

export function vibeSourceSummary(snapshot: VibeUsageSnapshot | null): VibeSourceSummary {
  const providers = snapshot?.providers ?? [];
  const machines: string[] = [];
  let local = 0;
  let remote = 0;
  for (const provider of providers) {
    if (provider.source?.kind === "remote") {
      remote += 1;
      const machine = provider.source.machine;
      if (machine !== undefined && !machines.includes(machine)) machines.push(machine);
    } else {
      local += 1;
    }
  }
  return { local, remote, machines, label: sourceLabel(local, remote, machines) };
}

function sourceLabel(local: number, remote: number, machines: string[]): string {
  if (local === 0 && remote === 0) return "";
  // Naming the machines is worth the width only while there are few of them;
  // past two the strip would wrap and say less than the count already does.
  const from = machines.length > 0 && machines.length <= 2 ? `（${machines.join("、")}）` : "";
  if (remote === 0) return `本机直采 ${local} 家`;
  if (local === 0) return `远程推送 ${remote} 家${from}`;
  return `本机直采 ${local} 家 · 远程 ${remote} 家${from}`;
}

/**
 * The focus id that sends the clock to its own VIBE app.
 *
 * VIBE is a destination on the firmware's root ring now, not a channel — the
 * service publishes it as a `kind: "vibe"` menu entry beside 音乐 and 游戏, and
 * `PUT /api/os/display` names it the same way `music` and `settings` are named.
 * See docs/design/vibe-firmware-app.md §2.
 */
export const VIBE_ZOS_FOCUS = "vibe";

// Mirrors LayoutStore.maxPinsPerProvider: the LED strip only has room for two.
export const VIBE_MAX_STARRED = 2;

export interface VibePageIntervalOption {
  seconds: number;
  label: string;
}

/**
 * 自动翻页 — how long the clock holds one VIBE page before turning to the next.
 *
 * 0 first and worded, not "0 秒", the way the stock firmware's 自动翻页速度 does
 * it: it is the state the app shipped in, where only the knob turns the ring.
 *
 * The floor is the panel's own value↔countdown cycle (3200 + 1600 ms in
 * ui/VibeScreen.h) — under it a metric's reset countdown never gets its turn in
 * the cell it shares with the number. The ceiling is the five-minute republish
 * cadence, past which the numbers move more often than the page does. Both are
 * OS_VIBE_MIN/MAX_PAGE_INTERVAL_SEC in src/os-link.ts, and the ladder reaches
 * the ceiling so no legal value is unreachable from here.
 */
export const VIBE_PAGE_INTERVAL_OPTIONS: readonly VibePageIntervalOption[] = [
  { seconds: 0, label: "不翻页" },
  { seconds: 5, label: "5 秒" },
  { seconds: 10, label: "10 秒" },
  { seconds: 15, label: "15 秒" },
  { seconds: 20, label: "20 秒" },
  { seconds: 30, label: "30 秒" },
  { seconds: 60, label: "1 分钟" },
  { seconds: 120, label: "2 分钟" },
  { seconds: 300, label: "5 分钟" },
];

export function vibePageIntervalLabel(seconds: number): string {
  const preset = VIBE_PAGE_INTERVAL_OPTIONS.find((option) => option.seconds === seconds);
  if (preset) return preset.label;
  // An API-set value between presets still has to be said honestly rather than
  // snapped — opening the page must not silently edit the clock.
  if (seconds <= 0) return "不翻页";
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

/**
 * The option list to render, with the current value folded in when it is not a
 * preset. Same rule the 息屏等待 select follows: a value the console cannot
 * offer is still a value the clock is running.
 */
/**
 * The value cell is shared in TIME — the meter takes x=21..34 and a three-digit
 * number takes x=37..51, so the reset countdown has nowhere to go but the same
 * cell, later. These are how long each half holds; the defaults are what the
 * firmware shipped with (VibeScreen.h kValueDwellMs / kResetDwellMs).
 */
export const VIBE_DEFAULT_VALUE_DWELL_MS = 3_200;
export const VIBE_DEFAULT_RESET_DWELL_MS = 1_600;
export const VIBE_MIN_CELL_DWELL_MS = 500;
export const VIBE_MAX_CELL_DWELL_MS = 20_000;

/** "3.2 秒" / "不显示" — seconds to one decimal, the way the channel editor reads. */
export function vibeCellDwellLabel(ms: number): string {
  if (ms <= 0) return "不显示";
  return `${Math.round(ms / 100) / 10} 秒`;
}

export function vibePageIntervalChoices(current: number): number[] {
  const presets = VIBE_PAGE_INTERVAL_OPTIONS.map((option) => option.seconds);
  if (presets.includes(current)) return presets;
  return [...presets, current].sort((a, b) => a - b);
}
// OpenUsage's absolute meter bands (80% / 90% used); the LED renderer uses the
// same two numbers, so a row that reads amber on screen reads amber on glass.
export const VIBE_SEVERITY_WARNING = 0.8;
export const VIBE_SEVERITY_CRITICAL = 0.9;
// OpenUsage's "Outdated" tag threshold: two refresh intervals of 5 minutes.
export const VIBE_OUTDATED_MS = 10 * 60_000;

export type VibeSeverity = "none" | "normal" | "warning" | "critical";

export function vibeSeverity(utilization: number | undefined): VibeSeverity {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return "none";
  if (utilization >= VIBE_SEVERITY_CRITICAL) return "critical";
  if (utilization >= VIBE_SEVERITY_WARNING) return "warning";
  return "normal";
}

// A meter only exists when the upstream gave both a used share and a ceiling;
// anything else renders as text so the bar never implies a limit we invented.
export function vibeMeterFill(metric: VibeMetric): number | null {
  if (metric.kind !== "consumption") return null;
  const utilization = metric.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  return Math.min(1, Math.max(0, utilization));
}

function metricScalar(metric: VibeMetric): number | null {
  // utilization*100 is only a valid stand-in for a missing `used` on percent
  // units; for usd/requests/… it would fabricate a number the upstream never
  // sent, and the LED renderer skips such metrics — both sides must agree.
  const value = metric.kind === "balance"
    ? metric.available
    : metric.used
      ?? (metric.unit === "percent" && typeof metric.utilization === "number"
        ? metric.utilization * 100
        : undefined);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The headline number for one metric row, or null when the field is missing. */
export function formatVibeValue(metric: VibeMetric): string | null {
  const value = metricScalar(metric);
  if (value === null) return null;
  if (metric.unit === "percent") return `${Math.round(value)}%`;
  if (metric.unit === "usd") return `$${value.toFixed(2)}`;
  return `${Math.round(value)}`;
}

export function formatVibeRelativeTime(iso: string | undefined, nowMs: number): string | null {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const elapsed = Math.max(0, nowMs - at);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** Countdown for a reset window. Past or missing resets say nothing at all. */
export function formatVibeReset(iso: string | undefined, nowMs: number): string | null {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const remaining = at - nowMs;
  if (remaining <= 0) return null;
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return "不到 1 分钟后重置";
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时后重置`;
  return `${Math.floor(hours / 24)} 天后重置`;
}

export function vibeSnapshotAgeMs(snapshot: VibeUsageSnapshot | null, nowMs: number): number | null {
  if (!snapshot) return null;
  const at = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, nowMs - at);
}

export function isVibeSnapshotOutdated(snapshot: VibeUsageSnapshot | null, nowMs: number): boolean {
  const age = vibeSnapshotAgeMs(snapshot, nowMs);
  return age !== null && age > VIBE_OUTDATED_MS;
}

/**
 * Provider mark ready for `dangerouslySetInnerHTML`. The generated SVGs carry
 * their brand fills (#4285F4, white, currentColor) and their own pixel sizes;
 * the list paints them with the row's ink at whatever size the box is, so every
 * real fill becomes currentColor and the root tag is resized to the container.
 * `fill="none"` survives — on the root element it is what keeps the box from
 * flooding solid.
 */
export function vibeIconMarkup(providerId: string): string | null {
  const raw = VIBE_ICON_SVG[providerId];
  if (raw === undefined) return null;
  const tagEnd = raw.indexOf(">");
  if (tagEnd < 0) return null;
  const head = `${raw.slice(0, tagEnd).replace(/\s(?:width|height)="[^"]*"/g, "")} width="100%" height="100%"`;
  return `${head}${raw.slice(tagEnd)}`.replace(/fill="(?!none")[^"]*"/g, 'fill="currentColor"');
}

/**
 * Star toggle intent. The cap is OpenUsage's (two pins per provider) and it is
 * enforced here rather than by trimming, so the UI can say why the click did
 * nothing instead of silently dropping someone else's star.
 */
export type VibeStarOutcome =
  | { ok: true; starred: string[] }
  | { ok: false; reason: "limit" };

export function toggleVibeStar(current: string[], key: string): VibeStarOutcome {
  if (current.includes(key)) {
    return { ok: true, starred: current.filter((entry) => entry !== key) };
  }
  if (current.length >= VIBE_MAX_STARRED) return { ok: false, reason: "limit" };
  return { ok: true, starred: [...current, key] };
}

// --- the clock's own VIBE pages, reproduced for the console ------------------
//
// VIBE is a firmware app now (docs/design/vibe-firmware-app.md): the service
// publishes rows in the ZOS pull document and the device draws them itself.
// There is no channel left to ask the server to render, so the preview paints
// the two pages here instead — from the SAME rows the service publishes
// (`OsVibeAgent` in src/os-link.ts, filled by `publishOsVibe` in src/service.ts)
// and the SAME hand-drawn marks the firmware header is generated from.
//
// It is a reproduction, not a mirror — the glass is painted by C++. What keeps
// the two from drifting apart in the ways that matter is that everything
// carrying a decision (which agents, which metrics, which numbers, which mark,
// which severity band) is shared data, and only the pixel-pushing is written
// twice. The 3x5 face here is the console's own (`@/lib/pixel-font`), which
// draws the digits and `%` identically to the service's table and differs on a
// few letters that only ever appear in the empty states.

export const VIBE_SCREEN_WIDTH = 52;
export const VIBE_SCREEN_HEIGHT = 16;
/** Mirrors MAX_VIBE_AGENTS in src/os-link.ts — the panel's own budget. */
export const VIBE_MAX_SCREEN_AGENTS = 10;

/** One metric row, exactly as the pull document carries it. */
export interface VibeScreenMetric {
  /** The vendor's own label — "Session", "Weekly", "Credits". */
  label: string;
  used: number;
  /** 0 when the vendor gave no ceiling; the page then draws a bare number. */
  limit: number;
  /** Seconds until this window resets, or -1 when the vendor sends none. */
  resetSec: number;
}

export interface VibeScreenAgent {
  id: string;
  label: string;
  plan: string;
  stale: boolean;
  metrics: VibeScreenMetric[];
}

/** Mirrors clampVibeNumber in src/os-link.ts: three digit cells, nothing wider. */
function clampScreenNumber(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(999, Math.round(value)));
}

/**
 * Fold a status snapshot into the rows the device will actually receive.
 *
 * This is `publishOsVibe` (src/service.ts) rewritten against the console's copy
 * of the same shapes: star order decides row order, a starred metric the vendor
 * did not send this round simply has no row, and the unit arithmetic happens
 * here rather than on a device that should only ever draw. Reproducing the fold
 * is what makes the preview answer "what will the clock show", not "what does
 * this browser know".
 */
export function vibeScreenAgents(
  snapshot: VibeUsageSnapshot | null,
  catalog: VibeCatalogEntry[],
  starred: Record<string, string[]>,
): VibeScreenAgent[] {
  if (!snapshot) return [];
  return snapshot.providers.slice(0, VIBE_MAX_SCREEN_AGENTS).map((provider) => {
    const entry = catalog.find((candidate) => candidate.id === provider.id);
    const keys = starred[provider.id] ?? entry?.defaultStarred ?? [];
    const metrics = keys
      .map((key) => provider.metrics.find((metric) => metric.key === key))
      .filter((metric): metric is VibeMetric => metric !== undefined)
      .slice(0, VIBE_MAX_STARRED)
      .map((metric) => {
        const value = metric.kind === "balance" ? metric.available : metric.used;
        const resetsAt = metric.resetsAt === undefined ? Number.NaN : Date.parse(metric.resetsAt);
        return {
          label: metric.label,
          used: clampScreenNumber(value),
          // A meter needs a ceiling to mean anything; percent metrics carry one,
          // a credit balance does not and is drawn as a bare number.
          limit: metric.unit === "percent" ? clampScreenNumber(metric.limit ?? 100) : 0,
          resetSec: Number.isFinite(resetsAt)
            ? Math.max(-1, Math.round((resetsAt - Date.now()) / 1000))
            : -1,
        };
      });
    return {
      id: provider.id,
      label: provider.displayName,
      plan: provider.plan ?? "",
      stale: provider.stale,
      metrics,
    };
  });
}

/**
 * The ring the knob turns through on the device: an overview, then one page per
 * agent (design §4.1). Signed into nothing is a single 未登录 page, which is a
 * state the panel names rather than an error.
 */
export type VibeScreenPage =
  | { kind: "offline" }
  | { kind: "overview"; agents: VibeScreenAgent[] }
  | { kind: "agent"; agent: VibeScreenAgent };

export function vibeScreenPages(agents: VibeScreenAgent[]): VibeScreenPage[] {
  if (agents.length === 0) return [{ kind: "offline" }];
  return [
    // Two cells is all 52 px fits, so the overview is the first two agents in
    // the order the document lists them — the device has no other choice either.
    { kind: "overview", agents: agents.slice(0, 2) },
    ...agents.map((agent) => ({ kind: "agent" as const, agent })),
  ];
}

/** Caption for one page, in the vendors' own names. */
export function vibeScreenPageLabel(page: VibeScreenPage): string {
  if (page.kind === "offline") return "未登录任何代理";
  if (page.kind === "agent") return page.agent.label;
  const names = page.agents.map((agent) => agent.label);
  return names.length === 0 ? "总览" : `总览 · ${names.join(" + ")}`;
}

type VibeRgb = readonly [number, number, number];

const SCREEN_WHITE: VibeRgb = [255, 255, 255];
// OpenUsage's absolute bands, the macOS traffic light — the same two numbers the
// metric list uses above, so a row that reads amber in the list reads amber on
// the glass.
const SCREEN_AMBER: VibeRgb = [255, 204, 0];
const SCREEN_RED: VibeRgb = [255, 69, 58];
const SCREEN_BLUE: VibeRgb = [10, 132, 255];
const SCREEN_TRACK: VibeRgb = [40, 44, 52];
const SCREEN_SOFT: VibeRgb = [130, 140, 155];
const SCREEN_MUTED: VibeRgb = [150, 150, 150];

// Layout of design §4.2, which is the LED layout of vibe-usage.md §3 — already
// proven readable on hardware, which is why the firmware reuses it verbatim.
const ICON_10 = 10;
const ICON_TEXT_GAP = 2;
// The per-agent page's numbers, read off VibeScreen.cpp rather than re-derived:
// kDetailRowX, kMeterX, kMeterW, kDetailRightX. The row starts one column past
// the 16 px mark (x=16 is the gutter), so it owns x=17..51 — two px narrower
// than the 12 px-mark layout it replaced, with the spacing inside it unchanged.
const AGENT_ROW_X = 17;
const METER_X = 21;
const METER_WIDTH = 14;
const METER_HEIGHT = 5;
// kMarkColor / kMarkColorY: the brand art is 16 rows on a 16-row panel, so it
// is drawn 1:1 from the top-left corner — no scaling, no crop, no offset.
const COLOR_MARK_SIZE = 16;
const COLOR_MARK_Y = 0;
// kMarkFallbackX / kMarkLargeY: the monochrome 12 px stand-in, centred in the
// same 16 px column so a vendor without colour art still leaves the row at 17.
const MARK_FALLBACK_X = (COLOR_MARK_SIZE - 12) / 2;
const MARK_FALLBACK_Y = 2;

// Widened from the source's own key union: `agent.id` is whatever the pull
// document named, and a vendor added after this build shipped simply has no art.
const COLOR_MARKS: Readonly<Record<string, VibePixelLogo>> = VIBE_PIXEL_LOGOS;

function screenUtilization(metric: VibeScreenMetric): number | undefined {
  if (metric.limit <= 0) return undefined;
  return Math.max(0, Math.min(1, metric.used / metric.limit));
}

/**
 * The number on the row. The service resolves units before it sends (design
 * §3.2), so `used` already IS the percent when there is a ceiling — the device
 * does no unit arithmetic and neither does this.
 */
function screenValueText(metric: VibeScreenMetric): string {
  // REMAINING, matching the firmware's default (VibeScreen's mShowLeft). The
  // preview is presented as exactly what the clock shows, so a preview counting
  // the other way is a preview that lies — and this one used to, silently,
  // because it had no notion of the toggle at all.
  //
  // 100 - percent rather than (limit - used) / limit: the two halves must sum
  // to 100 on screen, and the firmware makes the same choice for the same
  // reason. A metric with no ceiling is a balance, which IS what is left, so
  // there is nothing to invert.
  if (metric.limit <= 0) return `${metric.used}`;
  const left = Math.max(0, 100 - metric.used);
  return `${left}%`;
}

function screenTextColor(utilization: number | undefined): VibeRgb {
  if (utilization === undefined) return SCREEN_WHITE;
  if (utilization >= VIBE_SEVERITY_CRITICAL) return SCREEN_RED;
  if (utilization >= VIBE_SEVERITY_WARNING) return SCREEN_AMBER;
  return SCREEN_WHITE;
}

function screenMeterColor(utilization: number): VibeRgb {
  if (utilization >= VIBE_SEVERITY_CRITICAL) return SCREEN_RED;
  if (utilization >= VIBE_SEVERITY_WARNING) return SCREEN_AMBER;
  return SCREEN_BLUE;
}

/** RGBA the canvas can blit straight back, opaque black to start with. */
function createScreen(): Uint8ClampedArray {
  const frame = new Uint8ClampedArray(VIBE_SCREEN_WIDTH * VIBE_SCREEN_HEIGHT * 4);
  for (let index = 3; index < frame.length; index += 4) frame[index] = 255;
  return frame;
}

/** Out of bounds is dropped rather than wrapped, exactly as PixelCanvas does. */
function setScreenPixel(frame: Uint8ClampedArray, x: number, y: number, color: VibeRgb): void {
  if (x < 0 || y < 0 || x >= VIBE_SCREEN_WIDTH || y >= VIBE_SCREEN_HEIGHT) return;
  const at = (y * VIBE_SCREEN_WIDTH + x) * 4;
  frame[at] = color[0];
  frame[at + 1] = color[1];
  frame[at + 2] = color[2];
}

function fillScreenRect(
  frame: Uint8ClampedArray,
  x: number,
  y: number,
  width: number,
  height: number,
  color: VibeRgb,
): void {
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      setScreenPixel(frame, x + column, y + row, color);
    }
  }
}

function blitText(
  frame: Uint8ClampedArray,
  bitmap: PixelTextBitmap,
  x: number,
  y: number,
  color: VibeRgb,
): void {
  for (let row = 0; row < bitmap.height; row += 1) {
    for (let column = 0; column < bitmap.width; column += 1) {
      if (bitmap.on[row * bitmap.width + column]) setScreenPixel(frame, x + column, y + row, color);
    }
  }
}

function smallText(text: string): PixelTextBitmap {
  return renderPixelText(text, 5);
}

function wideText(text: string): PixelTextBitmap {
  return renderPixelText5x7(text, 1);
}

/** The 5x7 face covers digits, A-Z and `%`; anything else falls back to 3x5. */
function supportsWideFace(text: string): boolean {
  return [...text.toUpperCase()].every((character) => PIXEL_FONT_5X7[character] !== undefined);
}

/** "*" cells are the marks' antialiasing, drawn at 55 % so a shape survives. */
function dimScreenColor(color: VibeRgb): VibeRgb {
  return [
    Math.round(color[0] * 140 / 255),
    Math.round(color[1] * 140 / 255),
    Math.round(color[2] * 140 / 255),
  ];
}

function drawScreenIcon(
  frame: Uint8ClampedArray,
  grid: VibeIconGrid,
  x: number,
  y: number,
  color: VibeRgb,
): void {
  const dimmed = dimScreenColor(color);
  grid.forEach((line, row) => {
    for (let column = 0; column < line.length; column += 1) {
      const cell = line[column];
      if (cell === "x") setScreenPixel(frame, x + column, y + row, color);
      else if (cell === "*") setScreenPixel(frame, x + column, y + row, dimmed);
    }
  });
}

/**
 * The 16x16 brand art, 1:1 — VibeScreen.cpp's `drawColorMark`, cell for cell.
 *
 * It takes NO colour, on purpose: these marks carry colours sampled from the
 * vendors' own brands, and repainting them in the page's severity accent would
 * be the same mistake as tinting a photograph — the red would stop meaning
 * "92% spent" and start meaning "this vendor's logo is red". A "." cell is the
 * firmware's palette index 0: transparent, never plotted, so whatever the page
 * drew behind the mark shows through.
 *
 * Returns false when there is no colour art for the vendor, which is the
 * caller's cue to fall back rather than leave the page ownerless.
 */
function drawScreenColorMark(
  frame: Uint8ClampedArray,
  id: string,
  x: number,
  y: number,
): boolean {
  const logo = COLOR_MARKS[id];
  if (logo === undefined) return false;
  logo.rows.forEach((line, row) => {
    for (let column = 0; column < line.length; column += 1) {
      const cell = line[column]!;
      if (cell === ".") continue;
      const rgba = logo.palette[cell];
      if (rgba === undefined) continue;
      setScreenPixel(frame, x + column, y + row, [rgba[0], rgba[1], rgba[2]]);
    }
  });
  return true;
}

/**
 * A vendor standing on its last good numbers gets one amber pixel in the corner
 * — the same convention the LED channel used, and the only freshness signal the
 * document actually carries (`vibes`).
 */
function markStale(frame: Uint8ClampedArray, agents: readonly VibeScreenAgent[]): void {
  if (agents.some((agent) => agent.stale)) {
    setScreenPixel(frame, VIBE_SCREEN_WIDTH - 1, 0, SCREEN_AMBER);
  }
}

interface DuoCell {
  icon: VibeIconGrid;
  lines: { text: string; color: VibeRgb }[];
}

interface DuoState {
  gap: number;
  dropSign: boolean;
  truncateRight: boolean;
  truncateLeft: boolean;
  smallFace: boolean;
  dropRightCell: boolean;
}

interface DuoPlan {
  width: number;
  face: "3x5" | "5x7";
  lines: { text: string; color: VibeRgb; width: number }[];
}

function buildDuoCell(agent: VibeScreenAgent): DuoCell | undefined {
  const icon = VIBE_ICONS[agent.id]?.s10;
  if (!icon || agent.metrics.length === 0) return undefined;
  return {
    icon,
    lines: agent.metrics.map((metric) => ({
      text: screenValueText(metric),
      color: screenTextColor(screenUtilization(metric)),
    })),
  };
}

function planDuoCell(cell: DuoCell, state: DuoState, isRight: boolean): DuoPlan {
  const truncate = isRight ? state.truncateRight : state.truncateLeft;
  const kept = truncate && cell.lines.length > 1 ? cell.lines.slice(0, 1) : cell.lines;
  const texts = kept.map((line) => ({
    ...line,
    // "100%" is the only percent wide enough to matter, and the sign is the one
    // glyph carrying nothing a reader of this page lacks.
    text: state.dropSign && line.text.length === 4 && line.text.endsWith("%")
      ? line.text.slice(0, -1)
      : line.text,
  }));
  // The face follows the DATA, not the truncation: a cell cut down to one row
  // must not jump to the wider face and undo the cut it was made for.
  const face: "3x5" | "5x7" = cell.lines.length === 1
      && !state.smallFace
      && texts.every((line) => supportsWideFace(line.text))
    ? "5x7"
    : "3x5";
  const lines = texts.map((line) => ({
    ...line,
    width: face === "5x7" ? wideText(line.text).width : smallText(line.text).width,
  }));
  const column = Math.max(...lines.map((line) => line.width));
  return { width: ICON_10 + ICON_TEXT_GAP + column, face, lines };
}

function drawDuoCell(frame: Uint8ClampedArray, cell: DuoCell, plan: DuoPlan, x: number): void {
  drawScreenIcon(frame, cell.icon, x, 3, SCREEN_WHITE);
  const right = x + plan.width - 1;
  const rows = plan.face === "5x7" ? [4] : plan.lines.length === 2 ? [2, 9] : [5];
  plan.lines.forEach((line, index) => {
    const bitmap = plan.face === "5x7" ? wideText(line.text) : smallText(line.text);
    blitText(frame, bitmap, right - line.width + 1, rows[index]!, line.color);
  });
}

/**
 * The overflow ladder, in order, first fit wins.
 *
 * Two full cells at 100 % on both rows is 59 px wide, so a fixed layout would
 * clip on the one reading that matters most. Each rung gives up the least
 * information available at that point; the last drops the right cell entirely,
 * which is what an empty cell already looks like, rather than letting a value
 * run off the panel.
 */
const DUO_LADDER: readonly DuoState[] = [
  { gap: 5, dropSign: false, truncateRight: false, truncateLeft: false, smallFace: false, dropRightCell: false },
  { gap: 3, dropSign: false, truncateRight: false, truncateLeft: false, smallFace: false, dropRightCell: false },
  { gap: 3, dropSign: true, truncateRight: false, truncateLeft: false, smallFace: false, dropRightCell: false },
  { gap: 3, dropSign: true, truncateRight: true, truncateLeft: false, smallFace: false, dropRightCell: false },
  { gap: 3, dropSign: true, truncateRight: true, truncateLeft: true, smallFace: false, dropRightCell: false },
  { gap: 3, dropSign: true, truncateRight: true, truncateLeft: true, smallFace: true, dropRightCell: false },
  { gap: 3, dropSign: true, truncateRight: true, truncateLeft: true, smallFace: true, dropRightCell: true },
];

function drawOverviewPage(frame: Uint8ClampedArray, agents: readonly VibeScreenAgent[]): void {
  markStale(frame, agents);
  const present = agents
    .map(buildDuoCell)
    .filter((cell): cell is DuoCell => cell !== undefined);

  if (present.length === 0) {
    const bitmap = smallText("NO DATA");
    const width = ICON_10 + ICON_TEXT_GAP + bitmap.width;
    const originX = Math.floor((VIBE_SCREEN_WIDTH - width) / 2);
    // The neutral gauge, never a vendor's mark: there is no vendor to name here.
    const gauge = VIBE_ICONS.gauge?.s10;
    if (gauge) drawScreenIcon(frame, gauge, originX, 3, SCREEN_MUTED);
    blitText(frame, bitmap, originX + ICON_10 + ICON_TEXT_GAP, 5, SCREEN_MUTED);
    return;
  }

  const leftCell = present[0]!;
  const rightCell = present[1];
  let state = DUO_LADDER[DUO_LADDER.length - 1]!;
  let leftPlan = planDuoCell(leftCell, state, false);
  let rightPlan = rightCell ? planDuoCell(rightCell, state, true) : undefined;
  for (const candidate of DUO_LADDER) {
    const left = planDuoCell(leftCell, candidate, false);
    const right = rightCell && !candidate.dropRightCell
      ? planDuoCell(rightCell, candidate, true)
      : undefined;
    const total = left.width + (right ? candidate.gap + right.width : 0);
    if (total <= VIBE_SCREEN_WIDTH || candidate === DUO_LADDER[DUO_LADDER.length - 1]) {
      state = candidate;
      leftPlan = left;
      rightPlan = right;
      break;
    }
  }

  const total = leftPlan.width + (rightPlan ? state.gap + rightPlan.width : 0);
  // The last rung can still lose to absurd data; clamping keeps the icon's left
  // edge intact and lets only trailing pixels fall off the right.
  const originX = Math.max(0, Math.floor((VIBE_SCREEN_WIDTH - total) / 2));
  drawDuoCell(frame, leftCell, leftPlan, originX);
  if (rightPlan && rightCell) {
    drawDuoCell(frame, rightCell, rightPlan, originX + leftPlan.width + state.gap);
  }
}

function drawAgentRow(frame: Uint8ClampedArray, metric: VibeScreenMetric, y: number): void {
  // One character, because 35 px has to hold a label, a bar and a number. The
  // document carries the vendor's own word ("Session", "Credits") and the panel
  // takes its initial — the label itself is the vendor's, so the letter is too.
  const label = (metric.label.trim()[0] ?? "").toUpperCase();
  const utilization = screenUtilization(metric);
  const labelBitmap = smallText(label);
  blitText(frame, labelBitmap, AGENT_ROW_X, y, SCREEN_SOFT);

  const text = screenValueText(metric);
  const bitmap = smallText(text);
  // The value may never overprint what is left of it: the meter yields first (a
  // readable figure beats a bar), and the clamp keeps the origin right of the
  // label so a dropped pixel can only ever be a trailing one.
  const minValueX = AGENT_ROW_X + labelBitmap.width + 1;
  const valueX = Math.max(minValueX, VIBE_SCREEN_WIDTH - bitmap.width);
  if (utilization !== undefined && valueX >= METER_X + METER_WIDTH + 2) {
    fillScreenRect(frame, METER_X, y, METER_WIDTH, METER_HEIGHT, SCREEN_TRACK);
    const filled = Math.round(utilization * METER_WIDTH);
    if (filled > 0) {
      fillScreenRect(frame, METER_X, y, filled, METER_HEIGHT, screenMeterColor(utilization));
    }
  }
  blitText(frame, bitmap, valueX, y, screenTextColor(utilization));
}

function drawAgentPage(frame: Uint8ClampedArray, agent: VibeScreenAgent): void {
  markStale(frame, [agent]);
  // The colour art first, exactly as VibeScreen::renderAgent does it. A vendor
  // with no 16x16 art keeps the monochrome 12 px mark — centred in the same
  // column, because a page of numbers with no owner is worse than a badge that
  // is merely older.
  if (!drawScreenColorMark(frame, agent.id, 0, COLOR_MARK_Y)) {
    const icon = VIBE_ICONS[agent.id]?.s12;
    if (icon) drawScreenIcon(frame, icon, MARK_FALLBACK_X, MARK_FALLBACK_Y, SCREEN_WHITE);
  }

  if (agent.metrics.length === 0) {
    const bitmap = smallText("NO DATA");
    const rowWidth = VIBE_SCREEN_WIDTH - AGENT_ROW_X;
    blitText(
      frame,
      bitmap,
      AGENT_ROW_X + Math.floor((rowWidth - bitmap.width) / 2),
      5,
      SCREEN_MUTED,
    );
    return;
  }

  const rows = agent.metrics.length === 1 ? [5] : [2, 9];
  agent.metrics.forEach((metric, index) => drawAgentRow(frame, metric, rows[index]!));
}

function drawOfflinePage(frame: Uint8ClampedArray): void {
  const top = smallText("AI USAGE");
  const bottom = smallText("NO LOGIN");
  blitText(frame, top, Math.floor((VIBE_SCREEN_WIDTH - top.width) / 2), 2, SCREEN_MUTED);
  blitText(frame, bottom, Math.floor((VIBE_SCREEN_WIDTH - bottom.width) / 2), 9, SCREEN_AMBER);
}

/** One page of the ring, as 52x16 RGBA the canvas can blit unchanged. */
export function drawVibeScreen(page: VibeScreenPage): Uint8ClampedArray {
  const frame = createScreen();
  if (page.kind === "offline") drawOfflinePage(frame);
  else if (page.kind === "overview") drawOverviewPage(frame, page.agents);
  else drawAgentPage(frame, page.agent);
  return frame;
}
