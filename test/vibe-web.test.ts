import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CladdProvider } from "@cladd-ui/react";
import { VibeDisplay } from "../web/src/components/vibe/vibe-display";
import { VibeKeys } from "../web/src/components/vibe/vibe-keys";
import { VibeProviderList } from "../web/src/components/vibe/vibe-provider-list";
import {
  VIBE_KEY_PROVIDERS,
  VIBE_SCREEN_HEIGHT,
  VIBE_SCREEN_WIDTH,
  VIBE_ZOS_FOCUS,
  drawVibeScreen,
  formatVibeRelativeTime,
  formatVibeReset,
  formatVibeValue,
  isVibeSnapshotOutdated,
  toggleVibeStar,
  vibeIconMarkup,
  vibeKeyState,
  vibeMeterFill,
  vibeScreenAgents,
  vibeScreenPageLabel,
  vibeScreenPages,
  vibeSeverity,
  vibeSignedInCount,
  type VibeCatalogEntry,
  type VibeMetric,
  type VibeScreenAgent,
  type VibeUsageSnapshot,
} from "../web/src/lib/vibe";

describe("severity — OpenUsage's absolute bands", () => {
  test("80% and 90% used are the two steps, and they are inclusive", () => {
    expect(vibeSeverity(0.799)).toBe("normal");
    expect(vibeSeverity(0.8)).toBe("warning");
    expect(vibeSeverity(0.899)).toBe("warning");
    expect(vibeSeverity(0.9)).toBe("critical");
    expect(vibeSeverity(1.4)).toBe("critical");
  });

  test("no utilization is no colour — a grey track, never an implied zero", () => {
    expect(vibeSeverity(undefined)).toBe("none");
    expect(vibeSeverity(Number.NaN)).toBe("none");
  });

  test("the meter only exists for consumption with a real utilization", () => {
    expect(vibeMeterFill(metric({ utilization: 0.42 }))).toBe(0.42);
    expect(vibeMeterFill(metric({ utilization: undefined }))).toBeNull();
    expect(vibeMeterFill(metric({ kind: "balance", available: 12 }))).toBeNull();
    // Over-limit quotas exist upstream; the bar stops at full rather than
    // overflowing its track.
    expect(vibeMeterFill(metric({ utilization: 1.3 }))).toBe(1);
  });
});

function metric(over: Partial<VibeMetric> = {}): VibeMetric {
  return {
    key: "session",
    label: "Session",
    kind: "consumption",
    unit: "percent",
    used: 41,
    limit: 100,
    utilization: 0.41,
    ...over,
  };
}

describe("formatting", () => {
  test("each unit prints the way OpenUsage prints it", () => {
    expect(formatVibeValue(metric({ used: 92.6 }))).toBe("93%");
    expect(formatVibeValue(metric({ unit: "usd", used: 32.839 }))).toBe("$32.84");
    expect(formatVibeValue(metric({ unit: "credits", used: 820.7 }))).toBe("821");
    expect(formatVibeValue(metric({ kind: "balance", unit: "usd", used: undefined, available: 5 })))
      .toBe("$5.00");
  });

  test("a missing field is nothing, not zero", () => {
    expect(formatVibeValue(metric({ used: undefined, utilization: undefined }))).toBeNull();
    expect(formatVibeValue(metric({ kind: "balance", used: 10, available: undefined }))).toBeNull();
  });

  const NOW = Date.parse("2026-08-14T12:00:00Z");

  test("ages read in the units a person would use", () => {
    expect(formatVibeRelativeTime("2026-08-14T11:59:31Z", NOW)).toBe("刚刚");
    expect(formatVibeRelativeTime("2026-08-14T11:57:00Z", NOW)).toBe("3 分钟前");
    expect(formatVibeRelativeTime("2026-08-14T09:00:00Z", NOW)).toBe("3 小时前");
    expect(formatVibeRelativeTime("2026-08-12T09:00:00Z", NOW)).toBe("2 天前");
    // A clock skewed into the future is not "-2 分钟前".
    expect(formatVibeRelativeTime("2026-08-14T12:02:00Z", NOW)).toBe("刚刚");
    expect(formatVibeRelativeTime(undefined, NOW)).toBeNull();
    expect(formatVibeRelativeTime("not a date", NOW)).toBeNull();
  });

  test("a reset already past says nothing at all", () => {
    expect(formatVibeReset("2026-08-14T14:30:00Z", NOW)).toBe("2 小时后重置");
    expect(formatVibeReset("2026-08-14T12:07:00Z", NOW)).toBe("7 分钟后重置");
    expect(formatVibeReset("2026-08-14T11:00:00Z", NOW)).toBeNull();
    expect(formatVibeReset(undefined, NOW)).toBeNull();
  });

  test("the Outdated notice is OpenUsage's own 10-minute threshold", () => {
    const at = (generatedAt: string): VibeUsageSnapshot => ({
      fetchedAt: generatedAt,
      generatedAt,
      providers: [],
      errors: [],
    });
    expect(isVibeSnapshotOutdated(at("2026-08-14T11:51:00Z"), NOW)).toBe(false);
    expect(isVibeSnapshotOutdated(at("2026-08-14T11:50:00Z"), NOW)).toBe(false);
    expect(isVibeSnapshotOutdated(at("2026-08-14T11:49:00Z"), NOW)).toBe(true);
    expect(isVibeSnapshotOutdated(null, NOW)).toBe(false);
  });
});

