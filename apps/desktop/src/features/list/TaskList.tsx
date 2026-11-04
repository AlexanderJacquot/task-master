import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { Dot } from "../../components/ui";
import type { Row } from "../../lib/views";
import { type RowHandlers, type RowLookups, TaskRow } from "./TaskRow";

interface Props extends RowHandlers, RowLookups {
  rows: Row[];
  selectedId: string | null;
  collapsedTasks: ReadonlySet<string>;
  onToggleGroup(statusId: string): void;
}

const ROW_HEIGHT = 36;
const GROUP_HEIGHT = 32;

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
      return row.type === "group" ? `g:${row.status.id}` : `t:${row.task.id}`;
    },
    overscan: 12,
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
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
                  onClick={() => onToggleGroup(row.status.id)}
                  className="flex h-8 w-full items-center gap-2 bg-neutral-50 px-3 text-left text-xs font-semibold text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400"
                >
                  <span className="w-3">{row.collapsed ? "▸" : "▾"}</span>
                  <Dot color={row.status.color} />
                  {row.status.name}
                  <span className="font-normal text-neutral-400">{row.count}</span>
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
