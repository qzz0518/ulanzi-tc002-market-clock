import { useId, useState, type ReactNode } from "react";
import {
  ChevronDown,
  Gamepad2,
  Gauge,
  LayoutGrid,
  Music2,
  Pin,
  Radio,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import {
  Chip,
  List,
  ListButton,
  ListItem,
  Spinner,
} from "@cladd-ui/react";
import {
  rowMarker,
  sectionMarker,
  type ZosMarker,
  type ZosSection,
  type ZosSectionId,
  type ZosSectionRow,
} from "@/lib/zos-sections";
import { Disclosure } from "@/components/disclosure";

const SECTION_ICONS: Record<ZosSectionId, LucideIcon> = {
  music: Music2,
  games: Gamepad2,
  carousel: LayoutGrid,
  // The same Gauge the top-level VIBE tab wears, deliberately: this row and
  // that tab are two doors into one thing, and giving them different icons is
  // how a reader learns they are not.
  vibe: Gauge,
  settings: Settings2,
};

export interface ZosPinTarget {
  label: string;
  focus: string;
  pinned: boolean;
}

export interface ZosMenuProps {
  /** The device's root ring, already rebuilt — see describeSections. */
  sections: ZosSection[];
  /** Controlled open section; `undefined` is everything closed. */
  open: string | undefined;
  onOpenChange: (value: string | undefined) => void;
  /** A display write is in flight, so no row may queue a second one. */
  busy: boolean;
  /**
   * The focus of the row whose write has been in flight long enough to show
   * (the panel delays it, so a fast write shows nothing); that row spins.
   */
  pending?: string | null;
  /** Why the menu is empty, when it is. */
  emptyLabel: string;
  onPin: (target: ZosPinTarget) => void;
}

/**
 * The device's own menu, rendered.
 *
 * Presentational on purpose: every derivation it needs — the five sections,
 * which of them is open, which row wears which marker — is decided in
 * `lib/zos-sections.ts`, so this file holds nothing a test would have to boot a
 * browser to reach, and the structure below can be rendered from a fixture.
 */
export function ZosMenu({
  sections,
  open,
  onOpenChange,
  busy,
  pending = null,
  emptyLabel,
  onPin,
}: ZosMenuProps) {
  return (
    <List className="zc-menu__list">
      {sections.length === 0 && (
        <ListItem>
          <span className="text-cladd-fg-soft">{emptyLabel}</span>
        </ListItem>
      )}
      {/* 单开：与设备一次只显示一环同构，也让侧栏不会长到要翻页。 */}
      {sections.map((section) => {
        const Icon = SECTION_ICONS[section.id];
        const marker = sectionMarker(section, open === section.id);
        if (section.leaf && section.focus !== null) {
          const focus = section.focus;
          return (
            <ListButton
              key={section.id}
              size="md"
              // Brand only on the pinned row: tinting every row green left the
              // menu with no way to say which one is live.
              color={section.pinned ? "brand" : undefined}
              selected={section.pinned}
              icon={<Icon aria-hidden="true" />}
              footer={section.footer ?? undefined}
              after={rowAfter(marker, pending === focus, "md")}
              // 行本身是开关：再点一次就是取消固定。所以状态挂 aria-pressed，
              // 名字直接由行内文字（含标记）算出来——写死一个 aria-label 会把
              // 「已固定」「正在显示」和 footer 全盖掉，固定之后还会把动作说反。
              aria-pressed={section.pinned}
              aria-disabled={busy || undefined}
              aria-busy={pending === focus || undefined}
              onClick={() => {
                if (!busy) onPin({ label: section.label, focus, pinned: section.pinned });
              }}
            >
              {section.label}
            </ListButton>
          );
        }
        return (
          <ZosMenuSection
            key={section.id}
            section={section}
            icon={Icon}
            marker={marker}
            open={open === section.id}
            onToggle={() => onOpenChange(open === section.id ? undefined : section.id)}
            busy={busy}
            pending={pending}
            onPin={onPin}
          />
        );
      })}
    </List>
  );
}

interface ZosMenuSectionProps {
  section: ZosSection;
  icon: LucideIcon;
  marker: ZosMarker | null;
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  pending: string | null;
  onPin: (target: ZosPinTarget) => void;
}

/**
 * One section of the ring and its rows, opened in place with the shared
 * `<Disclosure>`. Lazy: a section that was never opened is not in the markup at
 * all; once opened its rows stay mounted (inert while closed).
 */
function ZosMenuSection({ section, icon: Icon, marker, open, onToggle, busy, pending, onPin }: ZosMenuSectionProps) {
  const id = useId();
  const triggerId = `${id}-trigger`;
  const panelId = `${id}-panel`;
  // Mirrors the lazy Disclosure's own first mount, so aria-controls never names
  // a panel that is not in the document yet.
  const [everOpened, setEverOpened] = useState(open);
  if (open && !everOpened) setEverOpened(true);
  return (
    <>
      <ListButton
        id={triggerId}
        size="md"
        icon={<Icon aria-hidden="true" />}
        footer={section.footer ?? undefined}
        after={
          <span className="zc-menu__after">
            {markerChip(marker)}
            <ChevronDown aria-hidden="true" className="zc-menu__chevron disclosure-chevron" data-open={open} />
          </span>
        }
        aria-expanded={open}
        aria-controls={everOpened ? panelId : undefined}
        onClick={onToggle}
      >
        {section.label}
      </ListButton>
      {/* 不再套一层 role="group"：这一块自己就是 region，名字取自上面那个触发器，
          再加一个组名就是同一件事说两遍——而且「点按固定」对 设置 里的配网那一行
          还是错的。 */}
      <Disclosure
        open={open}
        lazy
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        bodyClassName="zc-sub"
      >
        {section.rows.map((row) => (
          <ZosMenuRow key={row.key} row={row} busy={busy} waiting={pending === row.focus} onPin={onPin} />
        ))}
      </Disclosure>
    </>
  );
}

interface ZosMenuRowProps {
  row: ZosSectionRow;
  busy: boolean;
  /** This row asked for the write in flight, and it is taking its time. */
  waiting: boolean;
  onPin: (target: ZosPinTarget) => void;
}

// 每一行都是设备上的一个去处，所以都是开关、都发指令、都被设备写入的 busy 挡住。
// 唯一的例外（蓝牙配网，开的是这台浏览器里的向导）已经搬进常规设置。
// busy 用 aria-disabled + 点击守卫，而不是 disabled：cladd 的 disabled 会把整列
// 二十来行同时压到 40% 透明度，每次点按都闪一下。忙的样子只有两处：整列的光标
// （zos-console.css），和写入慢下来时被点那一行的转圈。
function ZosMenuRow({ row, busy, waiting, onPin }: ZosMenuRowProps) {
  return (
    <ListButton
      size="sm"
      color={row.pinned ? "brand" : undefined}
      selected={row.pinned}
      footer={row.footer ?? undefined}
      after={rowAfter(rowMarker(row), waiting, "sm")}
      aria-pressed={row.pinned}
      aria-disabled={busy || undefined}
      aria-busy={waiting || undefined}
      onClick={() => {
        if (!busy) onPin({ label: row.label, focus: row.focus, pinned: row.pinned });
      }}
    >
      {row.label}
    </ListButton>
  );
}

/**
 * A pin row's trailing slot: its marker, led by a spinner while that row's
 * write is slow. The spinner is one step under the row, the nesting cladd's own
 * Button uses for its loading spinner (md row → sm, sm row → xs).
 */
function rowAfter(marker: ZosMarker | null, waiting: boolean, rowSize: "sm" | "md"): ReactNode | undefined {
  const chip = markerChip(marker);
  if (!waiting) return chip;
  return (
    <span className="zc-menu__after">
      <Spinner size={rowSize === "md" ? "sm" : "xs"} color="brand" className="zc-menu__spinner motion-enter" />
      {chip}
    </span>
  );
}

/**
 * 已固定 is a command echo — this console asked for it. 正在显示 is the device's
 * own report. Never both on one row: `rowMarker` / `sectionMarker` pick the one
 * that is worth saying, and whichever level says it, the other stays quiet.
 */
function markerChip(marker: ZosMarker | null): ReactNode | undefined {
  if (marker === "pinned") {
    return <Chip size="sm" color="brand" icon={Pin} iconProps={{ "aria-hidden": true }}>已固定</Chip>;
  }
  if (marker === "onScreen") {
    return (
      <Chip size="sm" color="brand" variant="transparent" icon={Radio} iconProps={{ "aria-hidden": true }}>
        正在显示
      </Chip>
    );
  }
  // undefined, not null: ListButton's `after` slot renders a wrapper for
  // anything it is handed, and an empty one still takes its gap.
  return undefined;
}
