// The team space in the UI (ADR 033): which rows are the team's, member names, and the
// Team page's grouping. Pure functions of store state.

import type { Member, Task } from "./types";
import { categoryOf, isOpen, type ViewContext } from "./views";

type Ids = Record<string, true>;

/** Whether a task is the team's: listed as such, or inside a team project or task (a row
 * created a moment ago, before the core confirmed where it went). */
export function isTeamTask(task: Task, teamIds: Ids): boolean {
  return (
    teamIds[task.id] === true ||
    (task.project_id !== null && teamIds[task.project_id] === true) ||
    (task.parent_id !== null && teamIds[task.parent_id] === true)
  );
}

/** A member's name; a removed member's id shows as "Former member". */
export function memberName(members: Record<string, Member>, id: string | null | undefined) {
  if (!id) return null;
  return members[id]?.name ?? "Former member";
}

/** Up to two initials, for avatars. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return letters
    .map((p) => p?.[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2);
}

/** One person's column on the Team page. */
export interface MemberWork {
  /** `null`: unassigned tasks. */
  member: Member | null;
  inProgress: Task[];
  todo: Task[];
  overdue: Task[];
  /** Finished in the last seven days. */
  doneThisWeek: Task[];
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

/**
 * The team's open and recent work by assignee: the signed-in member first, then the others
 * by name, then the unassigned. Agent tasks and subtasks stay out (their parent counts).
 */
export function teamWork(
  tasks: Task[],
  members: Record<string, Member>,
  ctx: ViewContext,
  me: string | null,
  now: number,
): MemberWork[] {
  const byMember = new Map<string | null, MemberWork>();
  const column = (id: string | null): MemberWork => {
    let work = byMember.get(id);
    if (!work) {
      const member =
        id === null
          ? null
          : (members[id] ?? {
              id,
              name: "Former member",
              color: null,
              created_at: 0,
              updated_at: 0,
              deleted_at: null,
            });
      work = { member, inProgress: [], todo: [], overdue: [], doneThisWeek: [] };
      byMember.set(id, work);
    }
    return work;
  };
  for (const id of Object.keys(members)) column(id);
  for (const task of tasks) {
    if (task.owner === "agent" || task.parent_id !== null) continue;
    const work = column(task.assignee_id ?? null);
    const category = categoryOf(task, ctx);
    if (category === "done") {
      if (task.completed_at !== null && now - task.completed_at <= WEEK_MS) {
        work.doneThisWeek.push(task);
      }
      continue;
    }
    if (!isOpen(task, ctx)) continue;
    if (task.due_date !== null && task.due_date < ctx.today) work.overdue.push(task);
    if (category === "in_progress") work.inProgress.push(task);
    else work.todo.push(task);
  }
  const rank = (a: Task, b: Task) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0);
  for (const work of byMember.values()) {
    work.inProgress.sort(rank);
    work.todo.sort(rank);
    work.overdue.sort((a, b) => ((a.due_date ?? "") < (b.due_date ?? "") ? -1 : 1));
    work.doneThisWeek.sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
  }
  const unassigned = byMember.get(null);
  byMember.delete(null);
  const people = [...byMember.values()].sort((a, b) => {
    if (a.member?.id === me) return -1;
    if (b.member?.id === me) return 1;
    return (a.member?.name ?? "").localeCompare(b.member?.name ?? "");
  });
  // Removed members only show while they still hold open work.
  const shown = people.filter(
    (w) =>
      (w.member && members[w.member.id]) ||
      w.inProgress.length + w.todo.length + w.overdue.length > 0,
  );
  if (unassigned && unassigned.inProgress.length + unassigned.todo.length > 0) {
    shown.push(unassigned);
  }
  return shown;
}

const SEEN_KEY = "task-master.team-notices-seen";

/** The newest notice this device has shown on the Team page. */
export function seenNotice(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function markNoticesSeen(seq: number) {
  try {
    if (seq > seenNotice()) localStorage.setItem(SEEN_KEY, String(seq));
  } catch {
    // Storage off: the count shows again next time.
  }
}