describe("stars", () => {
  test("two per provider, and the third click says why instead of dropping one", () => {
    expect(toggleVibeStar([], "session")).toEqual({ ok: true, starred: ["session"] });
    expect(toggleVibeStar(["session"], "weekly"))
      .toEqual({ ok: true, starred: ["session", "weekly"] });
    expect(toggleVibeStar(["session", "weekly"], "sonnet")).toEqual({ ok: false, reason: "limit" });
    // Un-starring is always allowed, cap or no cap.
    expect(toggleVibeStar(["session", "weekly"], "session"))
      .toEqual({ ok: true, starred: ["weekly"] });
  });
});

describe("provider marks", () => {
  test("brand fills become the row's ink, and the root box stays hollow", () => {
    const claude = vibeIconMarkup("claude")!;
    expect(claude).toContain("currentColor");
    // antigravity ships #4285F4 and copilot ships white; neither may survive.
    expect(vibeIconMarkup("antigravity")).not.toContain("#4285F4");
    expect(vibeIconMarkup("copilot")).not.toContain('fill="white"');
    expect(vibeIconMarkup("antigravity")).toContain('fill="none"');
  });

  test("the mark is sized by its box, not by the file's own pixels", () => {
    const markup = vibeIconMarkup("opencode")!;
    expect(markup).toContain('width="100%"');
    expect(markup).toContain('height="100%"');
    expect(markup).not.toContain('width="24"');
    expect(markup).toContain("viewBox=");
  });

  test("an unknown provider has no mark rather than a broken one", () => {
    expect(vibeIconMarkup("nope")).toBeNull();
  });
});

// The list is the page's OpenUsage-Customize mirror: catalog order, a plan
// line, "N 项指标", star pins, severity-coloured meters, spend text. Rendering
// it statically proves the parts markup can prove.

const CATALOG: VibeCatalogEntry[] = [
  {
    id: "claude",
    displayName: "Claude",
    order: 0,
    percentKeys: ["session", "weekly"],
    defaultStarred: ["session", "weekly"],
    metricLabels: { session: "Session", weekly: "Weekly" },
  },
  {
    id: "grok",
    displayName: "Grok",
    order: 6,
    percentKeys: ["weekly"],
    defaultStarred: ["weekly"],
    metricLabels: { weekly: "Weekly" },
  },
];

