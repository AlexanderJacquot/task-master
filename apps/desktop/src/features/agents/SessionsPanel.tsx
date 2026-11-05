// A task's Claude sessions (ADR 017): status, summary, notes and the actions on each.

import { Bot, Send, Square, SquareTerminal, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, cx, IconButton, INPUT, SectionLabel } from "../../components/ui";
import { formatAgo } from "../../lib/dates";
import type { AgentNote, AgentSession, Task } from "../../lib/types";
import { removeAgentSession } from "../../store/actions";
import { useApi, useStoreState, useTaskStore } from "../../store/context";
import { SendToClaudeDialog } from "./SendToClaudeDialog";
import { STATE_TONE } from "./SessionChip";
import {
  folderName,
  formatCost,
  formatDuration,
  PERMISSION_MODES,
  STATE_LABEL,
  sessionsOf,
} from "./sessions";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The "Send to Claude" button with its dialog. */
export function SendToClaudeButton({ task, className }: { task: Task; className?: string }) {
  const api = useApi().agents;
  const [open, setOpen] = useState(false);
  if (!api) return null;
  return (
    <>
      <Button size="sm" className={className} onClick={() => setOpen(true)}>
        <Bot size={14} />
        Send to Claude
      </Button>
      <SendToClaudeDialog task={task} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function SessionsPanel({ task, page }: { task: Task; page: boolean }) {
  const api = useApi().agents;
  const all = useStoreState((s) => s.agent_sessions);
  const sessions = sessionsOf(all, task.id);
  if (!api) return null;
  return (
    <section aria-label="Claude sessions" className={cx("flex flex-col gap-2", page && "pl-10")}>
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Claude</SectionLabel>
        <SendToClaudeButton task={task} />
      </div>
      {sessions.length === 0 ? (
        <p className="text-xs text-ink-3">
          No sessions yet. Claude works in the background and reports here.
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
  const api = useApi().agents;
  const store = useTaskStore();
  const activity = useStoreState((s) => s.agentActivity[session.id]);
  const [notes, setNotes] = useState<AgentNote[] | null>(null);
  const [open, setOpen] = useState(expanded);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const running = session.state === "running";

  // Notes change while it runs; reload them with the session.
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
          label="Open in terminal"
          disabled={!!busy}
          onClick={() => void act("terminal", () => api.openTerminal(session.id))}
        >
          <SquareTerminal size={15} />
        </IconButton>
        {running ? (
          <IconButton
            label="Stop"
            disabled={!!busy}
            onClick={() => void act("stop", () => api.cancel(session.id))}
          >
            <Square size={14} />
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

      {open && (
        <>
          {session.prompt && (
            <p className="text-xs text-ink-3">
              Asked: <span className="text-ink-2">{session.prompt}</span>
            </p>
          )}
          {session.summary && (
            <p className="whitespace-pre-wrap text-ink" data-testid="session-summary">
              {session.summary}
            </p>
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
          {!running && (
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
