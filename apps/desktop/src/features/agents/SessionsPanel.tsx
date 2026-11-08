// A task's agent sessions (ADR 017): status, summary, notes and the actions on each.

import { useEffect, useState } from "react";
import {
  AgentsIcon as Bot,
  DoneIcon,
  PlayIcon as Play,
  SendIcon as Send,
  TerminalIcon as SquareTerminal,
  StopIcon,
  DeleteIcon as Trash2,
} from "../../components/TaskIcons";
import { Button, cx, IconButton, INPUT, SectionLabel } from "../../components/ui";
import { formatAgo } from "../../lib/dates";
import type { AgentNote, AgentSession, Task } from "../../lib/types";
import { markSessionDone, removeAgentSession } from "../../store/actions";
import { useApi, useStoreState, useTaskStore } from "../../store/context";
import { MarkdownView } from "../task-detail/MarkdownView";
import { SendToAgentDialog } from "./SendToAgentDialog";
import { STATE_TONE } from "./SessionChip";
import {
  folderName,
  formatCost,
  formatDuration,
  PERMISSION_MODES,
  RESUME_MESSAGE,
  STATE_LABEL,
  sessionsOf,
} from "./sessions";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The "Send to agent" button with its dialog. */
export function SendToAgentButton({ task, className }: { task: Task; className?: string }) {
  const api = useApi().agents;
  const [open, setOpen] = useState(false);
  if (!api) return null;
  return (
    <>
      <Button size="sm" className={className} onClick={() => setOpen(true)}>
        <Bot size={14} />
        Send to agent
      </Button>
      <SendToAgentDialog task={task} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function SessionsPanel({ task, page }: { task: Task; page: boolean }) {
  const api = useApi().agents;
  const all = useStoreState((s) => s.agent_sessions);
  const sessions = sessionsOf(all, task.id);
  if (!api) return null;
  return (
    <section aria-label="agent sessions" className={cx("flex flex-col gap-2", page && "pl-10")}>
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Agent</SectionLabel>
        <SendToAgentButton task={task} />
      </div>
      {sessions.length === 0 ? (
        <p className="text-xs text-ink-3">
          No sessions yet. The agent works in the background and reports here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((session, i) => (
            <SessionCard key={session.id} session={session} expanded={i === 0} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SessionCard({ session, expanded }: { session: AgentSession; expanded: boolean }) {
  const { agents: api, files } = useApi();
  const store = useTaskStore();
  const activity = useStoreState((s) => s.agentActivity[session.id]);
  const [notes, setNotes] = useState<AgentNote[] | null>(null);
  const [open, setOpen] = useState(expanded);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const running = session.state === "running";
  const inTerminal = session.state === "terminal";

  // Notes change while it runs; reload them with the session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: updated_at is the reload trigger (each note bumps it).
  useEffect(() => {
    if (!open || !api) return;
    let live = true;
    api.notes(session.task_id, session.id, 100).then(
      (list) => live && setNotes(list),
      () => live && setNotes([]),
    );
    return () => {
      live = false;
    };
  }, [open, api, session.task_id, session.id, session.updated_at]);

  // A running session's duration ticks.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (!api) return null;
  const act = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const duration = formatDuration((session.ended_at ?? now) - session.started_at);
  const cost = formatCost(session.cost_usd_micros);
  const mode = PERMISSION_MODES.find((m) => m.value === session.permission_mode)?.label;

  return (
    <li
      data-testid="session-card"
      className="flex flex-col gap-2 rounded-xl border border-line bg-raised/60 p-3 text-[13px]"
    >
      <div className="flex items-center gap-2">
        <span className={cx("rounded-md px-1.5 text-[12px] leading-5", STATE_TONE[session.state])}>
          {STATE_LABEL[session.state]}
        </span>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="min-w-0 flex-1 truncate text-left text-ink-2 hover:text-ink"
          title={session.folder}
          aria-expanded={open}
        >
          {folderName(session.folder)} · {formatAgo(session.started_at, now)} · {duration}
          {cost && ` · ${cost}`}
        </button>
        <IconButton
          label={running ? "Continue in terminal (stops the background run)" : "Open in terminal"}
          disabled={!!busy}
          onClick={() => void act("terminal", () => api.openTerminal(session.id))}
        >
          <SquareTerminal size={15} />
        </IconButton>
        {session.state === "interrupted" && (
          <Button
            size="sm"
            disabled={!!busy}
            onClick={() => void act("resume", () => api.send(session.id, RESUME_MESSAGE))}
          >
            <Play size={13} />
            {busy === "resume" ? "Resuming…" : "Resume"}
          </Button>
        )}
        {running ? (
          <IconButton
            label="Stop"
            disabled={!!busy}
            onClick={() => void act("stop", () => api.cancel(session.id))}
          >
            <StopIcon size={14} />
          </IconButton>
        ) : inTerminal ? (
          <IconButton
            label="Mark done"
            disabled={!!busy}
            onClick={() => void act("done", () => markSessionDone(store, session.id))}
          >
            <DoneIcon size={14} />
          </IconButton>
        ) : (
          <IconButton
            label="Remove from history"
            disabled={!!busy}
            onClick={() => void removeAgentSession(store, session.id)}
          >
            <Trash2 size={14} />
          </IconButton>
        )}
      </div>

      {running && (
        <p role="status" className="flex items-center gap-1.5 truncate text-accent">
          <Bot size={13} className="shrink-0 animate-pulse" aria-hidden />
          {activity ?? "Running on another device"}
        </p>
      )}
      {inTerminal && (
        <p role="status" className="flex items-center gap-1.5 text-accent">
          <SquareTerminal size={13} className="shrink-0" aria-hidden />
          Continuing in a terminal. When the agent records its summary, or you mark it done, the
          terminal closes a few seconds later.
        </p>
      )}

      {open && (
        <>
          {session.prompt && (
            <p className="text-xs text-ink-3">
              Asked: <span className="text-ink-2">{session.prompt}</span>
            </p>
          )}
          {session.summary && (
            <div data-testid="session-summary">
              <MarkdownView
                source={session.summary}
                attachments={{}}
                actions={{ openUrl: (url) => void files?.openUrl(url).catch(() => {}) }}
                className="text-ink"
              />
            </div>
          )}
          {session.error && (
            <p className="whitespace-pre-wrap text-xs text-red-700 dark:text-red-300">
              {session.error}
            </p>
          )}
          {notes && notes.length > 0 && (
            <ul className="flex flex-col gap-1 border-l-2 border-line pl-2.5 text-xs text-ink-2">
              {notes.map((n) => (
                <li key={n.id}>
                  <span className="text-ink-3">{formatAgo(n.created_at, now)} · </span>
                  {n.body}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-ink-3">
            {mode && `${mode} · `}
            {session.turns !== null && `${session.turns} turns · `}
            {session.runtime === "wsl" ? "WSL" : "native"}
          </p>
          {!running && !inTerminal && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const text = reply.trim();
                if (!text) return;
                void act("send", async () => {
                  await api.send(session.id, text);
                  setReply("");
                });
              }}
            >
              <input
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Reply to continue this session…"
                aria-label="Follow-up message"
                className={cx(INPUT, "py-1 text-[13px]")}
              />
              <Button size="sm" type="submit" disabled={!reply.trim() || !!busy}>
                <Send size={13} />
                Send
              </Button>
            </form>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </li>
  );
}
