/**
 * The adapter registry.
 *
 * Order matches `VIBE_CATALOG` so the console list, the limits snapshot and the
 * knob pages all agree on what "first" means. Adding a vendor is: write the
 * adapter, add it here and to the catalog — nothing else in the pipeline knows
 * vendors exist.
 */

import { antigravityAdapter } from "./antigravity.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { copilotAdapter } from "./copilot.ts";
import { cursorAdapter } from "./cursor.ts";
import { devinAdapter } from "./devin.ts";
import { grokAdapter } from "./grok.ts";
import { opencodeAdapter } from "./opencode.ts";
import { openrouterAdapter } from "./openrouter.ts";
import { zaiAdapter } from "./zai.ts";
import type { VibeProviderAdapter } from "./types.ts";

export const VIBE_ADAPTERS: readonly VibeProviderAdapter[] = [
  claudeAdapter,
  codexAdapter,
  cursorAdapter,
  antigravityAdapter,
  copilotAdapter,
  devinAdapter,
  grokAdapter,
  opencodeAdapter,
  openrouterAdapter,
  zaiAdapter,
];

export function getVibeAdapter(id: string): VibeProviderAdapter | undefined {
  return VIBE_ADAPTERS.find((adapter) => adapter.id === id);
}
