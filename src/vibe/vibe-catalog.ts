/**
 * The provider catalog, transcribed from OpenUsage's own ProviderCatalog.
 *
 * Four agents: the two established CLIs first, then the rest by display name.
 * It is the order the Customize list, the menu-bar strip and our GUI all render
 * in, so it lives in one array rather than being re-derived.
 *
 * `percentKeys` is the metric order a provider's detail page and the metricA/
 * metricB selects offer; `defaultStarred` mirrors DefaultLayout.pinnedMetricIDs
 * (grok/opencode are absent from theirs, so each takes its own primary metric in
 * the same spirit). `metricLabels` carries every exported /v1/limits resource
 * key, percent or not — a key we have no label for keeps its raw name rather
 * than disappearing, because upstream may add resources before we do.
 */
export interface VibeCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  /** 1-based position in the OpenUsage catalog; the GUI sorts on it. */
  readonly order: number;
  readonly percentKeys: readonly string[];
  readonly defaultStarred: readonly string[];
  readonly metricLabels: Readonly<Record<string, string>>;
}

const ENTRIES: readonly Omit<VibeCatalogEntry, "order">[] = [
  {
    id: "claude",
    displayName: "Claude",
    percentKeys: ["session", "weekly", "sonnet", "fable"],
    defaultStarred: ["session", "weekly"],
    metricLabels: {
      session: "Session",
      weekly: "Weekly",
      sonnet: "Sonnet",
      fable: "Fable",
      extraUsage: "Extra Usage",
    },
  },
  {
    id: "codex",
    displayName: "Codex",
    percentKeys: ["session", "weekly", "spark", "sparkWeekly"],
    defaultStarred: ["session", "weekly"],
    metricLabels: {
      session: "Session",
      weekly: "Weekly",
      spark: "Spark",
      sparkWeekly: "Spark Weekly",
      // One OpenUsage row ("$32.84 · 821 credits") exports as two scalars, and
      // both carry the same UI label there; the LED tells them apart by glyph.
      credits: "Credits",
      creditValue: "Credits",
      rateLimitResets: "Rate Limit Resets",
    },
  },
  {
    id: "grok",
    displayName: "Grok",
    percentKeys: ["weekly"],
    defaultStarred: ["weekly"],
    metricLabels: { weekly: "Weekly" },
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    percentKeys: ["session", "weekly", "monthly"],
    defaultStarred: ["session", "weekly"],
    metricLabels: { session: "Session", weekly: "Weekly", monthly: "Monthly" },
  },
];

export const VIBE_CATALOG: readonly VibeCatalogEntry[] = ENTRIES.map((entry, index) => ({
  ...entry,
  order: index + 1,
}));

const BY_ID = new Map(VIBE_CATALOG.map((entry) => [entry.id, entry]));

export function getVibeProvider(providerId: string): VibeCatalogEntry | undefined {
  return BY_ID.get(providerId);
}

export function isVibeProviderId(value: unknown): value is string {
  return typeof value === "string" && BY_ID.has(value);
}

/** The UI label OpenUsage gives a resource key; an unknown key keeps its own name. */
export function vibeMetricLabel(providerId: string, key: string): string {
  return BY_ID.get(providerId)?.metricLabels[key] ?? key;
}

/**
 * One glyph per metric, for the detail page's row heads.
 *
 * 37 px of row is not enough for "Spark Weekly", so each metric gets a letter
 * the way a spreadsheet column does. Across the four agents every key the
 * adapters actually emit now takes a distinct letter, so no page can show the
 * same letter twice — and a key added upstream before this table learns it
 * falls back to its own initial rather than borrowing someone else's.
 */
export const VIBE_METRIC_LED_LABELS: Readonly<Record<string, string>> = {
  session: "S",
  weekly: "W",
  monthly: "M",
  sonnet: "N",
  fable: "F",
  spark: "K",
  sparkWeekly: "X",
  credits: "C",
  creditValue: "V",
  extraUsage: "E",
  rateLimitResets: "R",
};

export function vibeMetricLedLabel(key: string): string {
  const mapped = VIBE_METRIC_LED_LABELS[key];
  if (mapped) return mapped;
  const initial = key.replace(/[^A-Za-z]/g, "").charAt(0);
  return initial ? initial.toUpperCase() : "?";
}

/** Every catalog provider's default stars, as the merge base for the store. */
export function defaultVibeStarred(): Record<string, string[]> {
  return Object.fromEntries(VIBE_CATALOG.map((entry) => [entry.id, [...entry.defaultStarred]]));
}

/**
 * The union of every provider's primary metric keys, catalog order, deduped —
 * the choice list behind the detail page's metricA/metricB selects. One flat
 * list because the option editor is schema-driven and cannot narrow a select
 * on a sibling field's value; a key the chosen provider does not export simply
 * falls back to the auto sequence at render time.
 */
export const VIBE_METRIC_CHOICE_KEYS: readonly string[] = [
  ...new Set(VIBE_CATALOG.flatMap((entry) => entry.percentKeys)),
];
