import { Outlet, useNavigate, useRouter, useRouterState, useSearch } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { KeyList } from "../../components/Keys";
import { Kbd } from "../../components/ui";
import { isoDate } from "../../lib/dates";
import { FIXED_SHORTCUTS, SHORTCUT_DEFS, useKeymap } from "../../lib/keymap";
import type { AppSearch } from "../../router";
import type { NewTaskInput } from "../../store/actions";
import { useStoreState } from "../../store/context";
import { CaptureBox } from "../capture/CaptureBox";
import { CommandPalette } from "../palette/CommandPalette";
import { SIDEBAR_WIDTH, Sidebar } from "../sidebar/Sidebar";
import { useProjectOrder } from "../sidebar/useProjectOrder";
import { TaskDetail } from "../task-detail/TaskDetail";
import { ErrorToast } from "./ErrorToast";
import { type ShellActions, ShellContext } from "./shellContext";
import { customTitleBarStyle, TitleBar, tauriWindowControls } from "./TitleBar";
import { useFileDrop } from "./useFileDrop";
import { useOpenTask } from "./useOpenTask";
import { useShortcuts } from "./useShortcuts";

type Defaults = Omit<NewTaskInput, "title">;

/** What a task created from the New task dialog gets, from the page it was opened on. */
export function defaultsForPath(pathname: string, today: string): Defaults {
  const [, kind, id] = pathname.split("/");
  if (kind === "project" && id) return { project_id: id };
  if (kind === "epic" && id) return { epic_id: id };
  if (kind === "tag" && id) return { tag_ids: [id] };
  if (kind === "today") return { today_on: today };
  return {};
}

const COLLAPSED_KEY = "task-master.sidebar-collapsed";

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Sidebar, the current page, and the task panel when `?task=` is set. The sidebar shrinks
 * to a rail on the full task page (and whenever the user collapses it).
 */
export function Layout() {
  const ready = useStoreState((s) => s.ready);
  const loadError = useStoreState((s) => s.loadError);
  const { task, focus } = useSearch({ strict: false }) as AppSearch;
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const openTask = useOpenTask();
  const navigate = useNavigate();
  const router = useRouter();
  const order = useProjectOrder();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [newTask, setNewTask] = useState<Defaults | null>(null);
  const [collapsedPref, setCollapsedPref] = useState(loadCollapsed);
  const [expandOnTaskPage, setExpandOnTaskPage] = useState(false);
  const onTaskPage = pathname.startsWith("/task/");
  const collapsed = onTaskPage ? !expandOnTaskPage : collapsedPref;

  const toggleCollapsed = () => {
    if (onTaskPage) {
      setExpandOnTaskPage((v) => !v);
      return;
    }
    const next = !collapsedPref;
    setCollapsedPref(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Not remembered; fine.
    }
  };

  const openNewTask = useCallback(
    (defaults?: Defaults) => setNewTask(defaults ?? defaultsForPath(pathname, isoDate())),
    [pathname],
  );
  const shell: ShellActions = useMemo(
    () => ({
      openNewTask,
      openPalette: () => setPalette(true),
      showShortcuts: () => setHelp(true),
    }),
    [openNewTask],
  );

  // Windows and Linux: the frameless main window draws its own title bar (ADR 012).
  const titleBarStyle = useMemo(customTitleBarStyle, []);
  const windowControls = useMemo(
    () => (titleBarStyle ? tauriWindowControls() : null),
    [titleBarStyle],
  );
  useFileDrop();
  useShortcuts({
    closeDetail: () => {
      if (onTaskPage) router.history.back();
      else openTask(null);
    },
    openPalette: () => setPalette(true),
    showHelp: () => setHelp(true),
    newTask: () => openNewTask(),
    goToProject: (n) => {
      const id = order[n - 1];
      if (id) void navigate({ to: "/project/$projectId", params: { projectId: id }, search: {} });
    },
    go: (to) => void navigate({ to, search: {} }),
  });

  const titleBar = (sidebarWidth: number | string) =>
    windowControls &&
    titleBarStyle && (
      <TitleBar controls={windowControls} sidebarWidth={sidebarWidth} variant={titleBarStyle} />
    );

  if (loadError) {
    return (
      <Framed titleBar={titleBar(0)}>
        <Centered>Could not open the task database: {loadError}</Centered>
      </Framed>
    );
  }
  if (!ready) {
    return (
      <Framed titleBar={titleBar(0)}>
        <Centered>Loading…</Centered>
      </Framed>
    );
  }

  return (
    <ShellContext.Provider value={shell}>
      <Framed titleBar={titleBar(collapsed ? SIDEBAR_WIDTH.rail : SIDEBAR_WIDTH.open)}>
        <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        <main className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </main>
        {task && !onTaskPage && (
          <TaskDetail key={task} taskId={task} focusDescription={focus === "description"} />
        )}
        <ErrorToast />
        <CommandPalette open={palette} onOpenChange={setPalette} />
        <ShortcutHelp open={help} onOpenChange={setHelp} />
        <NewTaskDialog
          defaults={newTask}
          onClose={() => setNewTask(null)}
          onOpenTask={(id) =>
            void navigate({
              to: "/task/$taskId",
              params: { taskId: id },
              search: { focus: "description" },
            })
          }
        />
      </Framed>
    </ShellContext.Provider>
  );
}

