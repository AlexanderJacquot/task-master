import type { AgentsApi } from "../lib/api";
import type {
  AgentActivity,
  AgentNote,
  AgentSession,
  AgentSettings,
  AgentStart,
  ProjectFolder,
} from "../lib/types";
import { agentSession } from "./fixtures";

/**
 * The shell's agent commands for tests (ADR 017): records calls, starts sessions as running
 * rows, and lets the test push activity events as the shell would.
 */
export function fakeAgents(
  opts: {
    settings?: Partial<AgentSettings>;
    folders?: ProjectFolder[];
    notes?: AgentNote[];
    live?: AgentActivity[];
  } = {},
) {
  const calls: string[] = [];
  const started: AgentStart[] = [];
  let settings: AgentSettings = {
    runtime: "native",
    wsl_distro: null,
    claude_path: "claude",
    terminal: null,
    permission_mode: "acceptEdits",
    model: null,
    started_status_id: null,
    done_status_id: null,
    directive: null,
    limits: { day_usd_micros: null, week_usd_micros: null, month_usd_micros: null },
    ...opts.settings,
  };
  let folders = opts.folders ?? [];
  let listener: ((e: AgentActivity) => void) | null = null;
  const api: AgentsApi = {
    start: async (input) => {
      started.push(input);
      const session: AgentSession = agentSession({
        task_id: input.task_id,
        folder: input.folder,
        permission_mode: input.permission_mode ?? settings.permission_mode,
        model: input.model ?? null,
        prompt: input.prompt,
        state: "running",
        started_at: Date.now(),
        ended_at: null,
      });
      calls.push(`start ${session.id}`);
      return session;
    },
    send: async (id, message) => {
      calls.push(`send ${id} ${message}`);
    },
    cancel: async (id) => {
      calls.push(`cancel ${id}`);
    },
    openTerminal: async (id) => {
      calls.push(`terminal ${id}`);
    },
    live: async () => opts.live ?? [],
    brief: async (taskId) => `# Brief of ${taskId}`,
    notes: async () => opts.notes ?? [],
    settings: async () => settings,
    saveSettings: async (next) => {
      calls.push("save settings");
      settings = next;
      return settings;
    },
    detect: async (s) => ({ path: `/usr/bin/${s.claude_path}`, version: "2.1.318" }),
    distros: async () => [],
    folders: async () => folders,
    setFolder: async (project_id, path) => {
      calls.push(`folder ${project_id} ${path}`);
      folders = folders.filter((f) => f.project_id !== project_id);
      if (path) folders.push({ project_id, path, runtime: settings.runtime, updated_at: 1 });
      return folders;
    },
    pickFolder: async () => "/picked",
    onActivity: async (handler) => {
      listener = handler;
      return () => {
        listener = null;
      };
    },
  };
  const activity = (session_id: string, text: string | null) =>
    listener?.({ session_id, activity: text });
  return { api, calls, started, activity };
}
