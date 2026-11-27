// Lucide's grip: the app's icon set has none yet.
import { GripVertical } from "lucide-react";
import { SortableList } from "../../components/SortableList";
import { Button, cx, FOCUS } from "../../components/ui";
import {
  SIDEBAR_PAGES,
  SIDEBAR_SECTIONS,
  type SidebarListKey,
  useSidebarLayout,
} from "../../lib/sidebarLayout";
import { Section } from "./SettingsPage";

const LABELS: Record<string, string> = Object.fromEntries(
  [...SIDEBAR_PAGES, ...SIDEBAR_SECTIONS].map((e) => [e.id, e.label]),
);

/** One of the sidebar's lists: drag the grip to reorder, untick to hide. */
function EntryList({ list, note }: { list: SidebarListKey; note?: Record<string, string> }) {
  const entries = useSidebarLayout((s) => s.layout[list]);
  const move = useSidebarLayout((s) => s.move);
  const setHidden = useSidebarLayout((s) => s.setHidden);
  return (
    <SortableList
      ids={entries.order as string[]}
      onMove={(id, over) => move(list, id, over)}
      className="flex max-w-sm flex-col"
    >
      {(id, row) => {
        const shown = !(entries.hidden as string[]).includes(id);
        return (
          <div
            className={cx(
              "flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover",
              row.dragging && "bg-raised shadow-md",
            )}
          >
            <button
              type="button"
              {...row.handleProps}
              aria-label={`Move ${LABELS[id]}`}
              title="Drag to reorder (or Space, then the arrow keys)"
              className={cx(
                "inline-flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-ink-3 hover:text-ink active:cursor-grabbing",
                FOCUS,
              )}
            >
              <GripVertical size={14} />
            </button>
            <label className={cx("flex flex-1 items-center gap-2", !shown && "text-ink-3")}>
              <input
                type="checkbox"
                checked={shown}
                onChange={(e) => setHidden(list, id, !e.target.checked)}
                className="size-4 shrink-0 cursor-pointer accent-accent"
              />
              {LABELS[id]}
              {note?.[id] && <span className="text-xs text-ink-3">{note[id]}</span>}
            </label>
          </div>
        );
      }}
    </SortableList>
  );
}

export function SidebarSettings() {
  const reset = useSidebarLayout((s) => s.reset);
  return (
    <>
      <Section
        title="Pages"
        hint="The links at the top of the sidebar. Drag them to reorder, here or in the sidebar itself; untick one to hide it. A hidden page stays reachable from its shortcut and from Jump to. Remembered on this computer."
      >
        <EntryList list="pages" />
      </Section>
      <Section
        title="Sections"
        hint="The folding sections under the pages. Drag them to reorder; untick one to hide it."
      >
        <EntryList list="sections" note={{ team: "(when you are in a team)" }} />
      </Section>
      <div className="pt-4">
        <Button size="sm" onClick={reset}>
          Back to the default sidebar
        </Button>
      </div>
    </>
  );
}
