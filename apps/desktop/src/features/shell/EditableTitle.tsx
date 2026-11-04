import { useState } from "react";
import { InlineInput } from "../../components/ui";

/**
 * A page title that turns into an input on click (or the Rename button next to it);
 * Enter or leaving the field saves, Escape cancels.
 */
export function EditableTitle({
  value,
  placeholder,
  onRename,
}: {
  value: string;
  placeholder: string;
  onRename(name: string): void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <InlineInput
        initial={value}
        placeholder={placeholder}
        autoFocus
        onCommit={(name) => {
          setEditing(false);
          if (name.trim() && name.trim() !== value) onRename(name.trim());
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <span className="group flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Click to rename"
        className="truncate rounded px-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        {value}
      </button>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Rename ${value}`}
        title="Rename"
        className="shrink-0 rounded px-1 text-sm font-normal text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        ✎
      </button>
    </span>
  );
}
