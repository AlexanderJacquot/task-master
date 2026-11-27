// How the task panel and the full task page behave, remembered per machine (Settings →
// Finishing tasks), like the theme.

const CLOSE_KEY = "task-master.detail.close-on-done";

/** True (the default): marking a task done closes its panel or full page. */
export function loadCloseOnDone(): boolean {
  try {
    return localStorage.getItem(CLOSE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveCloseOnDone(close: boolean) {
  try {
    localStorage.setItem(CLOSE_KEY, close ? "1" : "0");
  } catch {
    // Not persisted; the default applies next time.
  }
}
