import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { BookmarkIcon as Bookmark, RoadmapIcon } from "../../components/TaskIcons";
import { Button, cx, FOCUS, InlineInput, Select } from "../../components/ui";
import { isoDate } from "../../lib/dates";
import { loadOpenOnDoubleClick } from "../../lib/roadmapPrefs";
import type { View } from "../../lib/types";
import { FILTER_NONE } from "../../lib/views";
import { createView, deleteView, updateEpic, updateTask, updateView } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { type Completion, closedTaskIds, filterLineage } from "../lineage/graph";
import { EditableTitle } from "../shell/EditableTitle";
import { MultiPick } from "../shell/FilterBar";
import { useOpenTask } from "../shell/useOpenTask";
import { RoadmapChart } from "./RoadmapChart";
import {
  filterOf,
  type Level,
  layoutOf,
  loadFilter,
  loadLayout,
  type RoadmapFilter,
  type RoadmapLayout,
  roadmapSpec,
  sameFilter,
  saveFilter,
  saveLayout,
} from "./saved";
import {
  type Bar,
  barOf,
  epicItems,
  type Group,
  type Item,
  linksOf,
  rangeOf,
  rowsOf,
  taskItem,
  type Zoom,
} from "./timeline";

const control = "rounded-lg border border-line-strong bg-raised px-3 py-2 text-sm text-ink";

/**
 * A saved roadmap (ADR 031): of epics, or one epic's tasks. Its filters, timescale and bar
 * starts are a draft until "Save view"; "Revert" remounts the page from the stored view.
 */
export function SavedRoadmapPage({ view }: { view: View }) {
  const [revision, setRevision] = useState(0);
  return <RoadmapPage key={revision} view={view} onRevert={() => setRevision((r) => r + 1)} />;
}

/**
 * The Roadmap, on two levels. Without `epic`: the epics across projects, each a bar ending
 * on its target date; opening one shows its timeline. With `epic`: that epic's tasks, each a
 * bar ending on its due date, and the epic's target date as a line across them. Where bars
 * start belongs to the roadmap, kept on this machine or in a saved view.
 */
