// The Team page (ADR 033): what each member is on, what is late, what got done this week.
// Loaded only when the server runs a team; a personal instance never fetches this code.

import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cx, FOCUS, INPUT } from "../../components/ui";
import { formatAgo, isoDate } from "../../lib/dates";
import {
  initials,
  isTeamTask,
  type MemberWork,
  markNoticesSeen,
  memberName,
  teamWork,
} from "../../lib/team";
import type { Member, Note, Notice, Task } from "../../lib/types";
import type { ViewContext } from "../../lib/views";
import { createTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { useOpenTask } from "../shell/useOpenTask";

export default function TeamPage() {
  const team = useStoreState((s) => s.team);
  const tasks = useStoreState((s) => s.tasks);
  const teamIds = useStoreState((s) => s.teamIds);
  const members = useStoreState((s) => s.members);
  const projects = useStoreState((s) => s.projects);
  const statusList = useStoreState((s) => s.statuses);
  const notices = useStoreState((s) => s.notices);
  // Opening the page shows what is new: the sidebar's count goes back to zero.
  useEffect(() => {
    if (notices[0]) markNoticesSeen(notices[0].seq);
  }, [notices]);
  const ctx: ViewContext = useMemo(
    () => ({
      today: isoDate(),
      statuses: Object.fromEntries((team?.statuses ?? statusList).map((s) => [s.id, s])),
      projects,
      teamIds,
    }),
    [team, statusList, projects, teamIds],
  );
  const me = team?.info?.me?.id ?? null;
  // Where the Team page's new tasks go; kept while the page is open ("" is the team inbox).
  const [projectId, setProjectId] = useState("");
  const teamProjects = useMemo(
    () =>
      Object.values(projects)
        .filter((p) => teamIds[p.id] && p.archived_at === null && p.deleted_at === null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projects, teamIds],
  );
  const columns = useMemo(
    () =>
      teamWork(
        Object.values(tasks).filter((t) => isTeamTask(t, teamIds)),
        members,
        ctx,
        me,
        Date.now(),
      ),
    [tasks, teamIds, members, ctx, me],
  );

  if (!team) {
    return <p className="p-8 text-ink-3">This app is not connected to a team.</p>;
  }
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="px-8 pt-6 pb-4">
        <h1 className="font-display text-2xl text-ink">{team.info?.name ?? "Team"}</h1>
        <p className="text-[13px] text-ink-3">
          {Object.keys(members).length} members · everyone's open work, late tasks and the last
          seven days
        </p>
      </header>
      <ForYou notices={notices} members={members} tasks={tasks} />
      <div className="flex flex-1 gap-4 overflow-x-auto px-8 pb-8">
        {columns.map((work) => (
          <MemberColumn
            key={work.member?.id ?? "unassigned"}
            work={work}
            mine={work.member?.id === me}
            projects={projects}
            adding={{ teamProjects, projectId, setProjectId }}
          />
        ))}
        {!columns.length && <p className="text-ink-3">No members yet.</p>}
      </div>
    </div>
  );
}

/** What a notice is about, in words: "mentioned you on <title>" and so on. */
function noticeText(n: Notice, tasks: Record<string, Task>, notes: Record<string, Note>) {
  if (n.note_id)
    return { verb: " mentioned you in ", title: notes[n.note_id]?.title || "Untitled" };
  const title = (n.task_id && tasks[n.task_id]?.title) || "";
  if (n.kind === "assigned") return { verb: " assigned you ", title };
  return { verb: n.comment_id ? " mentioned you on " : " mentioned you in ", title };
}

