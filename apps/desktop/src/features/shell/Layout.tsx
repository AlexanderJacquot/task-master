import { Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { useStoreState } from "../../store/context";
import { CommandPalette } from "../palette/CommandPalette";
import { Sidebar } from "../sidebar/Sidebar";
import { TaskDetail } from "../task-detail/TaskDetail";
import { ErrorToast } from "./ErrorToast";
import { useOpenTask } from "./useOpenTask";
import { SHORTCUTS, useShortcuts } from "./useShortcuts";

/** Three panes: sidebar, the current view, and the task detail panel when `?task=` is set. */
export function Layout() {
  const ready = useStoreState((s) => s.ready);
  const loadError = useStoreState((s) => s.loadError);
  const { task } = useSearch({ strict: false }) as { task?: string };
  const openTask = useOpenTask();
  const navigate = useNavigate();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  useShortcuts({
    closeDetail: () => openTask(null),
    openPalette: () => setPalette(true),
    showHelp: () => setHelp(true),
    go: (to) => void navigate({ to, search: {} }),
  });

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
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <ShortcutHelp open={help} onOpenChange={setHelp} />
    </div>
  );
}

function ShortcutHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[15%] left-1/2 z-50 w-[32rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-neutral-200 bg-white p-4 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
        >
          <Dialog.Title className="mb-3 font-semibold">Keyboard shortcuts</Dialog.Title>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
            {SHORTCUTS.map((s) => (
              <div key={s.keys} className="contents">
                <dt className="font-mono text-xs text-neutral-600 dark:text-neutral-300">
                  {s.keys}
                </dt>
                <dd className="text-neutral-700 dark:text-neutral-300">{s.what}</dd>
              </div>
            ))}
          </dl>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-neutral-500">{children}</div>
  );
}
