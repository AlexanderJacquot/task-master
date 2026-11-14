// A meeting (Scribe, ADR 025): when it is, what it is linked to, who takes part, the notes
// and the files. Every field saves on change; Ctrl+Z undoes like any other edit.

import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { DatePicker } from "../../components/DatePicker";
import {
  ArrowLeftIcon as ArrowLeft,
  ScribeIcon,
  DeleteIcon as Trash2,
  CloseIcon as X,
} from "../../components/TaskIcons";
import { Button, cx, IconButton, SectionLabel, Select } from "../../components/ui";
import { formatDuration } from "../../lib/calendar";
import { isoDate } from "../../lib/dates";
import {
  cleanParticipants,
  MINUTE,
  meetingLabel,
  meetingPhase,
  moveStart,
  participantSuggestions,
  timeValue,
  withDate,
  withTime,
} from "../../lib/meetings";
import type { Meeting, MeetingChange } from "../../lib/types";
import { deleteMeeting, updateMeeting } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { useNow } from "../calendar/TimeGrid";
import { EpicMark } from "../organize/EpicMark";
import { ProjectMark } from "../organize/ProjectMark";
import { EditableTitle } from "../shell/EditableTitle";
import { AttachmentList } from "../task-detail/AttachmentList";
import { DescriptionEditor } from "../task-detail/DescriptionEditor";
import { TaskPicker } from "../task-detail/TaskPicker";
import { useMeetingAttachments, useMeetingFiles } from "../task-detail/useTaskFiles";

