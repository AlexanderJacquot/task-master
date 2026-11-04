import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { events } from "../../bindings";
import { useStoreState } from "../../store/context";
import { CAPTURE_HINT, CaptureBox } from "./CaptureBox";

/**
 * The quick-capture window (global hotkey, plan section 6): one input, then out of the way.
 * Hides on Escape, after a capture, or when it loses focus; each opening starts fresh.
 */
export function CaptureWindow() {
  const ready = useStoreState((s) => s.ready);
  const input = useRef<HTMLInputElement>(null);
  const [round, setRound] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = [
      events.captureOpened.listen(() => {
        setRound((r) => r + 1);
        setSaved(null);
        requestAnimationFrame(() => input.current?.focus());
      }),
      win.onFocusChanged(({ payload: focused }) => {
        if (!focused) void win.hide();
      }),
    ];
    return () => {
      for (const u of unlisten) void u.then((f) => f());
    };
  }, []);

  const hide = () => void getCurrentWindow().hide();

  return (
    <div className="flex h-full flex-col gap-2 rounded-lg border border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900">
      <p className="text-xs font-semibold text-neutral-500">Quick capture</p>
      {ready ? (
        <CaptureBox
          key={round}
          ref={input}
          autoFocus
          placeholder={`What needs doing?   ${CAPTURE_HINT}`}
          onEscape={hide}
          onCaptured={(id) => {
            setSaved(id);
            setTimeout(hide, 350);
          }}
        />
      ) : (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}
      <p className="mt-auto text-xs text-neutral-400">
        {saved ? "Saved to task-master ✓" : "Enter to save · Esc to close"}
      </p>
    </div>
  );
}
