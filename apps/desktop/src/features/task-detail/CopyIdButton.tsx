import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "../../components/ui";

/** Copies a task id to the clipboard (for MCP calls, agents, links). */
export function CopyIdButton({ taskId }: { taskId: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <IconButton
      label={copied ? "Copied" : "Copy the task id"}
      onClick={() => {
        void navigator.clipboard.writeText(taskId).then(
          () => setCopied(true),
          () => {},
        );
      }}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </IconButton>
  );
}