function NewTaskDialog({
  defaults,
  onClose,
  onOpenTask,
}: {
  defaults: Defaults | null;
  onClose(): void;
  onOpenTask(id: string): void;
}) {
  const projects = useStoreState((s) => s.projects);
  const project = defaults?.project_id ? projects[defaults.project_id] : undefined;
  // Closing hands focus back to what had it before; not when a task just opened to write in.
  const opened = useRef(false);
  return (
    <Dialog.Root open={defaults !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            if (opened.current) e.preventDefault();
            opened.current = false;
          }}
          onEscapeKeyDown={(e) => {
            // The capture box handles Escape itself (it may only cancel a confirmation).
            e.preventDefault();
          }}
          className="tex-sheet fixed top-[16%] left-1/2 z-50 w-[42rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-2xl border border-line-strong bg-overlay shadow-2xl shadow-black/40"
        >
          <Dialog.Title className="px-5 pt-4 font-display text-[15px] tracking-wide text-accent">
            New task{project ? ` in ${project.name}` : ""}
          </Dialog.Title>
          {defaults && (
            <CaptureBox
              variant="dialog"
              autoFocus
              defaults={defaults}
              placeholder="What needs doing?"
              onEscape={onClose}
              onCaptured={(id, how) => {
                opened.current = how.open;
                onClose();
                if (how.open) onOpenTask(id);
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ShortcutHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const keymap = useKeymap();
  const navigate = useNavigate();
  const row = "contents";
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="tex-sheet fixed top-[8%] left-1/2 z-50 flex max-h-[84vh] w-[36rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col rounded-2xl border border-line-strong bg-overlay p-5 shadow-2xl shadow-black/40"
        >
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <Dialog.Title className="font-display text-xl tracking-wide text-accent">
              Keyboard shortcuts
            </Dialog.Title>
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                void navigate({ to: "/settings", search: {}, hash: "shortcuts" });
              }}
              className="text-[13px] text-accent hover:underline"
            >
              Change shortcuts
            </button>
          </div>
          <dl className="grid min-h-0 grid-cols-[1fr_max-content] gap-x-5 gap-y-2 overflow-y-auto text-sm">
            {SHORTCUT_DEFS.map((d) => (
              <div key={d.id} className={row}>
                <dt className="text-ink-2">{d.label}</dt>
                <dd>
                  <KeyList bindings={keymap[d.id]} />
                </dd>
              </div>
            ))}
            <div className="col-span-2 mt-2 border-t border-line pt-3 text-xs text-ink-3">
              Fixed
            </div>
            {FIXED_SHORTCUTS.map((s) => (
              <div key={s.keys} className={row}>
                <dt className="text-ink-2">{s.what}</dt>
                <dd>
                  <Kbd>{s.keys}</Kbd>
                </dd>
              </div>
            ))}
          </dl>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The window's content under the optional title bar. */
function Framed({ titleBar, children }: { titleBar: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="tex-canvas flex h-full flex-col overflow-hidden bg-canvas">
      {titleBar}
      <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-1 items-center justify-center bg-canvas p-8 text-ink-3">
      {children}
    </div>
  );
}
