/** Class names for the full task page's property pills (PropertyPills, TagPicker). */
export const PILL =
  "relative inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[14px] whitespace-nowrap transition-colors focus-within:ring-2 focus-within:ring-accent";
/** A property that has a value. */
export const SET = "bg-hover text-ink hover:bg-selected";
/** A property without a value: a quiet label until hovered. */
export const GHOST = "text-ink-3 hover:bg-hover hover:text-ink-2";
/** A native control stretched invisibly over its pill. */
export const OVERLAY =
  "absolute inset-0 size-full cursor-pointer appearance-none rounded-full opacity-0 [&>option]:bg-overlay [&>option]:text-ink";
