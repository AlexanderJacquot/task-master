import { Outlet, useSearch } from "@tanstack/react-router";
import { useStoreState } from "../../store/context";
import { Sidebar } from "../sidebar/Sidebar";
import { TaskDetail } from "../task-detail/TaskDetail";
import { ErrorToast } from "./ErrorToast";
import { useOpenTask } from "./useOpenTask";
import { useShortcuts } from "./useShortcuts";

/** Three panes: sidebar, the current view, and the task detail panel when `?task=` is set. */
export function Layout() {
  const ready = useStoreState((s) => s.ready);
  const loadError = useStoreState((s) => s.loadError);
  const { task } = useSearch({ strict: false }) as { task?: string };
  const openTask = useOpenTask();
  useShortcuts(() => openTask(null));

  if (loadError) {
    return <Centered>Could not open the task database: {loadError}</Centered>;
  }
  if (!ready) return <Centered>Loading…</Centered>;

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
      {task && <TaskDetail key={task} taskId={task} />}
      <ErrorToast />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-neutral-500">{children}</div>
  );
}
