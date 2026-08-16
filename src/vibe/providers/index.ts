/**
 * The adapter registry.
 *
 * Order matches `VIBE_CATALOG` so the console list, the limits snapshot and the
 * knob pages all agree on what "first" means. Adding a vendor is: write the
 * adapter, add it here and to the catalog — nothing else in the pipeline knows
 * vendors exist.
 */

import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { grokAdapter } from "./grok.ts";
import { opencodeAdapter } from "./opencode.ts";
import type { VibeProviderAdapter } from "./types.ts";

export const VIBE_ADAPTERS: readonly VibeProviderAdapter[] = [
  claudeAdapter,
  codexAdapter,
  grokAdapter,
  opencodeAdapter,
];

export function getVibeAdapter(id: string): VibeProviderAdapter | undefined {
  return VIBE_ADAPTERS.find((adapter) => adapter.id === id);
}