/** Date, start and end of the meeting. Moving the date or the start keeps its length. */
function WhenFields({
  meeting,
  change,
}: {
  meeting: Meeting;
  change: (c: MeetingChange[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const setEnd = (value: string) => {
    const end = withTime(meeting.started_at, value);
    if (end === null) return;
    if (end <= meeting.started_at) {
      setError("The meeting must end after it starts.");
      return;
    }
    setError(null);
    change([{ ended_at: end }]);
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">
        <DatePicker
          aria-label="Meeting date"
          value={isoDate(new Date(meeting.started_at))}
          onValueChange={(iso) => {
            const start = iso ? withDate(meeting.started_at, iso) : null;
            if (start !== null) change(moveStart(meeting, start));
          }}
        />
        <input
          type="time"
          aria-label="Start time"
          value={timeValue(meeting.started_at)}
          onChange={(e) => {
            const start = withTime(meeting.started_at, e.currentTarget.value);
            if (start !== null && start !== meeting.started_at) {
              setError(null);
              change(moveStart(meeting, start));
            }
          }}
          className="rounded-md border border-transparent bg-transparent px-1 py-0.5 tabular-nums hover:border-line-strong focus:border-accent focus:outline-none"
        />
        <span aria-hidden>–</span>
        {meeting.ended_at === null ? (
          <span className="text-ink-3">no end yet</span>
        ) : (
          <input
            type="time"
            aria-label="End time"
            value={timeValue(meeting.ended_at)}
            onChange={(e) => setEnd(e.currentTarget.value)}
            className="rounded-md border border-transparent bg-transparent px-1 py-0.5 tabular-nums hover:border-line-strong focus:border-accent focus:outline-none"
          />
        )}
        {meeting.ended_at !== null && (
          <span className="text-ink-3">
            {formatDuration((meeting.ended_at - meeting.started_at) / MINUTE)}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Project, epic and task the meeting is about; each optional. */
function LinkFields({
  meeting,
  change,
}: {
  meeting: Meeting;
  change: (c: MeetingChange[]) => void;
}) {
  const projects = useStoreState((s) => s.projects);
  const epics = useStoreState((s) => s.epics);
  const task = useStoreState((s) => (meeting.task_id ? s.tasks[meeting.task_id] : undefined));
  const store = useTaskStore();
  const projectOptions = useMemo(
    () => [
      { value: "", label: "No project" },
      ...Object.values(projects)
        .filter((p) => p.archived_at === null || p.id === meeting.project_id)
        .sort((a, b) => (a.rank < b.rank ? -1 : 1))
        .map((p) => ({ value: p.id, label: p.name, icon: <ProjectMark project={p} /> })),
    ],
    [projects, meeting.project_id],
  );
  const epicOptions = useMemo(
    () => [
      { value: "", label: "No epic" },
      ...Object.values(epics)
        .filter((e) => e.state === "active" || e.id === meeting.epic_id)
        .sort((a, b) => (a.rank < b.rank ? -1 : 1))
        .map((e) => ({ value: e.id, label: e.name, icon: <EpicMark epic={e} /> })),
    ],
    [epics, meeting.epic_id],
  );
  return (
    <div className="flex flex-wrap items-center gap-3 text-[13.5px] text-ink-2">
      <Select
        aria-label="Project"
        value={meeting.project_id ?? ""}
        onValueChange={(id) => change([{ project_id: id || null }])}
        options={projectOptions}
      />
      <Select
        aria-label="Epic"
        value={meeting.epic_id ?? ""}
        onValueChange={(id) => {
          const epic = id ? epics[id] : undefined;
          // An epic with a home project brings it along when the meeting has none.
          const project =
            epic?.project_id && !meeting.project_id ? [{ project_id: epic.project_id }] : [];
          change([{ epic_id: id || null }, ...project]);
        }}
        options={epicOptions}
      />
      <span className="flex min-w-0 items-center gap-1">
        <TaskPicker
          label="Link a task"
          trigger={task ? task.title : "Link a task…"}
          triggerClassName={cx(
            "max-w-72 truncate rounded-md px-1.5 py-0.5 hover:bg-hover",
            task ? "text-ink" : "text-accent",
          )}
          candidates={() =>
            Object.values(store.getState().tasks).sort((a, b) => b.updated_at - a.updated_at)
          }
          onPick={(t) => {
            const links: MeetingChange[] = [{ task_id: t.id }];
            if (!meeting.project_id && t.project_id) links.push({ project_id: t.project_id });
            if (!meeting.epic_id && t.epic_id) links.push({ epic_id: t.epic_id });
            change(links);
          }}
        />
        {task && (
          <>
            <Link
              to="/task/$taskId"
              params={{ taskId: task.id }}
              search={{}}
              className="text-[12.5px] text-accent hover:underline"
            >
              Open
            </Link>
            <IconButton label="Unlink the task" onClick={() => change([{ task_id: null }])}>
              <X size={13} />
            </IconButton>
          </>
        )}
      </span>
    </div>
  );
}

/** Participants as chips; typing suggests names used in earlier meetings. */
export function ParticipantsField({
  names,
  onChange,
}: {
  names: string[];
  onChange: (names: string[]) => void;
}) {
  const meetings = useStoreState((s) => s.meetings);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const suggestions = useMemo(
    () => participantSuggestions(Object.values(meetings), draft, names),
    [meetings, draft, names],
  );
  const add = (raw: string) => {
    // Several names can be pasted at once, separated by commas or new lines.
    const added = raw.split(/[,;\n]/);
    const next = cleanParticipants([...names, ...added]);
    setDraft("");
    if (next.length !== names.length) onChange(next);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <ul aria-label="Participants" className="flex flex-wrap items-center gap-1.5">
        {names.map((name) => (
          <li
            key={name}
            className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-raised py-0.5 pr-1 pl-2.5 text-[13px] text-ink"
          >
            {name}
            <button
              type="button"
              aria-label={`Remove ${name}`}
              onClick={() => onChange(names.filter((n) => n !== name))}
              className="rounded-full p-0.5 text-ink-3 hover:bg-hover hover:text-ink"
            >
              <X size={11} />
            </button>
          </li>
        ))}
        <li className="relative">
          <input
            aria-label="Add a participant"
            value={draft}
            placeholder={names.length ? "Add someone" : "Who takes part?"}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              if (draft.trim()) add(draft);
            }}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                if (draft.trim()) add(draft);
              } else if (e.key === "Backspace" && !draft && names.length) {
                onChange(names.slice(0, -1));
              } else if (e.key === "Escape") setDraft("");
            }}
            className="w-44 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[13px] placeholder:text-ink-3 hover:border-line-strong focus:border-accent focus:outline-none"
          />
          {focused && suggestions.length > 0 && (
            <ul
              aria-label="Suggestions"
              className="absolute top-full left-0 z-30 mt-1 flex w-56 flex-col rounded-lg border border-line-strong bg-overlay p-1 shadow-lg"
            >
              {suggestions.map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    // Before the input's blur, so the click lands.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      add(name);
                    }}
                    className="w-full rounded-md px-2 py-1 text-left text-[13px] hover:bg-hover"
                  >
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </li>
      </ul>
    </div>
  );
}

function MeetingEditor({ meeting }: { meeting: Meeting }) {
  const store = useTaskStore();
  const now = useNow();
  const files = useMeetingFiles(meeting.id);
  const attachments = useMeetingAttachments(meeting.id);
  const attachmentsById = useStoreState((s) => s.attachments);
  const change = (changes: MeetingChange[]) => void updateMeeting(store, meeting.id, changes);
  const phase = meetingPhase(meeting, now);
  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ScribeIcon size={26} className="shrink-0 text-rubric" />
          <EditableTitle
            value={meeting.title}
            placeholder="Meeting title"
            onRename={(title) => change([{ title }])}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 pl-10">
          <span
            className={cx(
              "rounded-full px-2 py-0.5 text-[12px]",
              phase === "now" ? "bg-accent/15 text-accent" : "bg-hover text-ink-2",
            )}
          >
            {meetingLabel(meeting, now)}
          </span>
          <WhenFields meeting={meeting} change={change} />
          {phase === "now" && meeting.ended_at !== null && meeting.state !== "recording" && (
            <Button
              size="sm"
              onClick={() =>
                change([
                  { ended_at: Math.max(Date.now(), meeting.started_at + MINUTE) },
                  { state: "held" },
                ])
              }
            >
              End now
            </Button>
          )}
          {phase === "upcoming" && (
            <Button
              size="sm"
              onClick={() => {
                const start = Math.floor(Date.now() / MINUTE) * MINUTE;
                change([...moveStart(meeting, start), { state: "held" }]);
              }}
            >
              Start now
            </Button>
          )}
        </div>
        <div className="pl-10">
          <LinkFields meeting={meeting} change={change} />
        </div>
      </div>
      <section aria-label="Participants" className="pl-10">
        <SectionLabel className="mb-1.5 block">Participants</SectionLabel>
        <ParticipantsField
          names={meeting.participants}
          onChange={(participants) => change([{ participants }])}
        />
      </section>
      <section aria-label="Notes" className="pl-10">
        <SectionLabel className="mb-1 block">Notes</SectionLabel>
        <DescriptionEditor
          value={meeting.notes}
          onSave={(notes) => notes !== meeting.notes && change([{ notes }])}
          size="page"
          attachments={attachmentsById}
          actions={files.actions}
          upload={files.uploader}
        />
      </section>
      <AttachmentList
        attachments={attachments}
        files={files}
        page
        onInsert={(markdown) => {
          const text = meeting.notes.replace(/\s+$/, "");
          change([{ notes: text ? `${text}\n\n${markdown}` : markdown }]);
        }}
      />
      <p className="pl-10 text-[12.5px] text-ink-3">
        Recording and transcription come later; for now Scribe keeps the meeting, its people, notes
        and files.
      </p>
    </div>
  );
}

export function MeetingPage({ meetingId }: { meetingId: string }) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const meeting = useStoreState((s) => s.meetings[meetingId]);
  const project = useStoreState((s) =>
    meeting?.project_id ? s.projects[meeting.project_id] : undefined,
  );
  if (!meeting) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-3">
        This meeting no longer exists.
        <Link to="/scribe" search={{}} className="text-accent hover:underline">
          Back to Scribe
        </Link>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-6 py-3 text-[13.5px] text-ink-2">
        <Link
          to="/scribe"
          search={{}}
          title="Back to Scribe"
          className="flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink"
        >
          <ArrowLeft size={15} />
          Scribe
        </Link>
        {project && (
          <Link
            to="/project/$projectId"
            params={{ projectId: project.id }}
            search={{}}
            className="flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink"
          >
            <ProjectMark project={project} />
            {project.name}
          </Link>
        )}
        <span className="flex-1" />
        <IconButton
          label="Delete the meeting (Ctrl+Z to undo)"
          onClick={() => {
            void deleteMeeting(store, meeting.id);
            void navigate({ to: "/scribe", search: {} });
          }}
          className="hover:text-danger"
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        <article className="tex-sheet mx-auto max-w-[820px] rounded-xl border border-line bg-raised px-10 py-11 shadow-xl shadow-black/10 sm:px-14 clean:border-transparent clean:pt-4 clean:shadow-none">
          <MeetingEditor key={meeting.id} meeting={meeting} />
        </article>
      </div>
    </div>
  );
}
