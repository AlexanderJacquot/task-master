// "Send to agent" (ADR 017): pick the folder and permissions, add instructions, and start
// a background agent session on the task.

import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { Button, cx, INPUT, Select } from "../../components/ui";
import type { AgentSession, AgentSettings, Changes, ProjectFolder, Task } from "../../lib/types";
import { startTimer } from "../../store/actions";
import { useApi, useStoreState, useTaskStore } from "../../store/context";
import {
  DEFAULT_MODEL,
  defaultFolder,
  folderName,
  formatCost,
  MODELS,
  PERMISSION_MODES,
  recentFolders,
} from "./sessions";
import { limitStatuses, PERIOD_LABEL } from "./usage";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A started session as `Changes`, so the store shows it before the shell's event. */
export function sessionChanges(session: AgentSession): Changes {
  return {
    batch_id: null,
    op_seq: null,
    tasks: [],
    projects: [],
    epics: [],
    tags: [],
    views: [],
    statuses: [],
    attachments: [],
    time_blocks: [],
    agent_sessions: [session],
    agent_notes: [],
  };
}

export function SendToAgentDialog({
  task,
  open,
  onOpenChange,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useApi().agents;
  const store = useTaskStore();
  const sessions = useStoreState((s) => s.agent_sessions);
  const projects = useStoreState((s) => s.projects);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [folder, setFolder] = useState("");
  const [mode, setMode] = useState("acceptEdits");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmOver, setConfirmOver] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [brief, setBrief] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load settings and folders each time it opens, then prefill.
  // biome-ignore lint/correctness/useExhaustiveDependencies: prefill only on open, not on every store change.
  useEffect(() => {
    if (!open || !api) return;
    let live = true;
    setError(null);
    setBrief(null);
    setPrompt("");
    setConfirmAll(false);
    setConfirmOver(false);
    Promise.all([api.settings(), api.folders()]).then(
      ([s, f]) => {
        if (!live) return;
        setSettings(s);
        setFolders(f);
        setMode(s.permission_mode);
        setModel(s.model && MODELS.some((m) => m.value === s.model) ? s.model : DEFAULT_MODEL);
        setFolder(defaultFolder(task, sessions, f, projects, s.runtime));
      },
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [open, api, task.id]);

  if (!api) return null;
  const recents = settings ? recentFolders(sessions, settings.runtime) : [];
  const projectFolder = folders.find((f) => f.project_id === task.project_id)?.path;
  const limits = limitStatuses(Object.values(sessions), settings?.limits, Date.now());
  const spent = limits.filter((l) => l.over);
  const needsConfirm =
    (mode === "bypassPermissions" && !confirmAll) || (spent.length > 0 && !confirmOver);
  const canStart = !!folder.trim() && !!settings && !busy && !needsConfirm;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await api.start({
        task_id: task.id,
        folder: folder.trim(),
        permission_mode: mode,
        // The settings' own model (possibly a full name not in the list) stays as is.
        model: model === DEFAULT_MODEL ? null : model,
        prompt,
      });
      store.getState().record(sessionChanges(session));
      // The work timer runs while the agent works; it stops when the session ends.
      void startTimer(store, task.id, session.started_at, session.id);
      // Offer the folder as the project's when it has none on this device yet.
      if (task.project_id && !projectFolder) {
        void api.setFolder(task.project_id, folder.trim()).catch(() => undefined);
      }
      onOpenChange(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const loadBrief = () => {
    if (brief !== null) return;
    api.brief(task.id).then(setBrief, (e) => setBrief(`Cannot load the brief: ${message(e)}`));
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="tex-sheet fixed top-[10%] left-1/2 z-50 flex max-h-[80vh] w-[36rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-4 overflow-y-auto rounded-2xl border border-line-strong bg-overlay p-5 shadow-2xl shadow-black/40"
        >
          <Dialog.Title className="font-display text-[19px] tracking-wide text-accent">
            Send to agent
          </Dialog.Title>
          <p className="-mt-2 truncate text-sm text-ink-2" title={task.title}>
            {task.title}
          </p>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-3">
              Folder
              {settings?.runtime === "wsl" && " (in WSL)"}
            </span>
            <div className="flex gap-2">
              <input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder={settings?.runtime === "wsl" ? "/home/you/project" : "Choose a folder"}
                aria-label="Folder"
                className={cx(INPUT, "py-1 text-[13px]")}
              />
              <Button
                size="sm"
                onClick={() => void api.pickFolder().then((picked) => picked && setFolder(picked))}
              >
                Browse…
              </Button>
            </div>
          </label>
          {recents.length > 0 && (
            <fieldset
              className="-mt-2 flex flex-wrap gap-1.5 border-0 p-0"
              aria-label="Recent folders"
            >
              {recents.map((path) => (
                <button
                  key={path}
                  type="button"
                  title={path}
                  onClick={() => setFolder(path)}
                  className={cx(
                    "rounded-md px-2 text-[12px] leading-5 transition-colors",
                    path === folder
                      ? "bg-accent/15 text-accent"
                      : "bg-hover text-ink-2 hover:text-ink",
                  )}
                >
                  {folderName(path)}
                </button>
              ))}
            </fieldset>
          )}

          <div className="flex flex-col gap-1 text-xs">
            <span className="text-ink-3">Agent may</span>
            <Select
              value={mode}
              onValueChange={(value) => {
                setMode(value);
                setConfirmAll(false);
              }}
              aria-label="Permissions"
              className="w-56"
              options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label }))}
            />
            <span className="text-ink-3">
              {PERMISSION_MODES.find((m) => m.value === mode)?.hint}
            </span>
            {mode === "bypassPermissions" && (
              <label className="flex items-center gap-2 text-ink-2">
                <input
                  type="checkbox"
                  checked={confirmAll}
                  onChange={(e) => setConfirmAll(e.target.checked)}
                  className="accent-accent"
                />
                I understand the agent will run commands without asking.
              </label>
            )}
          </div>

          <div className="flex flex-col gap-1 text-xs">
            <span className="text-ink-3">Model</span>
            <Select
              value={model}
              onValueChange={setModel}
              aria-label="Model"
              className="w-56"
              options={[
                {
                  value: DEFAULT_MODEL,
                  label: settings?.model ? `Default (${settings.model})` : "Default",
                },
                ...MODELS,
              ]}
            />
          </div>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-3">Instructions (optional)</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="What to do, or what to leave alone. The task's context is sent anyway."
              className={cx(INPUT, "resize-y text-[13px]")}
            />
          </label>

          <details onToggle={(e) => e.currentTarget.open && loadBrief()}>
            <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink-2">
              What the agent gets
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-hover p-3 text-[12px] whitespace-pre-wrap text-ink-2">
              {brief ?? "Loading…"}
            </pre>
          </details>

          {spent.length > 0 && (
            <div className="flex flex-col gap-1 rounded-lg bg-rubric/10 px-3 py-2 text-xs">
              {spent.map((l) => (
                <p key={l.period} className="text-ink">
                  {formatCost(l.spentMicros)} spent {PERIOD_LABEL[l.period].toLowerCase()}, over
                  the {formatCost(l.limitMicros)} limit.
                </p>
              ))}
              <label className="flex items-center gap-2 text-ink-2">
                <input
                  type="checkbox"
                  checked={confirmOver}
                  onChange={(e) => setConfirmOver(e.target.checked)}
                  className="accent-accent"
                />
                Start anyway
              </label>
            </div>
          )}

          {error && (
            <p role="alert" className="text-xs text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!canStart} onClick={() => void start()}>
              {busy ? "Starting…" : "Start"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
