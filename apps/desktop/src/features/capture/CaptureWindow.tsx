import { currentMonitor, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { events } from "../../bindings";
import { Button, IconButton } from "../../components/ui";
import { deleteTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { OpenTaskContext } from "../shell/useOpenTask";
import { isEditable } from "../shell/useShortcuts";
import { TaskEditor } from "../task-detail/TaskDetail";
import { CaptureBox } from "./CaptureBox";

/** Size the window grows to for editing (logical px), kept within 90% of the screen. */
const EXPANDED = { width: 900, height: 720 };

/** What the capture window needs from its native window; injected so tests can fake it. */
export interface CaptureControls {
  hide(): Promise<void>;
  /** Grows the window into an editor. The shell shrinks it back on the next opening. */
  expand(): Promise<void>;
  /** The hotkey showed the window again. */
  onOpened(handler: () => void): Promise<() => void>;
  onBlur(handler: () => void): Promise<() => void>;
}

export const tauriCaptureControls = (): CaptureControls => {
  const win = getCurrentWindow();
  return {
    hide: () => win.hide(),
    expand: async () => {
      const monitor = await currentMonitor();
      const scale = monitor?.scaleFactor ?? 1;
      const withinScreen = (want: number, screen: number | undefined) =>
        screen ? Math.min(want, Math.floor((screen / scale) * 0.9)) : want;
      await win.setResizable(true);
      await win.setSize(
        new LogicalSize(
          withinScreen(EXPANDED.width, monitor?.size.width),
          withinScreen(EXPANDED.height, monitor?.size.height),
        ),
      );
      await win.center();
    },
    onOpened: (handler) => events.captureOpened.listen(() => handler()),
    onBlur: (handler) =>
      win.onFocusChanged(({ payload: focused }) => {
        if (!focused) handler();
      }),
  };
};

/**
 * The quick-capture window (global hotkey, plan section 6): one input, then out of the way.
 * Hides on Escape, after a capture, or when it loses focus; each opening starts fresh.
 * Shift+Enter saves and grows the window into the full task editor (description,
 * subtasks, files...); it then stays open until Esc or Done, so file pickers can open.
 */
export function CaptureWindow({ controls }: { controls: CaptureControls }) {
  const store = useTaskStore();
  const ready = useStoreState((s) => s.ready);
  const input = useRef<HTMLInputElement>(null);
  const [round, setRound] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** The task Shift+Enter created; it opens with the cursor in its description. */
  const [created, setCreated] = useState<string | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const task = useStoreState((s) => (editing ? s.tasks[editing] : undefined));

  const hide = () =>
    void controls.hide().then(() => {
      setEditing(null);
      setSaved(null);
    });
  const hideRef = useRef(hide);
  hideRef.current = hide;

  useEffect(() => {
    const unlisten = [
      controls.onOpened(() => {
        setRound((r) => r + 1);
        setSaved(null);
        setEditing(null);
        setDeleteError(null);
        requestAnimationFrame(() => input.current?.focus());
      }),
      controls.onBlur(() => {
        if (!editingRef.current) hideRef.current();
      }),
    ];
    return () => {
      for (const u of unlisten) void u.then((f) => f());
    };
  }, [controls]);

  // While editing: Esc leaves the field being typed in, then closes the window. Menus
  // and the description editor handle their own Esc first (they prevent the default).
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (isEditable(e.target) && e.target instanceof HTMLElement) e.target.blur();
      else hideRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  if (editing) {
    return (
      <OpenTaskContext.Provider value={(id) => (id ? setEditing(id) : hide())}>
        <div className="tex-sheet flex h-full flex-col overflow-hidden border border-line-strong bg-overlay">
          <div
            data-tauri-drag-region
            className="flex items-center gap-2 border-b border-line px-5 py-2.5"
          >
            <p
              data-tauri-drag-region
              className="flex-1 font-display text-[15px] tracking-wide text-accent"
            >
              Quick capture
            </p>
            <span className="text-[12.5px] text-ink-3">Saves as you edit · Esc closes</span>
            <Button
              size="sm"
              className="text-danger hover:text-danger"
              disabled={!task}
              onClick={async () => {
                if (!task) return;
                setDeleteError(null);
                const deleted = await deleteTask(store, task.id);
                if (deleted) hide();
                else setDeleteError("Could not delete this task. Please try again.");
              }}
            >
              <Trash2 size={14} />
              Delete task
            </Button>
            <Button variant="primary" size="sm" onClick={hide}>
              Done
            </Button>
            <IconButton label="Close" onClick={hide}>
              <X size={16} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
            {deleteError && (
              <p role="alert" className="mb-4 text-[13px] text-danger">
                {deleteError}
              </p>
            )}
            {task ? (
              <TaskEditor
                key={task.id}
                task={task}
                variant="page"
                focusDescription={task.id === created}
              />
            ) : (
              <p className="text-ink-3">This task no longer exists.</p>
            )}
          </div>
        </div>
      </OpenTaskContext.Provider>
    );
  }

  return (
    <div className="tex-sheet flex h-full flex-col overflow-hidden border border-line-strong bg-overlay">
      <p className="px-5 pt-3 font-display text-[15px] tracking-wide text-accent">Quick capture</p>
      {ready ? (
        <CaptureBox
          key={round}
          ref={input}
          autoFocus
          variant="window"
          placeholder="What needs doing?"
          footer={
            saved
              ? "Saved to Task Master ✓"
              : "Enter to save · Shift+Enter to save and edit · Esc to close"
          }
          onEscape={hide}
          onCaptured={(id, how) => {
            if (how.open) {
              setCreated(id);
              setEditing(id);
              void controls.expand();
              return;
            }
            setSaved(id);
            setTimeout(hide, 350);
          }}
        />
      ) : (
        <p className="px-5 py-4 text-ink-3">Loading…</p>
      )}
    </div>
  );
}
