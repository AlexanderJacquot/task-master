import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useRef } from "react";
import { Dot } from "../../components/ui";
import type { Row } from "../../lib/views";
import { type RowHandlers, type RowLookups, TaskRow } from "./TaskRow";

interface Props extends RowHandlers, RowLookups {
  rows: Row[];
  selectedId: string | null;
  collapsedTasks: ReadonlySet<string>;
  onToggleGroup(groupKey: string): void;
}

const ROW_HEIGHT = 36;
const GROUP_HEIGHT = 44;

/** Virtualized rows: only what is on screen is rendered, however long the list. */
export function TaskList({ rows, selectedId, collapsedTasks, onToggleGroup, ...rowProps }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === "group" ? GROUP_HEIGHT : ROW_HEIGHT),
    getItemKey: (i) => {
      const row = rows[i];
      if (!row) return i;
      return row.type === "group" ? `g:${row.group.key}` : `t:${row.task.id}`;
    },
    overscan: 12,
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pb-8">
      <ul style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <li
              key={item.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
            >
              {row.type === "group" ? (
                <button
                  type="button"
                  onClick={() => onToggleGroup(row.group.key)}
                  aria-expanded={!row.collapsed}
                  className="mx-6 flex h-full w-[calc(100%-3rem)] items-end gap-2.5 px-2 pb-1.5 text-left"
                >
                  <span className="mb-[3px] flex w-4 justify-center text-ink-3">
                    {row.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  </span>
                  <Dot color={row.group.color} className="mb-[5px]" />
                  <span className="font-display text-[15px] tracking-wide text-rubric">
                    {row.group.label}
                  </span>
                  <span className="mb-px text-[12.5px] text-ink-3 tabular-nums">{row.count}</span>
                  <span className="mb-[9px] h-px flex-1 bg-line" />
                </button>
              ) : (
                <TaskRow
                  {...rowProps}
                  task={row.task}
                  depth={row.depth}
                  childCount={row.childCount}
                  childDone={row.childDone}
                  visibleChildren={row.visibleChildren}
                  collapsed={collapsedTasks.has(row.task.id)}
                  selected={row.task.id === selectedId}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
