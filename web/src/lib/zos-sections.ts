// The device's root ring, rebuilt on the console side.
//
// osLogic.cc fixes four entries — 音乐 / 游戏 / 轮播 / 设置 — and says why:
// "The workspace's channels are content, not destinations — they live one level
// down, under 轮播, the same way the seven games live under 游戏."
//
// The service's pull document is flat (every enabled channel, plus music / game
// / settings) because that is the shape the firmware wants to consume. The
// console used to render that flat list verbatim, which put ten channels and
// three destinations on one level and left the reader to rebuild the hierarchy
// in their head. This module does that rebuild once, in one place, so the panel
// can render the device's own two levels instead of the wire format.

import {
  ZOS_GAME_SHORTCUTS,
  entryOnScreen,
  zosGameFocus,
  type ZosDisplay,
  type ZosMenuEntry,
  type ZosTelemetry,
} from "./zos-link";

export type ZosSectionId = "music" | "games" | "carousel" | "settings";

/** The ring's own order, as the firmware pushes the four entries. */
export const ZOS_SECTION_ORDER: readonly ZosSectionId[] = ["music", "games", "carousel", "settings"];

/**
 * What a row does when clicked. `focus` is a device destination — the same
 * string the firmware matches against; `provision` is console-only (the BLE
 * wizard has no counterpart in the pull document, but it is a setting, so this
 * is where a person looks for it).
 */
export type ZosSectionAction =
  | { type: "focus"; focus: string }
  | { type: "provision" };

export interface ZosSectionRow {
  key: string;
  label: string;
  action: ZosSectionAction;
  /** The console's last accepted command pinned the device here. */
  pinned: boolean;
  /** The device's own report says this is what is on the panel. */
  onScreen: boolean;
  /** Second line, only where the row's name is not the whole story. */
  footer: string | null;
}

/**
 * The one marker a row may wear.
 *
 * 已固定 outranks 正在显示 because it is the stronger claim: a pinned row that
 * the device has reached is both, and saying so twice on one row is the
 * redundancy this panel exists to remove.
 */
export type ZosMarker = "pinned" | "onScreen";

export interface ZosSection {
  id: ZosSectionId;
  label: string;
  /**
   * A leaf pins from its own row; a container discloses its rows and pins from
   * them. 音乐 is a leaf because the device has nothing under it — the other
   * three all carry a level below.
   */
  leaf: boolean;
  /** Set on a leaf; containers pin through their rows. */
  focus: string | null;
  /** Pinned here, or on any row inside — a collapsed section still says so. */
  pinned: boolean;
  /** The device reports it is inside this destination. */
  onScreen: boolean;
  footer: string | null;
  rows: ZosSectionRow[];
}

export interface ZosSectionInput {
  menu: ZosMenuEntry[];
  display: ZosDisplay;
  telemetry: ZosTelemetry | null;
  /** The service's liveness verdict; offline, nothing may claim to be on screen. */
  live: boolean;
  /** Whether this browser can run the BLE wizard at all. */
  bleAvailable: boolean;
}

/**
 * The four destinations, each carrying whatever lives one level under it.
 *
 * Sections whose backing menu entry is missing are dropped rather than shown
 * dead: the menu comes from the service, and a service that does not offer
 * 音乐 has no music page for the console to point at.
 */