const SNAPSHOT: VibeUsageSnapshot = {
  fetchedAt: "2026-08-14T11:58:00Z",
  generatedAt: "2026-08-14T11:57:00Z",
  providers: [{
    id: "claude",
    displayName: "Claude",
    plan: "Max 20x",
    fetchedAt: "2026-08-14T11:57:00Z",
    stale: false,
    metrics: [
      metric({ key: "session", label: "Session", used: 41, utilization: 0.41 }),
      metric({ key: "weekly", label: "Weekly", used: 93, utilization: 0.93 }),
    ],
    spendLines: [{ label: "Today", value: "$127.42 · 141.8M tokens" }],
  }],
  errors: [{ providerId: "grok", message: "Not logged in" }],
};

describe("provider list — rendered", () => {
  const markup = (expandedId: string | null) => renderToStaticMarkup(createElement(
    CladdProvider,
    null,
    createElement(VibeProviderList, {
      catalog: CATALOG,
      snapshot: SNAPSHOT,
      starred: { claude: ["session"] },
      expandedId,
      nowMs: Date.parse("2026-08-14T12:00:00Z"),
      busyProviderId: null,
      onToggleExpanded: () => {},
      onToggleStar: () => {},
    }),
  ));

  test("a provider without data is greyed and says so, never zeroed", () => {
    const html = markup(null);
    expect(html).toContain("Max 20x");
    expect(html).toContain("2 项指标");
    expect(html).toContain("无数据");
    expect(html).toContain("is-empty");
    // The upstream's own error rides along instead of being swallowed.
    expect(html).toContain("Not logged in");
  });

  test("expanded rows carry the stars, the meters and the spend text", () => {
    const html = markup("claude");
    expect(html).toContain("取消星标：Session");
    expect(html).toContain("设为星标：Weekly");
    expect(html).toContain('aria-pressed="true"');
    // 93% is past OpenUsage's 90% band.
    expect(html).toContain("vibe-meter is-critical");
    expect(html).toContain("vibe-meter is-normal");
    expect(html).toContain("93%");
    expect(html).toContain("Today: $127.42 · 141.8M tokens");
    // 3 分钟前 is inside the 10-minute window, so no Outdated notice.
    expect(html).not.toContain("数据已过时");
  });

  test("brand marks are injected as inline SVG, hidden from the screen reader", () => {
    expect(markup(null)).toContain('<span class="vibe-provider__icon" aria-hidden="true"><svg');
  });
});

// A provider may hand back a hint alongside good numbers ("re-login to restore
// live limits"). It is not a failure and must not be dressed as one.
describe("provider notes", () => {
  const withNote: VibeUsageSnapshot = {
    ...SNAPSHOT,
    errors: [],
    providers: [{ ...SNAPSHOT.providers[0]!, note: "重新登录可恢复实时额度" }],
  };
  const html = renderToStaticMarkup(createElement(
    CladdProvider,
    null,
    createElement(VibeProviderList, {
      catalog: CATALOG,
      snapshot: withNote,
      starred: {},
      expandedId: null,
      nowMs: Date.parse("2026-08-14T12:00:00Z"),
      busyProviderId: null,
      onToggleExpanded: () => {},
      onToggleStar: () => {},
    }),
  ));

  test("the note rides on the row, in the soft class rather than the error one", () => {
    expect(html).toContain("重新登录可恢复实时额度");
    expect(html).toContain("vibe-provider__note");
    // The one thing it must never be: an alert. A hint that shouts is a bug.
    expect(html).not.toContain('role="alert"');
  });

  test("a provider without a note grows no empty line", () => {
    expect(renderToStaticMarkup(createElement(
      CladdProvider,
      null,
      createElement(VibeProviderList, {
        catalog: CATALOG,
        snapshot: SNAPSHOT,
        starred: {},
        expandedId: null,
        nowMs: Date.parse("2026-08-14T12:00:00Z"),
        busyProviderId: null,
        onToggleExpanded: () => {},
        onToggleStar: () => {},
      }),
    ))).not.toContain("vibe-provider__note");
  });
});

