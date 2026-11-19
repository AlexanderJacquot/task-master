// The small agent status on a task card or row (ADR 017): what a running session is
// doing, or how the last one ended; and a session's state on its card or row.

import { useState } from "react";
import { AgentsIcon as Bot } from "../../components/TaskIcons";
import { cx, FOCUS } from "../../components/ui";
import type { AgentSession, SessionState } from "../../lib/types";
import { useApi, useStoreState } from "../../store/context";
import { STATE_LABEL, shownSession } from "./sessions";

export const STATE_TONE: Record<SessionState, string> = {
  running: "bg-accent/12 text-accent",
  done: "bg-emerald-600/12 text-emerald-800 dark:bg-emerald-400/12 dark:text-emerald-200",
  failed: "bg-red-600/12 text-red-800 dark:bg-red-400/12 dark:text-red-200",
  cancelled: "bg-hover text-ink-3",
  interrupted: "bg-amber-600/12 text-amber-800 dark:bg-amber-400/12 dark:text-amber-200",
  terminal: "bg-accent/12 text-accent",
  desktop: "bg-accent/12 text-accent",
};

export function SessionChip({ taskId, className }: { taskId: string; className?: string }) {
  const session = useStoreState((s) => shownSession(s.agent_sessions, taskId));
  const activity = useStoreState((s) => (session ? s.agentActivity[session.id] : undefined));
  if (!session) return null;
  const running = session.state === "running";
  // A run of another device has no live activity here.
  const text = running ? (activity ?? "Running") : `Agent · ${STATE_LABEL[session.state]}`;
  return (
    <span
      data-testid="session-chip"
      title={running ? `Agent: ${text}` : (session.summary ?? session.error ?? text)}
      className={cx(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 text-[12px] leading-5",
        STATE_TONE[session.state],
        className,
      )}
    >
      <Bot size={12} className={cx("shrink-0", running && "animate-pulse")} aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  );
}

/**
 * A session's state. "In desktop app" is a button that brings its conversation up in the
 * Claude desktop app (ADR 029); why it could not goes to `onError` (null when it tries).
 */
export function StateBadge({
  session,
  className,
  onError,
}: {
  session: AgentSession;
  className?: string;
  onError: (message: string | null) => void;
}) {
  const api = useApi().agents;
  const [busy, setBusy] = useState(false);
  const tone = cx("rounded-md px-1.5 text-[12px] leading-5", STATE_TONE[session.state], className);
  if (session.state !== "desktop" || !api) {
    return <span className={tone}>{STATE_LABEL[session.state]}</span>;
  }
  const open = async () => {
    setBusy(true);
    onError(null);
    try {
      await api.openDesktop(session.id);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      title="Open the conversation in the Claude desktop app"
      disabled={busy}
      onClick={() => void open()}
      className={cx(
        tone,
        FOCUS,
        "underline decoration-dotted underline-offset-2 enabled:hover:decoration-solid disabled:opacity-60",
      )}
    >
      {STATE_LABEL.desktop}
    </button>
  );
}
