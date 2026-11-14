// The meetings linked to a task, a project or an epic, on their pages (ADR 025), with a
// button to plan one already linked.

import { useMemo } from "react";
import { AddIcon as Plus } from "../../components/TaskIcons";
import { cx, SectionLabel } from "../../components/ui";
import { meetingsLinkedTo } from "../../lib/meetings";
import { useStoreState } from "../../store/context";
import { useNow } from "../calendar/TimeGrid";
import { useNewMeeting } from "./newMeeting";
import { MeetingRow } from "./ScribePage";

export function MeetingsSection({
  link,
  page = true,
  limit = 8,
  className,
}: {
  link: { project?: string; epic?: string; task?: string };
  page?: boolean;
  /** At most this many are listed; the rest are on the Scribe page. */
  limit?: number;
  className?: string;
}) {
  const meetings = useStoreState((s) => s.meetings);
  const tasks = useStoreState((s) => s.tasks);
  const now = useNow();
  const newMeeting = useNewMeeting();
  const { project, epic, task } = link;
  const linked = useMemo(
    () => meetingsLinkedTo(Object.values(meetings), { project, epic, task }),
    [meetings, project, epic, task],
  );
  // A task page offers to plan one; elsewhere the section shows once there are meetings.
  if (!linked.length && !(link.task && page)) return null;
  const plan = () => {
    const task = link.task ? tasks[link.task] : undefined;
    void newMeeting(false, {
      project_id: link.project ?? task?.project_id ?? null,
      epic_id: link.epic ?? task?.epic_id ?? null,
      task_id: link.task ?? null,
    });
  };
  return (
    <section aria-label="Meetings" className={cx(page && "pl-10", className)}>
      <div className="mb-1.5 flex items-center gap-2">
        {page ? (
          <span className="font-display text-[17px] tracking-wide text-rubric">Meetings</span>
        ) : (
          <SectionLabel>Meetings</SectionLabel>
        )}
        {linked.length > 0 && <span className="text-[12px] text-ink-3">{linked.length}</span>}
        <span className="flex-1" />
        <button
          type="button"
          onClick={plan}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          <Plus size={13} /> Plan a meeting
        </button>
      </div>
      {linked.length > 0 && (
        <ul className="flex flex-col">
          {linked.slice(0, limit).map((m) => (
            <li key={m.id} className="h-14">
              <MeetingRow meeting={m} now={now} />
            </li>
          ))}
          {linked.length > limit && (
            <li className="px-3 pt-1 text-[12.5px] text-ink-3">
              and {linked.length - limit} more on the Scribe page
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