// OpenRouter and Z.ai have no CLI login to borrow, so the user pastes a key.
// The wire only ever says where a key came from — never what it is.
describe("API keys", () => {
  test("only the two key-based vendors, matching src/vibe/vibe-key-store.ts", () => {
    expect([...VIBE_KEY_PROVIDERS]).toEqual(["openrouter", "zai"]);
  });

  test("anything the server did not say is 未设置, never an assumed key", () => {
    expect(vibeKeyState({ openrouter: "stored" }, "openrouter")).toBe("stored");
    expect(vibeKeyState({ zai: "environment" }, "zai")).toBe("environment");
    expect(vibeKeyState({ zai: "unset" }, "zai")).toBe("unset");
    // A missing entry, a stale field name, a value from a newer server.
    expect(vibeKeyState({}, "openrouter")).toBe("unset");
    expect(vibeKeyState({ openrouter: "maybe" }, "openrouter")).toBe("unset");
  });

  const KEY_CATALOG: VibeCatalogEntry[] = [
    { id: "openrouter", displayName: "OpenRouter", order: 8, percentKeys: [], defaultStarred: [], metricLabels: {} },
    { id: "zai", displayName: "Z.ai", order: 9, percentKeys: [], defaultStarred: [], metricLabels: {} },
  ];
  const keysMarkup = (keys: Record<string, string>) => renderToStaticMarkup(createElement(
    CladdProvider,
    null,
    createElement(VibeKeys, { catalog: KEY_CATALOG, keys, onSaved: async () => {} }),
  ));

  test("each vendor states where its key came from, and the field starts empty", () => {
    const html = keysMarkup({ openrouter: "stored", zai: "environment" });
    expect(html).toContain("已保存");
    expect(html).toContain("来自环境变量");
    expect(html).toContain('type="password"');
    expect(html).toContain('value=""');
    // A stored key is the only one the user can take back.
    expect(html).toContain("清除");
  });

  test("nothing set means no 清除 button to press", () => {
    const html = keysMarkup({ openrouter: "unset", zai: "unset" });
    expect(html).toContain("未设置");
    expect(html).not.toContain("清除");
  });

  test("the label is wired to the field, so the row is not two loose halves", () => {
    const html = keysMarkup({});
    expect(html).toContain('for="vibe-key-openrouter"');
    expect(html).toContain('id="vibe-key-openrouter"');
    // A credential must not land in the browser's saved-password store, nor go
    // to the platform's remote spell checker. (React emits the JSX spelling;
    // HTML attribute names are case-insensitive, so the browser reads it.)
    expect(html.toLowerCase()).toContain('autocomplete="off"');
    expect(html.toLowerCase()).toContain('spellcheck="false"');
  });
});

describe("signed-in count", () => {
  test("the strip's number is the snapshot's, never the catalog's", () => {
    expect(vibeSignedInCount(SNAPSHOT)).toBe(1);
    expect(vibeSignedInCount({ ...SNAPSHOT, providers: [] })).toBe(0);
    // No snapshot at all is "未接入", not a crash and not a guess.
    expect(vibeSignedInCount(null)).toBe(0);
  });
});

// --- the clock's own pages ---------------------------------------------------
//
// VIBE is a firmware app now: the service publishes rows and the device draws
// them. `vibeScreenAgents` is the console's copy of that fold (publishOsVibe in
// src/service.ts + the clamps in OsLinkHub.setVibe), so these hold the preview
// to what the device will actually receive rather than to what the browser
// happens to know.

