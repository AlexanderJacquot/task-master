import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * A sidebar row's fold chevron, hung in the gutter left of the row so the row's icon lines
 * up with every other icon in its column. Place it inside the toggle button (so it takes the
 * click) and make the element carrying the row's `px-2.5` padding `relative`.
 */
export function FoldChevron({ open, size = 13 }: { open: boolean; size?: number }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <Icon
      aria-hidden
      size={size}
      className="absolute top-1/2 -translate-y-1/2 text-ink-3"
      // 3px clear of the row's 10px padding.
      style={{ left: 7 - size }}
    />
  );
}

/** Children of an unfolded sidebar row, with a guide line down their left. */
export const FOLD_CHILDREN_CLASS = "ml-3 flex flex-col gap-px border-l border-line pl-1.5";
