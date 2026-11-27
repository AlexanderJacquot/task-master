// The asset lab panel: every ornament slot with its options as thumbnails, applied live.
// Toggle with Ctrl+Alt+A or from Settings → Appearance. See src/lib/ornaments.ts.

import { useEffect } from "react";
import { CloseIcon } from "../../components/TaskIcons";
import { Button, cx, FOCUS, IconButton } from "../../components/ui";
import {
  type Choice,
  choiceLabel,
  PACK,
  SLOTS,
  type SlotName,
  useOrnaments,
} from "../../lib/ornaments";

export function AssetLab() {
  const open = useOrnaments((s) => s.open);
  const setOpen = useOrnaments((s) => s.setOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setOpen(!useOrnaments.getState().open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  if (!open) return null;
  return (
    <aside
      aria-label="Asset lab"
      className="tex-sheet fixed top-12 right-4 bottom-4 z-[60] flex w-[23rem] flex-col overflow-hidden rounded-2xl border border-line-strong bg-overlay shadow-2xl shadow-black/40"
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="flex-1 font-display text-[19px] tracking-wide text-accent">Asset lab</h2>
        <Button size="sm" onClick={() => useOrnaments.getState().reset()}>
          Reset
        </Button>
        <IconButton label="Close (Ctrl+Alt+A)" onClick={() => setOpen(false)}>
          <CloseIcon size={15} />
        </IconButton>
      </header>
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {(Object.keys(SLOTS) as SlotName[]).map((name) => (
          <SlotPicker key={name} name={name} />
        ))}
        <p className="text-xs text-ink-3">
          Native app icon: <code>scripts/asset-pack/set-app-icon.sh &lt;name&gt;</code>, then
          restart <code>pnpm tauri dev</code>.
        </p>
      </div>
    </aside>
  );
}

function SlotPicker({ name }: { name: SlotName }) {
  const slot = SLOTS[name];
  const current = useOrnaments((s) => s.choices[name]);
  const set = useOrnaments((s) => s.set);
  const many = slot.options.length > 6;
  return (
    <section>
      <h3 className="text-sm text-ink">{slot.label}</h3>
      <p className="mb-2 text-xs text-ink-3">{slot.hint}</p>
      <div className={cx("grid gap-1.5", many ? "grid-cols-5" : "grid-cols-4")}>
        {(slot.options as Choice[]).map((choice) => {
          const url = PACK[choice] ?? (choice === "gold" ? PACK["ui/today"] : undefined);
          const selected = current === choice;
          return (
            <button
              key={choice}
              type="button"
              title={choiceLabel(choice)}
              aria-pressed={selected}
              onClick={() => set(name, choice)}
              className={cx(
                "flex aspect-square flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg border p-1 text-[10.5px] leading-tight text-ink-2 transition-colors",
                selected
                  ? "border-accent bg-selected ring-1 ring-accent"
                  : "border-line bg-hover/40 hover:border-line-strong",
                FOCUS,
              )}
            >
              {url ? (
                <img src={url} alt="" className="min-h-0 w-full flex-1 object-contain" />
              ) : null}
              <span className="w-full truncate text-center">{choiceLabel(choice)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
