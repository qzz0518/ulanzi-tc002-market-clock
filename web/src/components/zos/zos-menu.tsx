import type { ReactNode } from "react";
import {
  ChevronRight,
  Gamepad2,
  LayoutGrid,
  Music2,
  Pin,
  Radio,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import {
  AccordionIndicator,
  AccordionItem,
  AccordionPanel,
  AccordionRoot,
  AccordionTrigger,
  Chip,
  List,
  ListButton,
  ListItem,
} from "@cladd-ui/react";
import {
  rowMarker,
  sectionMarker,
  type ZosMarker,
  type ZosSection,
  type ZosSectionId,
  type ZosSectionRow,
} from "@/lib/zos-sections";

const SECTION_ICONS: Record<ZosSectionId, LucideIcon> = {
  music: Music2,
  games: Gamepad2,
  carousel: LayoutGrid,
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
  /** Why the menu is empty, when it is. */
  emptyLabel: string;
  onPin: (target: ZosPinTarget) => void;
}

/**
 * The device's own menu, rendered.
 *
 * Presentational on purpose: every derivation it needs — the four sections,
 * which of them is open, which row wears which marker — is decided in
 * `lib/zos-sections.ts`, so this file holds nothing a test would have to boot a
 * browser to reach, and the structure below can be rendered from a fixture.
 */
export function ZosMenu({
  sections,
  open,
  onOpenChange,
  busy,
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
      <AccordionRoot value={open} onValueChange={(value) => onOpenChange(value as string | undefined)}>
        {sections.map((section) => {
          const Icon = SECTION_ICONS[section.id];
          const marker = sectionMarker(section, open === section.id);
          if (section.leaf && section.focus !== null) {
            const focus = section.focus;
            return (
              <ListButton
                key={section.id}
                size="md"
                color="brand"
                selected={section.pinned}
                disabled={busy}
                icon={<Icon aria-hidden="true" />}
                footer={section.footer ?? undefined}
                after={markerChip(marker)}
                // 行本身是开关：再点一次就是取消固定。所以状态挂 aria-pressed，
                // 名字直接由行内文字（含标记）算出来——写死一个 aria-label 会把
                // 「已固定」「正在显示」和 footer 全盖掉，固定之后还会把动作说反。
                aria-pressed={section.pinned}
                onClick={() => onPin({ label: section.label, focus, pinned: section.pinned })}
              >
                {section.label}
              </ListButton>
            );
          }
          return (
            <AccordionItem key={section.id} value={section.id}>
              <AccordionTrigger>
                <ListButton
                  size="md"
                  color="brand"
                  icon={<Icon aria-hidden="true" />}
                  footer={section.footer ?? undefined}
                  after={
                    <span className="zc-menu__after">
                      {markerChip(marker)}
                      <AccordionIndicator className="text-cladd-fg-softer transition-transform data-[open]:rotate-90">
                        <ChevronRight className="size-3.5" />
                      </AccordionIndicator>
                    </span>
                  }
                >
                  {section.label}
                </ListButton>
              </AccordionTrigger>
              <AccordionPanel>
                {/* 不再套一层 role="group"：AccordionPanel 自己就是 region，名字
                    取自上面那个触发器，再加一个组名就是同一件事说两遍——而且
                    「点按固定」对 设置 里的配网那一行还是错的。 */}
                <div className="zc-sub">
                  {section.rows.map((row) => (
                    <ZosMenuRow key={row.key} row={row} busy={busy} onPin={onPin} />
                  ))}
                </div>
              </AccordionPanel>
            </AccordionItem>
          );
        })}
      </AccordionRoot>
    </List>
  );
}

interface ZosMenuRowProps {
  row: ZosSectionRow;
  busy: boolean;
  onPin: (target: ZosPinTarget) => void;
}

// 每一行都是设备上的一个去处，所以都是开关、都发指令、都被设备写入的 busy 挡住。
// 唯一的例外（蓝牙配网，开的是这台浏览器里的向导）已经搬进常规设置。
function ZosMenuRow({ row, busy, onPin }: ZosMenuRowProps) {
  return (
    <ListButton
      size="sm"
      color="brand"
      selected={row.pinned}
      disabled={busy}
      footer={row.footer ?? undefined}
      after={markerChip(rowMarker(row))}
      aria-pressed={row.pinned}
      onClick={() => onPin({ label: row.label, focus: row.focus, pinned: row.pinned })}
    >
      {row.label}
    </ListButton>
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
