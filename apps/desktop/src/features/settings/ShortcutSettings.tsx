import { useEffect, useRef, useState } from "react";
import { Keys } from "../../components/Keys";
import { UndoIcon as RotateCcw, CloseIcon as X } from "../../components/TaskIcons";
import { cx, FOCUS } from "../../components/ui";
import {
  checkBinding,
  chordOf,
  DEFAULT_KEYMAP,
  getKeymap,
  labelOf,
  recording,
  SHORTCUT_DEFS,
  type ShortcutId,
  setKeymap,
  useKeymap,
  withBinding,
  withoutBinding,
} from "../../lib/keymap";

/** After a plain key ("G"), how long the recorder waits for a second one ("G I"). */
const SECOND_KEY_MS = 900;

type Note = { text: string; error?: boolean };

/**
 * Listens for the next key combination while `active`. Plain keys may be followed by a
 * second one (a sequence); Ctrl/Alt chords finish at once. Escape cancels.
 */
function useRecorder(active: boolean, onDone: (binding: string | null) => void) {
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (!active) return;
    recording.active = true;
    let first: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (binding: string | null) => {
      clearTimeout(timer);
      done.current(binding);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const chord = chordOf(e);
      if (!chord) return;
      if (chord === "Escape") return finish(null);
      const plain = !chord.includes("+", 1);
      if (first) return finish(plain ? `${first} ${chord}` : first);
      if (!plain) return finish(chord);
      first = chord;
      timer = setTimeout(() => finish(first), SECOND_KEY_MS);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
      recording.active = false;
    };
  }, [active]);
}

/** Settings → Keyboard shortcuts: each action's keys, with add, remove and reset. */
export function ShortcutSettings() {
  const keymap = useKeymap();
  const [recordingFor, setRecordingFor] = useState<ShortcutId | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  useRecorder(recordingFor !== null, (binding) => {
    const id = recordingFor;
    setRecordingFor(null);
    if (!id || !binding) return;
    const current = getKeymap();
    const check = checkBinding(current, id, binding);
    if (!check.ok) {
      setNote({ text: `${binding.replace(" ", " then ")}: ${check.reason}.`, error: true });
      return;
    }
    setKeymap(withBinding(current, id, binding));
    setNote(
      check.takenFrom
        ? { text: `${binding.replace(" ", " then ")} moved from “${labelOf(check.takenFrom)}”.` }
        : null,
    );
  });

  const changed = SHORTCUT_DEFS.some(
    (d) => keymap[d.id].join("|") !== DEFAULT_KEYMAP[d.id].join("|"),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[minmax(10rem,14rem)_1fr_auto] items-center gap-x-3 gap-y-1.5 text-sm">
        {SHORTCUT_DEFS.map((d) => {
          const bindings = keymap[d.id];
          const custom = bindings.join("|") !== d.defaults.join("|");
          const listening = recordingFor === d.id;
          return (
            <div key={d.id} className="contents">
              <span className="text-ink-2">{d.label}</span>
              <span className="flex min-h-8 flex-wrap items-center gap-1.5">
                {bindings.map((b) => (
                  <span
                    key={b}
                    className="inline-flex items-center gap-0.5 rounded-md bg-hover py-0.5 pr-0.5 pl-1.5"
                  >
                    <Keys binding={b} />
                    <button
                      type="button"
                      aria-label={`Remove ${b} from ${d.label}`}
                      onClick={() => setKeymap(withoutBinding(getKeymap(), d.id, b))}
                      className={cx(
                        "inline-flex size-5 items-center justify-center rounded text-ink-3 hover:bg-hover hover:text-ink",
                        FOCUS,
                      )}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  aria-label={`Add a shortcut for ${d.label}`}
                  aria-pressed={listening}
                  onClick={() => {
                    setNote(null);
                    setRecordingFor(listening ? null : d.id);
                  }}
                  className={cx(
                    "h-6 rounded-md border px-2 text-xs transition-colors",
                    listening
                      ? "animate-pulse border-accent bg-accent/10 text-accent"
                      : "border-dashed border-line-strong text-ink-3 hover:border-ink-3 hover:text-ink",
                    FOCUS,
                  )}
                >
                  {listening ? "Press keys… (Esc cancels)" : "+ Add"}
                </button>
              </span>
              <span className="w-7">
                {custom && (
                  <button
                    type="button"
                    aria-label={`Reset ${d.label}`}
                    title="Back to the default"
                    onClick={() => setKeymap({ ...getKeymap(), [d.id]: d.defaults })}
                    className={cx(
                      "inline-flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink",
                      FOCUS,
                    )}
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {note && (
        <p role="status" className={cx("text-xs", note.error ? "text-danger" : "text-ink-2")}>
          {note.text}
        </p>
      )}
      {changed && (
        <div>
          <button
            type="button"
            onClick={() => {
              setKeymap(DEFAULT_KEYMAP);
              setNote(null);
            }}
            className="text-xs text-ink-3 hover:text-ink hover:underline"
          >
            Reset all shortcuts
          </button>
        </div>
      )}
    </div>
  );
}
