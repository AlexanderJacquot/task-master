import { useState } from "react";
import { InlineInput } from "../../components/ui";

/** A page title that turns into an input on double-click; Enter saves, Escape cancels. */
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
        onCommit={(name) => {
          setEditing(false);
          if (name.trim() && name.trim() !== value) onRename(name.trim());
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <button
      type="button"
      onDoubleClick={() => setEditing(true)}
      title="Double-click to rename"
      className="truncate text-left"
    >
      {value}
    </button>
  );
}
