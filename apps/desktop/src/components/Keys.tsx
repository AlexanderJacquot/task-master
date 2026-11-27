import { Fragment } from "react";
import { Kbd } from "./ui";

/** A binding as key caps: "Ctrl+K" → [Ctrl+K]; "G I" → [G] then [I]. */
export function Keys({ binding }: { binding: string }) {
  const chords = binding.split(" ");
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {chords.map((c, i) => (
        <Fragment key={chords.slice(0, i + 1).join(" ")}>
          {i > 0 && <span className="text-[11px] text-ink-3">then</span>}
          <Kbd>{c}</Kbd>
        </Fragment>
      ))}
    </span>
  );
}

/** Every binding of an action, "or"-separated; a dash when it has none. */
export function KeyList({ bindings }: { bindings: string[] }) {
  if (!bindings.length) return <span className="text-ink-3">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {bindings.map((b, i) => (
        <Fragment key={b}>
          {i > 0 && <span className="text-[11px] text-ink-3">or</span>}
          <Keys binding={b} />
        </Fragment>
      ))}
    </span>
  );
}
