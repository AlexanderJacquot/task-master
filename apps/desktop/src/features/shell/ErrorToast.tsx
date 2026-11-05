import { useEffect } from "react";
import { useStoreState } from "../../store/context";

/** Shows the last refused write; the optimistic change has already been rolled back. */
export function ErrorToast() {
  const error = useStoreState((s) => s.lastError);
  const dismiss = useStoreState((s) => s.dismissError);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(dismiss, 6000);
    return () => clearTimeout(timer);
  }, [error, dismiss]);
  if (!error) return null;
  return (
    <div
      role="alert"
      className="fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-3 rounded-xl border border-danger/40 bg-overlay px-4 py-3 text-ink shadow-xl"
    >
      <span className="flex-1">{error}</span>
      <button type="button" onClick={dismiss} className="text-danger hover:underline">
        Dismiss
      </button>
    </div>
  );
}
