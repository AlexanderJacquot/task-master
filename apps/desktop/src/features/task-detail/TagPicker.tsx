import { Popover } from "radix-ui";
import { useMemo, useState } from "react";
import { Chip, cx, FOCUS, INPUT, MENU, MENU_ITEM } from "../../components/ui";
import type { Tag, Task } from "../../lib/types";
import { createTagOnTask, setTagged } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { GHOST, PILL, SET } from "./pill";

/**
 * Task tags as chips, plus a popover to toggle existing tags or create one. `pill`: the
 * full page's look, tags flowing in the parent's row of property pills.
 */
export function TagPicker({ task, variant = "chips" }: { task: Task; variant?: "chips" | "pill" }) {
  const pill = variant === "pill";
  const store = useTaskStore();
  const tags = useStoreState((s) => s.tags);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const name = query.trim().replace(/^#/, "");
  const sorted = useMemo(
    () => Object.values(tags).sort((a, b) => a.name.localeCompare(b.name)),
    [tags],
  );
  const matches = sorted.filter((t) => t.name.toLowerCase().includes(name.toLowerCase()));
  const exact = sorted.find((t) => t.name.toLowerCase() === name.toLowerCase());

  const toggle = (tag: Tag) =>
    void setTagged(store, task.id, tag.id, !task.tag_ids.includes(tag.id));
  const create = () => {
    if (!name || exact || /\s/.test(name)) return;
    void createTagOnTask(store, task.id, name);
    setQuery("");
  };

  return (
    <div className={pill ? "contents" : "flex flex-wrap items-center gap-1"}>
      {task.tag_ids.map((id) => {
        const tag = tags[id];
        if (!tag) return null;
        const remove = (
          <button
            key="remove"
            type="button"
            aria-label={`Remove tag ${tag.name}`}
            onClick={() => void setTagged(store, task.id, id, false)}
            className={
              pill
                ? "-mr-1.5 w-3 text-ink-3 opacity-0 group-hover/tag:opacity-100 hover:text-danger focus-visible:opacity-100"
                : "rounded text-ink-3 hover:text-danger"
            }
          >
            ×
          </button>
        );
        return pill ? (
          <span key={id} className={cx(PILL, SET, "group/tag")}>
            #{tag.name}
            {remove}
          </span>
        ) : (
          <Chip key={id}>
            #{tag.name}
            {remove}
          </Chip>
        );
      })}
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <Popover.Trigger
          className={
            pill
              ? cx(PILL, GHOST)
              : cx(
                  "inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-ink-3 hover:bg-hover hover:text-ink data-[state=open]:bg-selected",
                  FOCUS,
                )
          }
        >
          <Plus size={13} /> Tag
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            aria-label="Task tags"
            sideOffset={6}
            collisionPadding={12}
            className={cx(MENU, "w-64 max-w-[calc(100vw-1.5rem)] p-2")}
          >
            <div className="relative mb-2">
              <Search
                size={14}
                className="pointer-events-none absolute top-2.5 left-2.5 text-ink-3"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (exact) toggle(exact);
                  else create();
                }}
                placeholder="Find or create…"
                aria-label="Tag name"
                className={cx(INPUT, "pl-8 text-[13px]")}
              />
            </div>
            <ul className="max-h-48 space-y-0.5 overflow-y-auto">
              {matches.map((tag) => (
                <li key={tag.id}>
                  <button
                    type="button"
                    aria-pressed={task.tag_ids.includes(tag.id)}
                    onClick={() => toggle(tag)}
                    className={cx(
                      MENU_ITEM,
                      "w-full cursor-pointer hover:bg-accent/10 focus-visible:bg-accent/10 aria-pressed:bg-accent/8",
                    )}
                  >
                    <Hash size={14} />
                    <span className="min-w-0 flex-1 truncate text-left">{tag.name}</span>
                    {task.tag_ids.includes(tag.id) && <Check size={14} className="text-accent!" />}
                  </button>
                </li>
              ))}
              {name && !exact && (
                <li>
                  <button
                    type="button"
                    onClick={create}
                    disabled={/\s/.test(name)}
                    className={cx(
                      MENU_ITEM,
                      "w-full cursor-pointer text-accent hover:bg-accent/10 focus-visible:bg-accent/10 disabled:cursor-default disabled:text-ink-3",
                    )}
                  >
                    <Plus size={14} />
                    {/\s/.test(name) ? "Tags cannot contain spaces" : `Create #${name}`}
                  </button>
                </li>
              )}
            </ul>
            {!sorted.length && !name && (
              <p className="px-2 py-3 text-center text-xs text-ink-3">
                Type a name to create your first tag.
              </p>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

import { Check, Hash, Plus } from "lucide-react";
import { SearchIcon as Search } from "../../components/TaskIcons";