/** Mentions and assignments by teammates (ADR 033, T5), newest first. */
function ForYou({
  notices,
  members,
  tasks,
}: {
  notices: Notice[];
  members: Record<string, Member>;
  tasks: Record<string, Task>;
}) {
  const open = useOpenTask();
  const navigate = useNavigate();
  const notes = useStoreState((s) => s.notes);
  const shown = notices
    .filter((n) => (n.note_id ? notes[n.note_id] : n.task_id && tasks[n.task_id]))
    .slice(0, 8);
  if (!shown.length) return null;
  return (
    <section
      aria-label="For you"
      className="mx-8 mb-4 rounded-xl border border-line bg-surface p-3"
    >
      <h2 className="mb-1 text-[12px] font-medium tracking-wide text-ink-3 uppercase">For you</h2>
      <ul className="flex flex-col gap-px">
        {shown.map((n) => {
          const { verb, title } = noticeText(n, tasks, notes);
          return (
            <li key={n.seq}>
              <button
                type="button"
                onClick={() => {
                  if (n.note_id) {
                    void navigate({
                      to: "/note/$noteId",
                      params: { noteId: n.note_id },
                      search: {},
                    });
                  } else if (n.task_id) {
                    open(n.task_id);
                  }
                }}
                className={cx(
                  "flex w-full items-baseline gap-2 rounded-lg px-2 py-1 text-left hover:bg-hover",
                  FOCUS,
                )}
              >
                <span className="text-[13px] text-ink">
                  <span className="font-medium">{memberName(members, n.author_id)}</span>
                  {verb}
                  <span className="font-medium">{title}</span>
                </span>
                <span className="ml-auto shrink-0 text-[11.5px] text-ink-3">{formatAgo(n.at)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface Adding {
  teamProjects: Array<{ id: string; name: string }>;
  projectId: string;
  setProjectId: (id: string) => void;
}

function MemberColumn({
  work,
  mine,
  projects,
  adding,
}: {
  work: MemberWork;
  mine: boolean;
  projects: Record<string, { name: string }>;
  adding: Adding;
}) {
  const name = work.member?.name ?? "Unassigned";
  const [open, setOpen] = useState(false);
  const label = work.member ? `New task for ${mine ? "you" : name}` : "New unassigned task";
  return (
    <section
      aria-label={name}
      className={cx(
        "flex w-72 shrink-0 flex-col overflow-y-auto rounded-xl border border-line bg-surface p-3",
        mine && "border-accent/50",
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-full bg-accent/15 text-[11px] font-semibold text-ink">
          {work.member ? initials(name) : "–"}
        </span>
        <span className="flex-1 truncate font-medium text-ink">
          {mine ? `${name} (you)` : name}
        </span>
        <span className="text-[12px] text-ink-3">
          {work.inProgress.length + work.todo.length} open
        </span>
        <button
          type="button"
          aria-label={label}
          title={label}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cx("rounded-md p-1 text-ink-3 hover:bg-hover hover:text-ink", FOCUS)}
        >
          <Plus size={14} />
        </button>
      </div>
      {open && (
        <NewTeamTask
          label={label}
          assigneeId={work.member?.id ?? null}
          adding={adding}
          onClose={() => setOpen(false)}
        />
      )}
      <Group title="Overdue" tasks={work.overdue} projects={projects} urgent />
      <Group title="In progress" tasks={work.inProgress} projects={projects} />
      <Group title="To do" tasks={work.todo} projects={projects} />
      <Group title="Done this week" tasks={work.doneThisWeek} projects={projects} muted />
    </section>
  );
}

function Group({
  title,
  tasks,
  projects,
  urgent,
  muted,
}: {
  title: string;
  tasks: Task[];
  projects: Record<string, { name: string }>;
  urgent?: boolean;
  muted?: boolean;
}) {
  const open = useOpenTask();
  if (!tasks.length) return null;
  return (
    <div className="mb-3">
      <h3
        className={cx(
          "mb-1 px-1 text-[11.5px] font-medium tracking-wide uppercase",
          urgent ? "text-red-700 dark:text-red-300" : "text-ink-3",
        )}
      >
        {title} · {tasks.length}
      </h3>
      <ul className="flex flex-col gap-px">
        {tasks.slice(0, 50).map((task) => (
          <li key={task.id}>
            <button
              type="button"
              onClick={() => open(task.id)}
              className={cx(
                "flex w-full flex-col rounded-lg px-2 py-1 text-left hover:bg-hover",
                muted && "opacity-70",
                FOCUS,
              )}
            >
              <span className="truncate text-[13px] text-ink">{task.title}</span>
              <span className="truncate text-[11.5px] text-ink-3">
                {[task.project_id ? projects[task.project_id]?.name : "Team inbox", task.due_date]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A team task made from a member's column: assigned to them, in the chosen team project. */
function NewTeamTask({
  label,
  assigneeId,
  adding,
  onClose,
}: {
  label: string;
  assigneeId: string | null;
  adding: Adding;
  onClose: () => void;
}) {
  const store = useTaskStore();
  const { teamProjects, projectId, setProjectId } = adding;
  // A project that left the team (deleted, archived) falls back to the team inbox.
  const project = teamProjects.some((p) => p.id === projectId) ? projectId : "";
  return (
    <fieldset
      aria-label={label}
      className="mb-3 flex flex-col gap-1.5"
      onBlur={(e) => {
        // Closes when focus leaves the form with nothing typed.
        const form = e.currentTarget;
        const input = form.querySelector("input");
        if (!form.contains(e.relatedTarget as Node | null) && !input?.value.trim()) onClose();
      }}
    >
      <input
        ref={(el) => {
          if (el && !el.dataset.focused) {
            el.dataset.focused = "1";
            el.focus();
          }
        }}
        aria-label={label}
        placeholder={`${label}…`}
        className={cx(INPUT, "py-1 text-[13px]")}
        onKeyDown={(e) => {
          const input = e.currentTarget;
          if (e.key === "Enter") {
            e.preventDefault();
            const title = input.value.trim();
            if (!title) return;
            input.value = "";
            void createTask(store, {
              title,
              project_id: project || null,
              assignee_id: assigneeId,
              space: "team",
            });
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
      />
      <select
        aria-label="Team project"
        value={project}
        onChange={(e) => setProjectId(e.target.value)}
        className={cx(INPUT, "py-0.5 text-[12px] text-ink-2")}
      >
        <option value="">Team inbox</option>
        {teamProjects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </fieldset>
  );
}
