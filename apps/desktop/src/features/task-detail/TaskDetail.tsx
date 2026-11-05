import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowUpRight, ChevronRight, Maximize2, Sun, Trash2, X } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import {
  cx,
  Dot,
  IconButton,
  PRIORITIES,
  PRIORITY_STYLE,
  SectionLabel,
  Select,
  TaskCheck,
} from "../../components/ui";
import { isoDate } from "../../lib/dates";
import type { Task, TaskChange } from "../../lib/types";
import { deleteTask, setParent, toggleDone, updateTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { ProjectMark } from "../organize/ProjectMark";
import { useOpenTask } from "../shell/useOpenTask";
import { ActivityFeed } from "./ActivityFeed";
import { AttachmentList } from "./AttachmentList";
import { DescriptionEditor } from "./DescriptionEditor";
import { PropertyPills } from "./PropertyPills";
import { SubtaskList } from "./SubtaskList";
import { TagPicker } from "./TagPicker";
import { useTaskAttachments, useTaskFiles } from "./useTaskFiles";

type Variant = "panel" | "page";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2 py-[3px]">
      <span className="text-[13px] text-ink-3">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const fieldInput =
  "w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-ink hover:border-line-strong focus:border-accent focus:outline-none";

function useProjectOptions(task: Task | undefined) {
  const projects = useStoreState((s) => s.projects);
  return useMemo(() => {
    const list = Object.values(projects).filter(
      (p) => p.archived_at === null || p.id === task?.project_id,
    );
    const areas = list
      .filter((p) => p.parent_id === null)
      .sort((a, b) => (a.rank < b.rank ? -1 : 1));
    return areas.flatMap((area) => [
      { id: area.id, label: area.name, name: area.name, color: area.color, icon: area.icon },
      ...list
        .filter((p) => p.parent_id === area.id)
        .sort((a, b) => (a.rank < b.rank ? -1 : 1))
        .map((p) => ({
          id: p.id,
          label: `  ${area.name} / ${p.name}`,
          name: p.name,
          color: p.color,
          icon: p.icon,
        })),
    ]);
  }, [projects, task?.project_id]);
}

/**
 * Every editable part of a task, laid out for the side panel or the full page (also used
 * by the expanded quick-capture window).
 */
export function TaskEditor({ task, variant }: { task: Task; variant: Variant }) {
  const store = useTaskStore();
  const statuses = useStoreState((s) => s.statuses);
  const epics = useStoreState((s) => s.epics);
  const parent = useStoreState((s) => (task.parent_id ? s.tasks[task.parent_id] : undefined));
  const projectOptions = useProjectOptions(task);
  const files = useTaskFiles(task.id);
  const attachments = useTaskAttachments(task.id);
  const attachmentsById = useStoreState((s) => s.attachments);
  const today = isoDate();
  const change = (changes: TaskChange[]) => void updateTask(store, task.id, changes);
  const pickedToday = task.today_on === today;
  const status = statuses.find((s) => s.id === task.status_id);
  const done = status?.category === "done" || status?.category === "cancelled";
  const page = variant === "page";
  const epicOptions = Object.values(epics).filter(
    (e) => e.state === "active" || e.id === task.epic_id,
  );

  const title = (
    <div className={cx("flex items-start", page ? "gap-4" : "gap-3")}>
      <span className={page ? "mt-3.5" : "mt-1.5"}>
        <TaskCheck
          checked={done}
          onChange={() => void toggleDone(store, task.id)}
          label={done ? "Reopen" : "Mark done"}
          color={status?.color ?? null}
          size={page ? "lg" : "md"}
        />
      </span>
      <textarea
        key={`title-${task.updated_at}`}
        defaultValue={task.title}
        aria-label="Title"
        rows={page ? 1 : 2}
        className={cx(
          "w-full resize-none rounded-lg border border-transparent bg-transparent px-1 [field-sizing:content] focus:outline-none",
          page
            ? "font-display text-[40px] leading-[1.15] tracking-wide"
            : "font-display text-[22px] leading-tight hover:border-line-strong focus:border-accent",
          done && "text-ink-3",
        )}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => {
          const value = e.currentTarget.value.trim();
          if (!value) e.currentTarget.value = task.title;
          else if (value !== task.title) change([{ title: value }]);
        }}
      />
    </div>
  );

  const statusSelect = (className?: string) => (
    <Select
      value={task.status_id}
      onValueChange={(status_id) => change([{ status_id }])}
      aria-label="Status"
      className={className}
      options={statuses.map((s) => ({
        value: s.id,
        label: s.name,
        icon: <Dot color={s.color ?? null} />,
      }))}
    />
  );

  const properties = page ? (
    <div className="pl-10">
      <PropertyPills
        task={task}
        today={today}
        change={change}
        statuses={statuses}
        epics={epicOptions}
        projects={projectOptions}
      />
    </div>
  ) : (
    <div>
      <Field label="Status">{statusSelect("w-full")}</Field>
      <Field label="Priority">
        <Select
          value={task.priority}
          onValueChange={(priority) => change([{ priority }])}
          aria-label="Priority"
          className="w-full"
          options={PRIORITIES.map((p) => ({ ...p, className: PRIORITY_STYLE[p.value] }))}
        />
      </Field>
      <Field label="Due">
        <input
          type="date"
          aria-label="Due date"
          value={task.due_date ?? ""}
          onChange={(e) => change([{ due_date: e.target.value || null }])}
          className={fieldInput}
        />
      </Field>
      <Field label="Today">
        <button
          type="button"
          aria-pressed={pickedToday}
          onClick={() => change([{ today_on: pickedToday ? null : today }])}
          className={cx(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px] transition-colors",
            pickedToday
              ? "bg-amber-600/15 text-amber-800 dark:bg-amber-400/15 dark:text-amber-200"
              : "text-ink-2 hover:bg-hover",
          )}
        >
          <Sun size={13} />
          {pickedToday ? "Picked for today" : "Add to today"}
        </button>
      </Field>
      <Field label="Estimate">
        <input
          key={`estimate-${task.updated_at}`}
          type="number"
          min={0}
          step={5}
          aria-label="Estimate in minutes"
          placeholder="minutes"
          defaultValue={task.estimate_min ?? ""}
          onBlur={(e) => {
            const raw = e.currentTarget.value;
            const value = raw === "" ? null : Math.max(0, Math.round(Number(raw)));
            if (value !== task.estimate_min && !Number.isNaN(value))
              change([{ estimate_min: value }]);
          }}
          className={fieldInput}
        />
      </Field>
      <Field label="Project">
        <Select
          value={task.project_id ?? ""}
          onValueChange={(id) => change([{ project_id: id || null }])}
          aria-label="Project"
          className="w-full"
          options={[
            { value: "", label: "Inbox (no project)" },
            ...projectOptions.map((p) => ({
              value: p.id,
              label: p.label.trim(),
              icon: <ProjectMark project={p} />,
            })),
          ]}
        />
      </Field>
      <Field label="Epic">
        <Select
          value={task.epic_id ?? ""}
          onValueChange={(id) => change([{ epic_id: id || null }])}
          aria-label="Epic"
          className="w-full"
          options={[
            { value: "", label: "None" },
            ...epicOptions.map((e) => ({ value: e.id, label: e.name })),
          ]}
        />
      </Field>
      <Field label="Tags">
        <TagPicker task={task} />
      </Field>
    </div>
  );

  const attachmentList = (
    <AttachmentList
      key="attachments"
      attachments={attachments}
      files={files}
      page={page}
      onInsert={(markdown) => {
        const text = task.description.replace(/\s+$/, "");
        change([{ description: text ? `${text}\n\n${markdown}` : markdown }]);
      }}
    />
  );

  const subtasks = (
    <section key="subtasks" aria-label="Subtasks" className={page ? "pl-10" : undefined}>
      {!page && <SectionLabel className="mb-1.5 block">Subtasks</SectionLabel>}
      <SubtaskList parent={task} variant={variant} />
    </section>
  );

  return (
    <div className={cx("flex flex-col", page ? "gap-7" : "gap-5")}>
      {title}
      {properties}
      {parent && (
        <button
          type="button"
          onClick={() => void setParent(store, task.id, null)}
          className={cx("self-start text-[13px] text-accent hover:underline", page && "ml-10")}
        >
          Promote to a top-level task
        </button>
      )}
      <section aria-label="Description" className={page ? "pl-10" : undefined}>
        {!page && <SectionLabel className="mb-1.5 block">Description</SectionLabel>}
        <DescriptionEditor
          value={task.description}
          onSave={(description) => change([{ description }])}
          size={variant}
          attachments={attachmentsById}
          actions={files.actions}
          upload={files.uploader}
        />
      </section>
      {/* The page follows the mockup: subtasks right under the text, files after. */}
      {page ? [subtasks, attachmentList] : [attachmentList, subtasks]}
      {page ? (
        <details className="pl-10">
          <summary className="cursor-pointer font-display text-[15px] tracking-wide text-ink-2">
            Activity
          </summary>
          <div className="pt-2">
            <ActivityFeed task={task} />
          </div>
        </details>
      ) : (
        <section aria-label="Activity">
          <SectionLabel className="mb-1.5 block">Activity</SectionLabel>
          <ActivityFeed task={task} />
        </section>
      )}
    </div>
  );
}

