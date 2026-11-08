// How adding a task from a view's top row behaves, remembered per machine (Settings →
// Adding tasks), like the theme.

const OPEN_KEY = "task-master.capture.open-in-panel";

/** True (the default): a task added from a view's top row opens in the side panel. */
export function loadOpenInPanel(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveOpenInPanel(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Not persisted; the default applies next time.
  }
}

const PROJECT_KEY = "task-master.capture.default-project";

/** The project new tasks go to when the page gives none (null: the Inbox). */
export function loadDefaultProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY) || null;
  } catch {
    return null;
  }
}

export function saveDefaultProject(id: string | null) {
  try {
    if (id) localStorage.setItem(PROJECT_KEY, id);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {
    // Not persisted; the Inbox applies next time.
  }
}

/**
 * Adds the default project to capture defaults that name no project or epic. The Inbox
 * itself keeps adding to the Inbox. Ignored when the project is gone or archived.
 */
export function withDefaultProject<
  T extends { project_id?: string | null; epic_id?: string | null },
>(
  defaults: T,
  projects: Record<string, { deleted_at: number | null; archived_at: number | null }>,
  inInbox = false,
): T {
  if (inInbox || defaults.project_id !== undefined || defaults.epic_id) return defaults;
  const id = loadDefaultProject();
  const p = id ? projects[id] : undefined;
  if (!id || !p || p.deleted_at !== null || p.archived_at !== null) return defaults;
  return { ...defaults, project_id: id };
}