describe("vibeScreenAgents — the rows the device receives", () => {
  test("star order decides row order, and only starred metrics travel", () => {
    const agents = vibeScreenAgents(SNAPSHOT, CATALOG, { claude: ["weekly", "session"] });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.metrics.map((row) => [row.label, row.used, row.limit]))
      .toEqual([["Weekly", 93, 100], ["Session", 41, 100]]);
    expect(agents[0]!.label).toBe("Claude");
    expect(agents[0]!.plan).toBe("Max 20x");
  });

  test("a starred metric the vendor did not send this round has no row", () => {
    // Not an invented zero and not a placeholder: the row simply is not there,
    // exactly as publishOsVibe drops it.
    const agents = vibeScreenAgents(SNAPSHOT, CATALOG, { claude: ["ghost", "session"] });
    expect(agents[0]!.metrics.map((row) => row.label)).toEqual(["Session"]);
  });

  test("two rows per agent is the panel's budget, not a suggestion", () => {
    const agents = vibeScreenAgents(SNAPSHOT, CATALOG, { claude: ["session", "weekly", "session"] });
    expect(agents[0]!.metrics).toHaveLength(2);
  });

  test("no star table falls back to the catalog's own defaults", () => {
    const agents = vibeScreenAgents(SNAPSHOT, CATALOG, {});
    expect(agents[0]!.metrics.map((row) => row.label)).toEqual(["Session", "Weekly"]);
  });

  test("only a percent metric gets a ceiling; everything else is a bare number", () => {
    const snapshot: VibeUsageSnapshot = {
      ...SNAPSHOT,
      providers: [{
        ...SNAPSHOT.providers[0]!,
        metrics: [
          metric({ key: "credits", label: "Credits", kind: "balance", unit: "usd", available: 12.4 }),
          metric({ key: "session", label: "Session", used: 41, utilization: 0.41 }),
        ],
      }],
    };
    const rows = vibeScreenAgents(snapshot, CATALOG, { claude: ["credits", "session"] })[0]!.metrics;
    // A meter without a ceiling would imply one nobody sent.
    expect(rows[0]).toEqual({ label: "Credits", used: 12, limit: 0, resetSec: -1 });
    expect(rows[1]!.limit).toBe(100);
  });

  test("three digit cells is the whole budget — 999 is the ceiling", () => {
    const snapshot: VibeUsageSnapshot = {
      ...SNAPSHOT,
      providers: [{
        ...SNAPSHOT.providers[0]!,
        metrics: [metric({ key: "session", label: "Session", unit: "requests", used: 1_240_000 })],
      }],
    };
    expect(vibeScreenAgents(snapshot, CATALOG, { claude: ["session"] })[0]!.metrics[0]!.used)
      .toBe(999);
  });

  test("no snapshot is no agents, never a guessed one", () => {
    expect(vibeScreenAgents(null, CATALOG, {})).toEqual([]);
  });
});

function screenAgent(id: string, used: number[], over: Partial<VibeScreenAgent> = {}): VibeScreenAgent {
  return {
    id,
    label: id,
    plan: "",
    stale: false,
    metrics: used.map((value, index) => ({
      label: index === 0 ? "Session" : "Weekly",
      used: value,
      limit: 100,
      resetSec: -1,
    })),
    ...over,
  };
}

describe("vibeScreenPages — the ring the knob turns", () => {
  test("signed into nothing is one 未登录 page, not an empty ring", () => {
    expect(vibeScreenPages([])).toEqual([{ kind: "offline" }]);
    expect(vibeScreenPageLabel({ kind: "offline" })).toBe("未登录任何代理");
  });

  test("the overview leads, then one page per agent", () => {
    const agents = [screenAgent("claude", [41]), screenAgent("codex", [12]), screenAgent("grok", [7])];
    const pages = vibeScreenPages(agents);
    expect(pages.map((page) => page.kind)).toEqual(["overview", "agent", "agent", "agent"]);
    // Only two cells fit in 52 px, so the overview is the first two — and the
    // third agent still has its own page.
    expect(vibeScreenPageLabel(pages[0]!)).toBe("总览 · claude + codex");
    expect(vibeScreenPageLabel(pages[3]!)).toBe("grok");
  });
});

function pixelAt(frame: Uint8ClampedArray, x: number, y: number): [number, number, number] {
  const at = (y * VIBE_SCREEN_WIDTH + x) * 4;
  return [frame[at]!, frame[at + 1]!, frame[at + 2]!];
}

