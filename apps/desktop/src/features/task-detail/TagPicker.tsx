import { Popover } from "radix-ui";
import { useMemo, useState } from "react";
import { Chip } from "../../components/ui";
import type { Tag, Task } from "../../lib/types";
import { createTagOnTask, setTagged } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";

/** Task tags as chips, plus a popover to toggle existing tags or create one. */
export function TagPicker({ task }: { task: Task }) {
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
  const exact = sorted.some((t) => t.name.toLowerCase() === name.toLowerCase());

  const toggle = (tag: Tag) =>
    void setTagged(store, task.id, tag.id, !task.tag_ids.includes(tag.id));
  const create = () => {
    if (!name || exact || /\s/.test(name)) return;
    void createTagOnTask(store, task.id, name);
    setQuery("");
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {task.tag_ids.map((id) =>
        tags[id] ? (
          <Chip key={id}>
            #{tags[id].name}
            <button
              type="button"
              aria-label={`Remove tag ${tags[id].name}`}
              onClick={() => void setTagged(store, task.id, id, false)}
              className="hover:text-red-600"
            >
              ×
            </button>
          </Chip>
        ) : null,
      )}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger className="rounded px-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">
          + Tag
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={4}
            className="z-50 w-56 rounded-md border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const first = matches[0];
                if (exact && first) toggle(first);
                else create();
              }}
              placeholder="Find or create…"
              aria-label="Tag name"
              className="mb-2 w-full rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700"
            />
            <ul className="max-h-48 overflow-y-auto">
              {matches.map((tag) => (
                <li key={tag.id}>
                  <button
                    type="button"
                    onClick={() => toggle(tag)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    <span className="w-3">{task.tag_ids.includes(tag.id) ? "✓" : ""}</span>#
                    {tag.name}
                  </button>
                </li>
              ))}
              {name && !exact && (
                <li>
                  <button
                    type="button"
                    onClick={create}
                    disabled={/\s/.test(name)}
                    className="w-full rounded px-2 py-1 text-left text-blue-600 hover:bg-neutral-100 disabled:text-neutral-400 dark:hover:bg-neutral-800"
                  >
                    {/\s/.test(name) ? "Tags cannot contain spaces" : `Create #${name}`}
                  </button>
                </li>
              )}
            </ul>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
