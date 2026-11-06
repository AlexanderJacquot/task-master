// The small Claude status on a task card or row (ADR 017): what a running session is
// doing, or how the last one ended.

import { AgentsIcon as Bot } from "../../components/TaskIcons";
import { cx } from "../../components/ui";
import type { SessionState } from "../../lib/types";
import { useStoreState } from "../../store/context";
import { STATE_LABEL, shownSession } from "./sessions";

export const STATE_TONE: Record<SessionState, string> = {
  running: "bg-accent/12 text-accent",
  done: "bg-emerald-600/12 text-emerald-800 dark:bg-emerald-400/12 dark:text-emerald-200",
  failed: "bg-red-600/12 text-red-800 dark:bg-red-400/12 dark:text-red-200",
  cancelled: "bg-hover text-ink-3",
  interrupted: "bg-amber-600/12 text-amber-800 dark:bg-amber-400/12 dark:text-amber-200",
  terminal: "bg-accent/12 text-accent",
};

export function SessionChip({ taskId, className }: { taskId: string; className?: string }) {
  const session = useStoreState((s) => shownSession(s.agent_sessions, taskId));
  const activity = useStoreState((s) => (session ? s.agentActivity[session.id] : undefined));
  if (!session) return null;
  const running = session.state === "running";
  // A run of another device has no live activity here.
  const text = running ? (activity ?? "Running") : `Claude · ${STATE_LABEL[session.state]}`;
  return (
    <span
      data-testid="session-chip"
      title={running ? `Claude: ${text}` : (session.summary ?? session.error ?? text)}
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
