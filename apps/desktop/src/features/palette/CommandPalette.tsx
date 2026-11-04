import { useNavigate } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../components/ui";
import { type PaletteItem, rankItems } from "../../lib/palette";
import { useApi, useStoreState, useTaskStore } from "../../store/context";
import { useOpenTask } from "../shell/useOpenTask";
import { NEW_TASK_INPUT_ID } from "../shell/useShortcuts";

type Runnable = PaletteItem & { run(): void };

/**
 * Ctrl+K: jump to any view, project, epic, tag or task (full-text search over titles and
 * descriptions), or run an action. Arrow keys move, Enter runs, Escape closes.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const store = useTaskStore();
  const api = useApi();
  const navigate = useNavigate();
  const openTask = useOpenTask();
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const epics = useStoreState((s) => s.epics);
  const tags = useStoreState((s) => s.tags);
  const views = useStoreState((s) => s.views);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Full-text search, debounced; stale answers are dropped.
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api
        .search(text, 20)
        .then((ids) => live && setHits(ids))
        .catch(() => live && setHits([]));
    }, 80);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const go = useCallback(
    (to: string, params?: Record<string, string>, search: Record<string, string> = {}) => {
      close();
      void navigate({ to, params: params as never, search: search as never });
    },
    [close, navigate],
  );

  const items: Runnable[] = useMemo(() => {
    const list: Runnable[] = [
      {
        key: "action:new",
        group: "Actions",
        label: "New task",
        hint: "n",
        keywords: "add capture create",
        run: () => {
          close();
          requestAnimationFrame(() => document.getElementById(NEW_TASK_INPUT_ID)?.focus());
        },
      },
      {
        key: "action:plan",
        group: "Actions",
        label: "Plan my day",
        keywords: "today pick schedule",
        run: () => go("/today", undefined, { plan: "1" }),
      },
      {
        key: "action:undo",
        group: "Actions",
        label: "Undo",
        hint: "Ctrl+Z",
        run: () => {
          close();
          void store.getState().undo();
        },
      },
      {
        key: "action:redo",
        group: "Actions",
        label: "Redo",
        hint: "Ctrl+Shift+Z",
        run: () => {
          close();
          void store.getState().redo();
        },
      },
      { key: "view:inbox", group: "Views", label: "Inbox", hint: "g i", run: () => go("/inbox") },
      { key: "view:today", group: "Views", label: "Today", hint: "g t", run: () => go("/today") },
      { key: "view:all", group: "Views", label: "All tasks", hint: "g a", run: () => go("/all") },
      {
        key: "view:settings",
        group: "Views",
        label: "Settings",
        hint: "g s",
        keywords: "statuses columns workflow wip theme backup export import data",
        run: () => go("/settings"),
      },
    ];
    for (const v of Object.values(views)) {
      list.push({
        key: `view:${v.id}`,
        group: "Views",
        label: v.name,
        hint: "saved view",
        run: () => go("/view/$viewId", { viewId: v.id }),
      });
    }
    for (const p of Object.values(projects)) {
      list.push({
        key: `project:${p.id}`,
        group: "Projects",
        label: p.name,
        hint: p.archived_at !== null ? "archived" : undefined,
        run: () => go("/project/$projectId", { projectId: p.id }),
      });
    }
    for (const e of Object.values(epics)) {
      list.push({
        key: `epic:${e.id}`,
        group: "Epics",
        label: e.name,
        hint: e.state === "active" ? undefined : e.state,
        run: () => go("/epic/$epicId", { epicId: e.id }),
      });
    }
    for (const t of Object.values(tags)) {
      list.push({
        key: `tag:${t.id}`,
        group: "Tags",
        label: `#${t.name}`,
        run: () => go("/tag/$tagId", { tagId: t.id }),
      });
    }
    for (const id of hits) {
      const t = tasks[id];
      if (!t) continue;
      list.push({
        key: `task:${id}`,
        group: "Tasks",
        label: t.title,
        hint: t.project_id ? projects[t.project_id]?.name : "Inbox",
        run: () => {
          close();
          openTask(id);
        },
      });
    }
    return list;
  }, [views, projects, epics, tags, hits, tasks, store, openTask, close, go]);

  const results = useMemo(() => {
    const ranked = rankItems(items, query, {
      searchHits: new Set(hits.map((id) => `task:${id}`)),
    });
    const byKey = new Map(items.map((i) => [i.key, i]));
    return ranked.map((r) => byKey.get(r.key) as Runnable);
  }, [items, query, hits]);

  const current = Math.min(active, Math.max(results.length - 1, 0));
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[15%] left-1/2 z-50 w-[36rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                results[current]?.run();
              }
            }}
            placeholder="Jump to a view, project, epic, tag or task… or run an action"
            aria-label="Command"
            className="w-full border-b border-neutral-200 bg-transparent px-4 py-3 focus:outline-none dark:border-neutral-800"
          />
          <ul ref={listRef} className="max-h-96 overflow-y-auto py-1" aria-label="Results">
            {results.length === 0 && (
              <li className="px-4 py-3 text-sm text-neutral-500">No matches</li>
            )}
            {results.map((item, i) => (
              <li key={item.key} data-index={i}>
                {(i === 0 || results[i - 1]?.group !== item.group) && (
                  <p className="px-4 pt-2 pb-1 text-xs font-semibold text-neutral-400">
                    {item.group}
                  </p>
                )}
                <button
                  type="button"
                  onMouseMove={() => setActive(i)}
                  onClick={() => item.run()}
                  aria-current={i === current}
                  className={cx(
                    "flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm",
                    i === current && "bg-blue-50 dark:bg-blue-950/50",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="text-xs text-neutral-400">{item.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
