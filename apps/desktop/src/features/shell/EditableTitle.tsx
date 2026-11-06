import { useState } from "react";
import { EditIcon as Pencil } from "../../components/TaskIcons";
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
        className="font-display text-[28px]"
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
        className="truncate rounded-lg px-1 text-left hover:bg-hover"
      >
        {value}
      </button>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Rename ${value}`}
        title="Rename"
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-60 hover:bg-hover hover:text-ink hover:opacity-100 focus-visible:opacity-100"
      >
        <Pencil size={15} />
      </button>
    </span>
  );
}