/** Right-hand panel for one task, opened with `?task=<id>`. Every field saves on change. */
export function TaskDetail({ taskId }: { taskId: string }) {
  const store = useTaskStore();
  const task = useStoreState((s) => s.tasks[taskId]);
  const parent = useStoreState((s) => (task?.parent_id ? s.tasks[task.parent_id] : undefined));
  const openTask = useOpenTask();
  const navigate = useNavigate();

  if (!task) {
    return (
      <aside className="flex w-[30rem] shrink-0 flex-col items-center justify-center gap-2 border-l border-line bg-raised p-6 text-ink-3">
        This task no longer exists.
        <button
          type="button"
          onClick={() => openTask(null)}
          className="text-accent hover:underline"
        >
          Close
        </button>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Task details"
      className="tex-sheet m-2 ml-0 flex w-[30rem] shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-raised shadow-2xl shadow-black/15"
    >
      <div className="flex items-center gap-1 border-b border-line px-3 py-2 text-[13px] text-ink-3">
        {parent ? (
          <button
            type="button"
            onClick={() => openTask(parent.id)}
            className="flex min-w-0 items-center gap-1 truncate rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink"
          >
            <ArrowUpRight size={13} className="rotate-[-90deg]" /> {parent.title}
          </button>
        ) : (
          <span className="px-1.5">Task</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() =>
            void navigate({ to: "/task/$taskId", params: { taskId: task.id }, search: {} })
          }
          title="Open the full page (Shift+Enter in a list)"
          className="flex items-center gap-1.5 rounded-md bg-hover px-2.5 py-1 text-ink-2 hover:bg-selected hover:text-ink"
        >
          <Maximize2 size={13} /> Open
        </button>
        <IconButton
          label="Delete (Ctrl+Z to undo)"
          onClick={() => {
            void deleteTask(store, task.id);
            openTask(null);
          }}
          className="hover:text-danger"
        >
          <Trash2 size={15} />
        </IconButton>
        <IconButton label="Close" onClick={() => openTask(null)}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <TaskEditor task={task} variant="panel" />
      </div>
    </aside>
  );
}

/** The full task page (`/task/:id`): a wide sheet for writing. */
export function TaskPage({ taskId }: { taskId: string }) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const task = useStoreState((s) => s.tasks[taskId]);
  const project = useStoreState((s) =>
    task?.project_id ? s.projects[task.project_id] : undefined,
  );
  const status = useStoreState((s) => s.statuses.find((x) => x.id === task?.status_id));
  const parent = useStoreState((s) => (task?.parent_id ? s.tasks[task.parent_id] : undefined));

  const back = project
    ? ({ to: "/project/$projectId", params: { projectId: project.id } } as const)
    : ({ to: "/inbox" } as const);

  if (!task) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-3">
        This task no longer exists.
        <Link to="/inbox" search={{}} className="text-accent hover:underline">
          Back to the Inbox
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-6 py-3 text-[13.5px] text-ink-2">
        <Link
          {...back}
          search={{ task: task.id }}
          title="Back (Esc)"
          className="flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink"
        >
          <ArrowLeft size={15} />
          {project ? (
            <>
              <ProjectMark project={project} />
              {project.name}
            </>
          ) : (
            "Inbox"
          )}
        </Link>
        {parent && (
          <>
            <ChevronRight size={13} className="text-ink-3" />
            <Link
              to="/task/$taskId"
              params={{ taskId: parent.id }}
              search={{}}
              className="max-w-64 truncate rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink"
            >
              {parent.title}
            </Link>
          </>
        )}
        {status && (
          <>
            <ChevronRight size={13} className="text-ink-3" />
            <span>{status.name}</span>
          </>
        )}
        <span className="flex-1" />
        <IconButton
          label="Delete (Ctrl+Z to undo)"
          onClick={() => {
            void deleteTask(store, task.id);
            void navigate({ ...back, search: {} });
          }}
          className="hover:text-danger"
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
      <div className="tex-canvas min-h-0 flex-1 overflow-y-auto px-6 py-8">
        <article className="tex-sheet mx-auto max-w-[820px] rounded-xl border border-line bg-raised px-10 py-11 shadow-xl shadow-black/10 sm:px-14">
          <TaskEditor key={task.id} task={task} variant="page" />
        </article>
      </div>
    </div>
  );
}