export function RoadmapPage({
  epic: epicParam,
  view,
  onRevert,
}: {
  epic?: string;
  view?: View;
  onRevert?: () => void;
} = {}) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const tags = useStoreState((s) => s.tags);
  const epics = useStoreState((s) => s.epics);
  const statuses = useStoreState((s) => s.statuses);
  const pending = useStoreState((s) => s.pending);
  const openTask = useOpenTask();
  const epicId = (view ? view.spec.roadmap?.epic : epicParam) ?? null;
  const level: Level = epicId ? "tasks" : "epics";
  const epic = epicId ? epics[epicId] : undefined;
  const savedFilter = useMemo(() => (view ? filterOf(view.spec) : null), [view]);
  const [filter, setFilter] = useState<RoadmapFilter>(() => savedFilter ?? loadFilter(level));
  const [layout, setLayout] = useState<RoadmapLayout>(() =>
    view ? layoutOf(view.spec) : loadLayout(),
  );
  const [layoutEdited, setLayoutEdited] = useState(false);
  const [savingAs, setSavingAs] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [todaySeq, setTodaySeq] = useState(0);
  const [openOnDoubleClick] = useState(loadOpenOnDoubleClick);
  const today = isoDate();

  const all = useMemo(
    () =>
      Object.values(tasks)
        // Agents' own steps stay off the roadmap, as they stay out of lists by default.
        .filter((task) => task.owner !== "agent")
        .sort((a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id)),
    [tasks],
  );
  const closed = useMemo(() => closedTaskIds(all, statuses), [all, statuses]);
  const cancelled = useMemo(() => {
    const ids = new Set(statuses.filter((s) => s.category === "cancelled").map((s) => s.id));
    return new Set(all.filter((task) => ids.has(task.status_id)).map((task) => task.id));
  }, [all, statuses]);

  const items = useMemo((): Item[] => {
    if (level === "epics") {
      const picked = filter.projects;
      const inPicked = (id: string) =>
        all.some((task) => task.epic_id === id && picked.includes(task.project_id ?? ""));
      const shown = Object.values(epics).filter(
        (e) =>
          (filter.completion === "all" || e.state === "active") &&
          (!picked.length ||
            picked.includes(e.project_id ?? FILTER_NONE) ||
            // An epic without a home project shows with the projects of its tasks.
            (!e.project_id && inPicked(e.id))),
      );
      return epicItems(shown, all, layout.starts, { done: closed, cancelled }, (e) =>
        filter.group === "project" ? (e.project_id ?? FILTER_NONE) : "",
      ).filter((item) => filter.unscheduled || item.bar);
    }
    if (!epicId) return [];
    return filterLineage(all, tasks, closed, {
      project: "",
      epics: [epicId],
      tags: filter.tags,
      completion: filter.completion,
      linkedOnly: false,
      subtasks: filter.subtasks,
    })
      .filter((task) => filter.unscheduled || task.due_date)
      .map((task) => taskItem(task, barOf(task, layout.starts), closed.has(task.id)));
  }, [level, epicId, all, tasks, epics, closed, cancelled, filter, layout.starts]);
  const collapsed = useMemo(() => new Set(layout.collapsed), [layout.collapsed]);
  const rows = useMemo(
    () =>
      rowsOf(
        items,
        level === "epics" && filter.group === "project" ? projects : null,
        "No project",
        collapsed,
      ),
    [items, level, filter.group, projects, collapsed],
  );
  const links = useMemo(() => linksOf(items), [items]);
  const deadlineDate = level === "tasks" ? (epic?.target_date ?? null) : null;
  const deadline = useMemo(
    () => (deadlineDate && epic ? { date: deadlineDate, label: epic.name } : null),
    [deadlineDate, epic],
  );
  const range = useMemo(() => {
    const dates: string[] = [];
    for (const item of items) if (item.bar) dates.push(item.bar.start, item.bar.end);
    if (deadlineDate) dates.push(deadlineDate);
    return rangeOf(dates, today, filter.zoom);
  }, [items, deadlineDate, today, filter.zoom]);
  const scheduled = items.filter((item) => item.bar).length;
  const late = links.filter((link) => link.late).length;
  const pastDeadline = deadlineDate
    ? items.filter((item) => !item.done && item.bar && item.bar.end > deadlineDate).length
    : 0;
  const noun = (n: number) =>
    level === "epics" ? (n === 1 ? "epic" : "epics") : n === 1 ? "task" : "tasks";

  function changeFilter(next: Partial<RoadmapFilter>) {
    const value = { ...filter, ...next };
    setFilter(value);
    if (!view) saveFilter(level, value);
  }
  function changeLayout(next: RoadmapLayout) {
    setLayout(next);
    if (view) setLayoutEdited(true);
    else saveLayout(next);
  }

  /**
   * A bar moved, resized or drawn: its end is the epic's target date or the task's due date
   * (their own fields, changed at once); its start is the roadmap's.
   */
  async function setBar(id: string, bar: Bar) {
    changeLayout({ ...layout, starts: { ...layout.starts, [id]: bar.start } });
    const state = store.getState();
    let result: unknown = true;
    if (level === "epics") {
      const e = state.epics[id];
      if (e && e.target_date !== bar.end)
        result = await updateEpic(store, id, [{ target_date: bar.end }]);
    } else {
      const task = state.tasks[id];
      if (task && task.due_date !== bar.end)
        result = await updateTask(store, id, [{ due_date: bar.end }]);
    }
    if (result) setError("");
    else setError(store.getState().lastError ?? "Could not change the date.");
  }
  async function setDeadline(date: string) {
    if (!epicId) return;
    const result = await updateEpic(store, epicId, [{ target_date: date }]);
    if (result) setError("");
    else setError(store.getState().lastError ?? "Could not change the target date.");
  }
  function toggleGroup(key: string) {
    changeLayout({
      ...layout,
      collapsed: collapsed.has(key)
        ? layout.collapsed.filter((k) => k !== key)
        : [...layout.collapsed, key],
    });
  }
  /** An epic opens its timeline; a task opens in the detail panel. */
  function open(id: string) {
    if (level === "epics") void navigate({ to: "/roadmap", search: { epic: id } });
    else openTask(id);
  }

  function currentSpec() {
    const shown = new Set(items.flatMap((item) => (item.bar ? [item.id] : [])));
    return roadmapSpec(filter, layout, shown, epicId);
  }
  async function saveAsView(name: string) {
    setSavingAs(false);
    if (!name.trim()) return;
    const id = await createView(store, name, currentSpec());
    if (id) void navigate({ to: "/view/$viewId", params: { viewId: id } });
    else setError(store.getState().lastError ?? "Could not save the view.");
  }
  async function saveView() {
    if (!view) return;
    // The page remounts from the stored view once it has changed.
    const result = await updateView(store, view.id, [{ spec: currentSpec() }]);
    if (!result) setError(store.getState().lastError ?? "Could not save the view.");
  }
  async function removeView() {
    if (!view) return;
    if ((await deleteView(store, view.id)) !== null)
      void navigate({ to: "/roadmap", search: epicId ? { epic: epicId } : {} });
  }
  const dirty = !!view && (layoutEdited || !savedFilter || !sameFilter(filter, savedFilter));

  if (epicId && !epic)
    return (
      <div className="px-6 py-10 text-center text-sm text-ink-3">
        <p>This epic no longer exists.</p>
        <Link
          to="/roadmap"
          search={{}}
          className={cx("mt-2 inline-block text-accent underline", FOCUS)}
        >
          Back to the roadmap
        </Link>
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-6 py-3">
        <div className="flex items-center gap-3">
          <RoadmapIcon size={24} className="shrink-0 text-rubric" />
          {level === "tasks" && !view && (
            <Link
              to="/roadmap"
              search={{}}
              className={cx("shrink-0 font-display text-xl text-ink-3 hover:text-ink", FOCUS)}
            >
              Roadmap /
            </Link>
          )}
          {view ? (
            <h1 className="min-w-0 font-display text-3xl text-ink">
              <EditableTitle
                value={view.name}
                placeholder="View name"
                onRename={(name) => void updateView(store, view.id, [{ name }])}
              />
            </h1>
          ) : (
            <h1 className="min-w-0 truncate font-display text-3xl text-ink">
              {epic ? epic.name : "Roadmap"}
            </h1>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {epic && (
              <Button
                size="sm"
                onClick={() => void navigate({ to: "/epic/$epicId", params: { epicId: epic.id } })}
              >
                Epic page
              </Button>
            )}
            <Button size="sm" onClick={() => setTodaySeq((n) => n + 1)}>
              Today
            </Button>
            {view ? (
              <>
                {dirty && (
                  <>
                    <Button size="sm" onClick={onRevert}>
                      Revert
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => void saveView()}>
                      Save view
                    </Button>
                  </>
                )}
                <Button size="sm" onClick={() => void removeView()}>
                  Delete view
                </Button>
              </>
            ) : savingAs ? (
              <InlineInput
                initial=""
                autoFocus
                placeholder="Name of the new view"
                onCommit={(name) => void saveAsView(name)}
                onCancel={() => setSavingAs(false)}
              />
            ) : (
              <Button
                size="sm"
                title="Keep these filters, the timescale and where bars start as a saved view"
                onClick={() => setSavingAs(true)}
              >
                <Bookmark size={14} />
                Save as view
              </Button>
            )}
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-3">
          {level === "epics"
            ? `Epics across projects. A bar ends on the epic's target date: drag it to move, drag an end to resize, or drag across an empty row to schedule an epic. Open an epic (its name${openOnDoubleClick ? ", or double-click its bar" : ""}) to line up its tasks.`
            : `${view && epic ? `The tasks of ${epic.name}. ` : ""}A bar ends on the task's due date${openOnDoubleClick ? " (double-click it to open the task)" : ""}; the dashed line is the epic's target date.`}
          {view && " Dates change at once; the rest stays a draft until you save the view."}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {level === "epics" ? (
            <>
              <MultiPick
                label="Projects"
                ariaLabel="Filter roadmap by project"
                options={[
                  { value: FILTER_NONE, label: "No project" },
                  ...Object.values(projects)
                    .filter((p) => !p.archived_at)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((p) => ({ value: p.id, label: p.name, color: p.color })),
                ]}
                selected={filter.projects}
                onChange={(next) => changeFilter({ projects: next })}
              />
              <Select<Completion>
                aria-label="Filter roadmap by state"
                className={cx(control, FOCUS)}
                value={filter.completion === "ready" ? "open" : filter.completion}
                onValueChange={(value) => changeFilter({ completion: value })}
                options={[
                  { value: "open", label: "Active epics" },
                  { value: "all", label: "Active, done and dropped" },
                ]}
              />
              <Select<Group>
                aria-label="Group roadmap"
                className={cx(control, FOCUS)}
                value={filter.group}
                onValueChange={(value) => changeFilter({ group: value })}
                options={[
                  { value: "project", label: "By project" },
                  { value: "none", label: "No groups" },
                ]}
              />
            </>
          ) : (
            <>
              <MultiPick
                label="Tags"
                ariaLabel="Filter timeline by tag"
                options={[
                  { value: FILTER_NONE, label: "No tag" },
                  ...Object.values(tags)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((t) => ({ value: t.id, label: `#${t.name}`, color: t.color })),
                ]}
                selected={filter.tags}
                onChange={(next) => changeFilter({ tags: next })}
              />
              <Select<Completion>
                aria-label="Filter timeline by completion"
                className={cx(control, FOCUS)}
                value={filter.completion}
                onValueChange={(value) => changeFilter({ completion: value })}
                options={[
                  { value: "open", label: "Open only" },
                  { value: "all", label: "Open and done" },
                  { value: "ready", label: "Ready (not blocked)" },
                ]}
              />
            </>
          )}
          <Select<Zoom>
            aria-label="Timescale"
            className={cx(control, FOCUS)}
            value={filter.zoom}
            onValueChange={(value) => changeFilter({ zoom: value })}
            options={[
              { value: "day", label: "Days" },
              { value: "week", label: "Weeks" },
              { value: "month", label: "Months" },
              { value: "quarter", label: "Quarters" },
            ]}
          />
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={filter.unscheduled}
              onChange={(e) => changeFilter({ unscheduled: e.target.checked })}
            />
            {level === "epics" ? "Epics without a target date" : "Unscheduled tasks"}
          </label>
          {level === "tasks" && (
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input
                type="checkbox"
                checked={filter.subtasks}
                onChange={(e) => changeFilter({ subtasks: e.target.checked })}
              />
              Show subtasks
            </label>
          )}
          <span className="text-xs text-ink-3">
            {items.length} {noun(items.length)} · {scheduled} scheduled
            {late > 0 && (
              <span className="text-danger">
                {" "}
                · {late} {noun(late)} {late === 1 ? "starts" : "start"} before{" "}
                {level === "epics" ? "an epic it waits on" : "a prerequisite"} ends
              </span>
            )}
            {pastDeadline > 0 && (
              <span className="text-danger">
                {" "}
                · {pastDeadline} {noun(pastDeadline)} {pastDeadline === 1 ? "ends" : "end"} after
                the target date
              </span>
            )}
          </span>
        </div>
      </header>
      {error && (
        <p role="alert" className="px-6 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {rows.length ? (
        <RoadmapChart
          rows={rows}
          links={links}
          range={range}
          zoom={filter.zoom}
          today={today}
          nameHeader={level === "epics" ? "Epic" : "Task"}
          deadline={deadline}
          selected={selected}
          busy={pending > 0}
          scrollKey={filter.zoom}
          todaySeq={todaySeq}
          onSelect={setSelected}
          openLabel={(item) =>
            level === "epics" ? `Open the timeline of ${item.title}` : `Open ${item.title}`
          }
          onOpen={open}
          openOnDoubleClick={openOnDoubleClick}
          onBar={(id, bar) => void setBar(id, bar)}
          onDeadline={(date) => void setDeadline(date)}
          onToggleGroup={toggleGroup}
        />
      ) : (
        <p className="px-6 py-10 text-center text-sm text-ink-3">
          {level === "epics"
            ? "No epics match these filters. Give epics a target date, or show epics without one to plan them here."
            : "No tasks of this epic match these filters."}
        </p>
      )}
    </div>
  );
}