export function describeSections(input: ZosSectionInput): ZosSection[] {
  // Offline nothing may claim to be on screen: the last report and a current
  // one are indistinguishable once the device stops talking.
  const telemetry = input.live ? input.telemetry : null;
  const pinnedFocus = input.display.pinned ? input.display.focus : null;
  const pinnedOn = (focus: string): boolean => pinnedFocus === focus;

  const byKind = (kind: ZosMenuEntry["kind"]): ZosMenuEntry | undefined =>
    input.menu.find((entry) => entry.kind === kind);

  const sections: ZosSection[] = [];

  for (const id of ZOS_SECTION_ORDER) {
    if (id === "music") {
      const entry = byKind("music");
      if (!entry) continue;
      sections.push({
        id,
        label: entry.label,
        leaf: true,
        focus: entry.id,
        pinned: pinnedOn(entry.id),
        onScreen: entryOnScreen(entry, telemetry),
        // No footer: 音乐 has nothing under it, and what it is doing is the
        // marker's job — a footer saying so too is the same fact on one line,
        // twice.
        footer: null,
        rows: [],
      });
      continue;
    }

    if (id === "games") {
      const entry = byKind("game");
      if (!entry) continue;
      // Plain `game` only pushes the games ring; `game:<id>` also enters the
      // engine (both measured on hardware — see zosGameFocus).
      const rows: ZosSectionRow[] = [
        {
          key: "games:list",
          label: "游戏列表",
          action: { type: "focus", focus: entry.id },
          pinned: pinnedOn(entry.id),
          onScreen: telemetry?.screen === "games",
          footer: "停在选游戏的那一环",
        },
        ...ZOS_GAME_SHORTCUTS.map((game): ZosSectionRow => {
          const focus = zosGameFocus(game.id);
          return {
            key: focus,
            label: game.label,
            action: { type: "focus", focus },
            pinned: pinnedOn(focus),
            // The firmware reports `screen: "game"` without naming the engine,
            // so no row may claim to be the one running.
            onScreen: false,
            footer: null,
          };
        }),
      ];
      sections.push({
        id,
        label: entry.label,
        leaf: false,
        focus: null,
        pinned: rows.some((row) => row.pinned),
        onScreen: entryOnScreen(entry, telemetry),
        // The footer says what is *in* here, never what the device is doing:
        // that is the marker's single job, and sectionMarker decides which of
        // the two levels gets to say it.
        footer: `${ZOS_GAME_SHORTCUTS.length} 个游戏，点按直达`,
        rows,
      });
      continue;
    }

    if (id === "carousel") {
      const channels = input.menu.filter((entry) => entry.kind === "channel");
      if (channels.length === 0) continue;
      const rows = channels.map((entry): ZosSectionRow => ({
        key: entry.id,
        label: entry.label,
        action: { type: "focus", focus: entry.id },
        pinned: pinnedOn(entry.id),
        onScreen: entryOnScreen(entry, telemetry),
        footer: null,
      }));
      sections.push({
        // 轮播 is the one destination with no focus of its own: it is what the
        // device does when nothing is pinned, so "go to 轮播" is 交还旋钮.
        id,
        label: "轮播",
        leaf: false,
        focus: null,
        pinned: rows.some((row) => row.pinned),
        onScreen: rows.some((row) => row.onScreen),
        // The channel that is showing names itself, on its own row. Naming it
        // here as well put the same sentence on screen twice.
        footer: `${rows.length} 个频道`,
        rows,
      });
      continue;
    }

    const entry = byKind("settings");
    if (!entry) continue;
    const onScreen = entryOnScreen(entry, telemetry);
    const rows: ZosSectionRow[] = [
      {
        key: "settings:device",
        label: "设备设置页",
        action: { type: "focus", focus: entry.id },
        pinned: pinnedOn(entry.id),
        onScreen,
        footer: "亮度、音量与网络信息，显示在时钟面板上",
      },
    ];
    if (input.bleAvailable) {
      rows.push({
        key: "settings:provision",
        label: "蓝牙配网",
        action: { type: "provision" },
        pinned: false,
        onScreen: false,
        footer: "换了路由器或密码时，用蓝牙重新连一次",
      });
    }
    sections.push({
      id,
      label: entry.label,
      leaf: false,
      focus: null,
      pinned: rows.some((row) => row.pinned),
      onScreen,
      footer: null,
      rows,
    });
  }

  return sections;
}

/** What a row wears on its right edge — a command echo, or a device report. */
export function rowMarker(row: ZosSectionRow): ZosMarker | null {
  if (row.pinned) return "pinned";
  if (row.onScreen) return "onScreen";
  return null;
}

/**
 * What a section's own trigger wears.
 *
 * One fact, one place: the most specific row that can state a fact states it,
 * and the trigger only speaks when no visible row can. That leaves the trigger
 * exactly two jobs — a collapsed section, whose rows are not on screen at all,
 * and a running game, which the firmware reports without naming the engine, so
 * no row inside 游戏 is allowed to claim it.
 */
export function sectionMarker(section: ZosSection, open: boolean): ZosMarker | null {
  // A leaf is its own row; there is no level below to defer to.
  if (section.leaf) {
    if (section.pinned) return "pinned";
    return section.onScreen ? "onScreen" : null;
  }
  if (section.pinned && !(open && section.rows.some((row) => row.pinned))) return "pinned";
  if (section.onScreen && !(open && section.rows.some((row) => row.onScreen))) return "onScreen";
  return null;
}

/** The PUT a click on a menu row asks for, and the receipt it earns. */
export interface ZosPinIntent {
  focus: string | null;
  pinned: boolean;
  /** Toast title — only what has already happened once the service accepts. */
  title: string;
  /** Toast detail, or null when there is nothing further to promise. */
  detail: string | null;
}

/**
 * Clicking a menu row.
 *
 * The rows are toggles: a second click on the pinned row is the way back, so
 * the same button that took the knob hands it back. 「设备已固定在…」would be
 * said too early — the PUT only reaches the service, and the device switches on
 * its next pull (measured 2–7 s on hardware), so the receipt promises the pull
 * and the status strip changes its wording once a heartbeat confirms it.
 */
export function pinIntent(row: {
  label: string;
  focus: string;
  pinned: boolean;
}): ZosPinIntent {
  if (row.pinned) {
    return { focus: null, pinned: false, title: "已交还旋钮", detail: null };
  }
  return {
    focus: row.focus,
    pinned: true,
    title: `已固定「${row.label}」`,
    // `game:<id>` enters the engine; plain `game` only reaches the ring.
    detail: row.focus.startsWith("game:")
      ? "时钟下次拉取状态时直接进入游戏。"
      : "时钟下次拉取状态时切过去，通常几秒内。",
  };
}

/**
 * Which section to expand first.
 *
 * Whatever holds the pin, so a collapsed accordion never hides the one row the
 * console is currently commanding; 轮播 otherwise, because switching channels
 * is the thing people open this panel to do and it should cost zero clicks.
 */
export function defaultOpenSection(sections: ZosSection[]): ZosSectionId | undefined {
  const pinned = sections.find((section) => section.pinned && !section.leaf);
  if (pinned) return pinned.id;
  const carousel = sections.find((section) => section.id === "carousel");
  if (carousel) return carousel.id;
  return sections.find((section) => !section.leaf)?.id;
}