/** The lit span, which is what "did it clip" and "is it centred" both come down to. */
function litColumns(frame: Uint8ClampedArray): { min: number; max: number } | null {
  let min = VIBE_SCREEN_WIDTH;
  let max = -1;
  for (let y = 0; y < VIBE_SCREEN_HEIGHT; y += 1) {
    for (let x = 0; x < VIBE_SCREEN_WIDTH; x += 1) {
      const [r, g, b] = pixelAt(frame, x, y);
      if (r + g + b === 0) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }
  return max < 0 ? null : { min, max };
}

describe("drawVibeScreen — 52x16, the layout the firmware reuses", () => {
  test("the offline page names the state instead of going dark", () => {
    const frame = drawVibeScreen({ kind: "offline" });
    expect(frame).toHaveLength(VIBE_SCREEN_WIDTH * VIBE_SCREEN_HEIGHT * 4);
    const lit = litColumns(frame)!;
    // Two centred lines, so the margins match to within the odd pixel.
    expect(Math.abs(lit.min - (VIBE_SCREEN_WIDTH - 1 - lit.max))).toBeLessThanOrEqual(1);
    // AI USAGE is muted, NO LOGIN amber — the second line is the one that says
    // there is something to do about it.
    expect(pixelAt(frame, lit.min, 9)).toEqual([255, 204, 0]);
  });

  test("a lone agent's cell is centred, mark and numbers together", () => {
    const frame = drawVibeScreen({ kind: "overview", agents: [screenAgent("claude", [41, 93])] });
    // 10px mark + 2px gap + an 11px "93%" column = 23, centred in 52.
    expect(litColumns(frame)).toEqual({ min: 14, max: 36 });
  });

  test("two saturated agents keep the panel instead of clipping", () => {
    const frame = drawVibeScreen({
      kind: "overview",
      agents: [screenAgent("claude", [100, 100]), screenAgent("codex", [100, 100])],
    });
    const lit = litColumns(frame)!;
    // The ladder drops the % sign rather than the second cell: 23 + 3 + 23 = 49.
    expect(lit.max).toBeLessThanOrEqual(VIBE_SCREEN_WIDTH - 1);
    expect(lit).toEqual({ min: 1, max: 49 });
  });

  test("an agent with no rows draws NO DATA, never a zero", () => {
    const frame = drawVibeScreen({ kind: "overview", agents: [screenAgent("claude", [])] });
    // The neutral gauge mark plus grey text — no vendor is named, because none
    // has anything to say.
    expect(litColumns(frame)).not.toBeNull();
    expect(pixelAt(frame, 51, 0)).toEqual([0, 0, 0]);
  });

  test("a vendor standing on old numbers lights the corner pixel, and only then", () => {
    const fresh = drawVibeScreen({ kind: "agent", agent: screenAgent("claude", [41]) });
    expect(pixelAt(fresh, VIBE_SCREEN_WIDTH - 1, 0)).toEqual([0, 0, 0]);
    const stale = drawVibeScreen({
      kind: "agent",
      agent: screenAgent("claude", [41], { stale: true }),
    });
    expect(pixelAt(stale, VIBE_SCREEN_WIDTH - 1, 0)).toEqual([255, 204, 0]);
  });

  test("the detail page meters from the ceiling and right-aligns the value", () => {
    const frame = drawVibeScreen({ kind: "agent", agent: screenAgent("claude", [41]) });
    // 14px track from x=19; round(0.41*14) = 6 filled cells, then the track.
    expect(pixelAt(frame, 19, 5)).toEqual([10, 132, 255]);
    expect(pixelAt(frame, 24, 5)).toEqual([10, 132, 255]);
    expect(pixelAt(frame, 25, 5)).toEqual([40, 44, 52]);
    // The value ends at the last column of the panel.
    expect(litColumns(frame)!.max).toBe(VIBE_SCREEN_WIDTH - 1);
  });

  test("the two severity bands are the list's, on the meter and on the number", () => {
    const warning = drawVibeScreen({ kind: "agent", agent: screenAgent("claude", [80]) });
    expect(pixelAt(warning, 19, 5)).toEqual([255, 204, 0]);
    expect(pixelAt(warning, 51, 5)).toEqual([255, 204, 0]);
    const critical = drawVibeScreen({ kind: "agent", agent: screenAgent("claude", [93]) });
    expect(pixelAt(critical, 19, 5)).toEqual([255, 69, 58]);
    expect(pixelAt(critical, 51, 5)).toEqual([255, 69, 58]);
    const normal = drawVibeScreen({ kind: "agent", agent: screenAgent("claude", [79]) });
    expect(pixelAt(normal, 19, 5)).toEqual([10, 132, 255]);
    expect(pixelAt(normal, 51, 5)).toEqual([255, 255, 255]);
  });

  test("a metric with no ceiling gets no bar — a meter would invent the limit", () => {
    const agent: VibeScreenAgent = {
      ...screenAgent("claude", [820]),
      metrics: [{ label: "Credits", used: 820, limit: 0, resetSec: -1 }],
    };
    const frame = drawVibeScreen({ kind: "agent", agent });
    for (let x = 19; x < 19 + 14; x += 1) {
      expect(pixelAt(frame, x, 7)).toEqual([0, 0, 0]);
    }
    // …and the bare number is still there, white, ending at the panel edge.
    expect(litColumns(frame)!.max).toBe(VIBE_SCREEN_WIDTH - 1);
  });
});

describe("上屏 — VIBE is an app on the clock, not a channel", () => {
  const displayMarkup = (firmwareMode: "official" | "music" | "arcade" | "zos") =>
    renderToStaticMarkup(createElement(
      CladdProvider,
      null,
      createElement(VibeDisplay, { firmwareMode }),
    ));

  test("the focus id is the one the service puts in the ZOS menu", () => {
    expect(VIBE_ZOS_FOCUS).toBe("vibe");
  });

  test("under ZOS the section hands over the knob", () => {
    const html = displayMarkup("zos");
    expect(html).toContain("在时钟上打开");
    // The app is called VIBE on the panel too — the console must name the same
    // thing the user turns the knob to.
    expect(html).toContain("VIBE");
    expect(html).not.toContain("需要 ZOS 系统固件");
  });

  test("anywhere else it says so plainly, with no channel fallback", () => {
    const html = displayMarkup("official");
    expect(html).toContain("需要 ZOS 系统固件");
    expect(html).toContain("官方固件");
    expect(html).not.toContain("在时钟上打开");
    // The removed half must not come back as a suggestion either.
    expect(html).not.toContain("频道");
  });

  test("a sideloaded firmware is named as itself, not lumped in with 官方", () => {
    expect(displayMarkup("music")).toContain("音乐固件");
    expect(displayMarkup("arcade")).toContain("游戏固件");
  });
});

describe("the view is wired into the shell", () => {
  test("globals.css gives the tab a full-bleed layout and a phone column", async () => {
    const css = await Bun.file(new URL("../web/src/styles/globals.css", import.meta.url)).text();
    expect(css).toContain(".studio-layout.is-vibe { display: block; min-height: 0; overflow-y: auto; }");
    expect(css).toMatch(/@media \(max-width: 52rem\)[\s\S]*?\.studio-layout\.is-zos, \.studio-layout\.is-vibe/);
  });

  test("the placement rules left with the placement section", async () => {
    const css = await Bun.file(new URL("../web/src/styles/globals.css", import.meta.url)).text();
    expect(css).toContain(".vibe-display {");
    // The canvas needs the same pixelated upscale the mirror gets; without this
    // rule the 52x16 buffer renders as a 52 px postage stamp.
    expect(css).toContain(".vibe-screen canvas");
    expect(css).not.toContain(".vibe-placement");
    expect(css).not.toContain(".vibe-picker");
  });
});

// Regressions from the adversarial review pass.
describe("review regressions", () => {
  test("a missing used only backfills from utilization on percent units", () => {
    expect(formatVibeValue(metric({ used: undefined, utilization: 0.42 }))).toBe("42%");
    expect(formatVibeValue(metric({ used: undefined, utilization: 0.42, unit: "requests" }))).toBeNull();
    expect(formatVibeValue(metric({ used: undefined, utilization: 0.42, unit: "usd" }))).toBeNull();
  });
});
