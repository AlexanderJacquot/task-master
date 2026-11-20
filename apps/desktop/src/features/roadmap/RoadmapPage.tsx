import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { BookmarkIcon as Bookmark, RoadmapIcon } from "../../components/TaskIcons";
import { Button, cx, FOCUS, InlineInput, Select } from "../../components/ui";
import { isoDate } from "../../lib/dates";
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
import { type Bar, barOf, type Group, linksOf, rangeOf, rowsOf, type Zoom } from "./timeline";

const control = "rounded-lg border border-line-strong bg-raised px-3 py-2 text-sm text-ink";

/**
 * A saved Roadmap view (ADR 030). Its filters, timescale and bar starts are a draft until
 * "Save view"; "Revert" remounts the page from the stored view.
 */
export function SavedRoadmapPage({ view }: { view: View }) {
  const [revision, setRevision] = useState(0);
  return <RoadmapPage key={revision} view={view} onRevert={() => setRevision((r) => r + 1)} />;
}

/**
 * The Roadmap: tasks as bars on a timeline, grouped by epic or project. A bar ends on its
 * task's due date (dragging it edits the task); where it starts belongs to the roadmap,
 * kept on this machine or in a saved view.
 */
export function RoadmapPage({ view, onRevert }: { view?: View; onRevert?: () => void } = {}) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const tags = useStoreState((s) => s.tags);
  const epics = useStoreState((s) => s.epics);
  const statuses = useStoreState((s) => s.statuses);
  const pending = useStoreState((s) => s.pending);
  const openTask = useOpenTask();
  const savedFilter = useMemo(() => (view ? filterOf(view.spec) : null), [view]);
  const [filter, setFilter] = useState<RoadmapFilter>(() => savedFilter ?? loadFilter());
  const [layout, setLayout] = useState<RoadmapLayout>(() =>
    view ? layoutOf(view.spec) : loadLayout(),
  );
  const [layoutEdited, setLayoutEdited] = useState(false);
  const [savingAs, setSavingAs] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [todaySeq, setTodaySeq] = useState(0);
  const today = isoDate();
  const { project } = filter;

  const all = useMemo(
    () =>
      Object.values(tasks)
        // Agents' own steps stay off the roadmap, as they stay out of lists by default.
        .filter((task) => task.owner !== "agent")
        .sort((a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id)),
    [tasks],
  );
  const closed = useMemo(() => closedTaskIds(all, statuses), [all, statuses]);
  const shown = useMemo(
    () =>
      filterLineage(all, tasks, closed, {
        project,
        epics: filter.epics,
        tags: filter.tags,
        completion: filter.completion,
        linkedOnly: false,
        subtasks: filter.subtasks,
      }).filter((task) => filter.unscheduled || task.due_date),
    [
      all,
      tasks,
      closed,
      project,
      filter.epics,
      filter.tags,
      filter.completion,
      filter.subtasks,
      filter.unscheduled,
    ],
  );
  const bars = useMemo(() => {
    const map = new Map<string, Bar>();
    for (const task of shown) {
      const bar = barOf(task, layout.starts);
      if (bar) map.set(task.id, bar);
    }
    return map;
  }, [shown, layout.starts]);
  const collapsed = useMemo(() => new Set(layout.collapsed), [layout.collapsed]);
  const rows = useMemo(
    () => rowsOf(shown, bars, filter.group, epics, projects, collapsed),
    [shown, bars, filter.group, epics, projects, collapsed],
  );
  const links = useMemo(() => linksOf(shown, bars), [shown, bars]);
  const range = useMemo(() => {
    const dates: string[] = [];
    for (const bar of bars.values()) dates.push(bar.start, bar.end);
    for (const row of rows)
      if (row.kind === "group" && row.epic?.target_date) dates.push(row.epic.target_date);
    return rangeOf(dates, today, filter.zoom);
  }, [bars, rows, today, filter.zoom]);
  const late = links.filter((link) => link.late).length;

  /** Epics shown under a project filter: that project's, plus epics without a project. */
  const epicFits = (id: string, projectId: string) =>
    id === FILTER_NONE || !epics[id]?.project_id || epics[id]?.project_id === projectId;

  function changeFilter(next: Partial<RoadmapFilter>) {
    const value = { ...filter, ...next };
    setFilter(value);
    if (!view) saveFilter(value);
  }
  function changeLayout(next: RoadmapLayout) {
    setLayout(next);
    if (view) setLayoutEdited(true);
    else saveLayout(next);
  }

  /** A bar moved, resized or drawn: the end is the task's due date, the start the roadmap's. */
  async function setBar(id: string, bar: Bar) {
    const task = store.getState().tasks[id];
    if (!task) return;
    changeLayout({ ...layout, starts: { ...layout.starts, [id]: bar.start } });
    if (task.due_date === bar.end) return;
    const result = await updateTask(store, id, [{ due_date: bar.end }]);
    if (result) setError("");
    else setError(store.getState().lastError ?? "Could not change the due date.");
  }
  async function setTarget(epic: string, date: string) {
    const result = await updateEpic(store, epic, [{ target_date: date }]);
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

  function currentSpec() {
    return roadmapSpec(filter, layout, new Set(bars.keys()));
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
    if ((await deleteView(store, view.id)) !== null) void navigate({ to: "/roadmap" });
  }
  const dirty = !!view && (layoutEdited || !savedFilter || !sameFilter(filter, savedFilter));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-6 py-3">
        <div className="flex items-center gap-3">
          <RoadmapIcon size={24} className="shrink-0 text-rubric" />
          {view ? (
            <h1 className="min-w-0 font-display text-3xl text-ink">
              <EditableTitle
                value={view.name}
                placeholder="View name"
                onRename={(name) => void updateView(store, view.id, [{ name }])}
              />
            </h1>
          ) : (
            <h1 className="font-display text-3xl text-ink">Roadmap</h1>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
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
          {view
            ? "A saved roadmap: its filters, timescale and where bars start. Due dates change at once; the rest stays a draft until you save the view."
            : "Plan tasks on a timeline. A bar ends on the task's due date: drag it to move, drag an end to resize, or drag across an empty row to schedule a task."}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Select
            aria-label="Filter roadmap by project"
            className={cx(control, FOCUS)}
            value={project}
            onValueChange={(value) =>
              changeFilter({
                project: value,
                // Drop picked epics that belong to another project.
                epics: filter.epics.filter((id) => !value || epicFits(id, value)),
              })
            }
            options={[
              { value: "", label: "All projects" },
              ...Object.values(projects).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          <MultiPick
            label="Epic"
            ariaLabel="Filter roadmap by epic"
            options={[
              { value: FILTER_NONE, label: "No epic" },
              ...Object.values(epics)
                .filter((e) => !project || epicFits(e.id, project))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((e) => ({ value: e.id, label: e.name, color: e.color })),
            ]}
            selected={filter.epics}
            onChange={(next) => changeFilter({ epics: next })}
          />
          <MultiPick
            label="Tags"
            ariaLabel="Filter roadmap by tag"
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
            aria-label="Filter roadmap by completion"
            className={cx(control, FOCUS)}
            value={filter.completion}
            onValueChange={(value) => changeFilter({ completion: value })}
            options={[
              { value: "open", label: "Open only" },
              { value: "all", label: "Open and done" },
              { value: "ready", label: "Ready (not blocked)" },
            ]}
          />
          <Select<Group>
            aria-label="Group roadmap"
            className={cx(control, FOCUS)}
            value={filter.group}
            onValueChange={(value) => changeFilter({ group: value })}
            options={[
              { value: "epic", label: "By epic" },
              { value: "project", label: "By project" },
              { value: "none", label: "No groups" },
            ]}
          />
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
            Unscheduled tasks
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={filter.subtasks}
              onChange={(e) => changeFilter({ subtasks: e.target.checked })}
            />
            Show subtasks
          </label>
          <span className="text-xs text-ink-3">
            {shown.length} tasks · {bars.size} scheduled
            {late > 0 && (
              <span className="text-danger">
                {" "}
                · {late} {late === 1 ? "task starts" : "tasks start"} before a prerequisite ends
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
          closed={closed}
          selected={selected}
          busy={pending > 0}
          scrollKey={filter.zoom}
          todaySeq={todaySeq}
          onSelect={setSelected}
          onOpen={openTask}
          onBar={(id, bar) => void setBar(id, bar)}
          onTarget={(epic, date) => void setTarget(epic, date)}
          onToggleGroup={toggleGroup}
        />
      ) : (
        <p className="px-6 py-10 text-center text-sm text-ink-3">
          No tasks match these filters. Give tasks a due date, or show unscheduled tasks to plan
          them here.
        </p>
      )}
    </div>
  );
}
