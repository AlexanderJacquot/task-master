import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { events } from "../../bindings";
import { useStoreState } from "../../store/context";
import { CaptureBox } from "./CaptureBox";

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
    <div className="tex-sheet flex h-full flex-col overflow-hidden border border-line-strong bg-overlay">
      <p className="px-5 pt-3 font-display text-[15px] tracking-wide text-accent">Quick capture</p>
      {ready ? (
        <CaptureBox
          key={round}
          ref={input}
          autoFocus
          variant="window"
          placeholder="What needs doing?"
          footer={saved ? "Saved to Task Master ✓" : "Enter to save · Esc to close"}
          onEscape={hide}
          onCaptured={(id) => {
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
