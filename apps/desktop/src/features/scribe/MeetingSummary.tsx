// A meeting's summary, and "Send to Claude" (ADR 040): an agent session reads the meeting
// with its transcript, writes the summary here, creates the tasks it calls for and writes
// the meeting note in Notes (ADR 042). This is the one step that sends the transcript off
// the device, and only on this click (ADR 025).

import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, SectionLabel } from "../../components/ui";
import { followUpPrompt, followUpTitle } from "../../lib/meetings";
import { meetingNoteHeader, meetingNoteTitle } from "../../lib/notes";
import type { Attachment, Meeting, MeetingChange } from "../../lib/types";
import { createTask, updateMeeting } from "../../store/actions";
import { useApi, useStoreState, useTaskStore } from "../../store/context";
import { SendToAgentDialog } from "../agents/SendToAgentDialog";
import { meetingNoteLinks } from "../notes/MeetingNotes";
import { DescriptionEditor, type Uploader } from "../task-detail/DescriptionEditor";
import type { MarkdownActions } from "../task-detail/MarkdownView";

export function MeetingSummary({
  meeting,
  change,
  attachments,
  actions,
  upload,
}: {
  meeting: Meeting;
  change: (c: MeetingChange[]) => void;
  attachments: Record<string, Attachment>;
  actions: MarkdownActions;
  upload?: Uploader;
}) {
  const agents = useApi().agents;
  const store = useTaskStore();
  const linked = useStoreState((s) => (meeting.task_id ? s.tasks[meeting.task_id] : undefined));
  const live = linked && linked.deleted_at === null ? linked : undefined;
  // Where the tasks it calls for go.
  const projectId = meeting.project_id ?? live?.project_id ?? null;
  const project = useStoreState((s) => (projectId ? s.projects[projectId] : undefined));
  const [open, setOpen] = useState(false);
  const tasks = useStoreState((s) => s.tasks);
  const epics = useStoreState((s) => s.epics);
  const projects = useStoreState((s) => s.projects);
  const noteLinks = useMemo(
    () => meetingNoteLinks({ tasks, epics, projects }, meeting),
    [tasks, epics, projects, meeting],
  );
  const summary = meeting.summary ?? "";
  const said = meeting.transcribed_at !== null || meeting.notes.trim() !== "";
  if (!summary && !(agents && said)) return null;

  const title = followUpTitle(meeting);
  // A task of its own, so the session's end (Review) and its timer never touch the task
  // the meeting is about; under that task when there is one (taking its project and epic).
  const description = `Follow-up of the meeting "${meeting.title.trim()}" (meeting \`${meeting.id}\`).`;
  const prepare = async () => {
    const id = await createTask(
      store,
      live
        ? { title, parent_id: live.id, description }
        : { title, project_id: projectId, epic_id: meeting.epic_id, description },
    );
    // The meeting points at its task so the session may write the summary (MCP).
    if (id && !live) await updateMeeting(store, meeting.id, [{ task_id: id }]);
    return id;
  };

  return (
    <section aria-label="Summary" className="pl-10">
      <div className="mb-1 flex items-center gap-3">
        <SectionLabel>Summary</SectionLabel>
        <span className="flex-1" />
        {agents && said && (
          <Button
            size="sm"
            variant="ghost"
            title="An agent session summarizes the meeting and creates its follow-up tasks"
            onClick={() => setOpen(true)}
          >
            <Sparkles size={13} /> Send to Claude
          </Button>
        )}
      </div>
      {summary ? (
        <DescriptionEditor
          value={summary}
          onSave={(text) => text !== summary && change([{ summary: text.trim() || null }])}
          size="page"
          attachments={attachments}
          actions={actions}
          {...(upload && { upload })}
          taskLinks
        />
      ) : (
        <p className="text-[12.5px] text-ink-3">
          Send to Claude to summarize the meeting and create the tasks it calls for
          {project ? ` in ${project.name}` : ""}. The transcript leaves this device only then.
        </p>
      )}
      {agents && (
        <SendToAgentDialog
          task={{ id: "", title, project_id: live ? live.project_id : projectId }}
          open={open}
          onOpenChange={setOpen}
          initialPrompt={followUpPrompt(
            meeting,
            project ? { id: project.id, name: project.name } : null,
            {
              title: meetingNoteTitle(meeting),
              header: meetingNoteHeader(meeting, noteLinks),
              taskId: noteLinks.task?.id ?? null,
              project: noteLinks.project,
              epic: noteLinks.epic,
            },
          )}
          prepare={prepare}
        />
      )}
    </section>
  );
}
