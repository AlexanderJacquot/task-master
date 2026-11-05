import { cx, Dot } from "../../components/ui";
import type { Project } from "../../lib/types";

/** Emoji offered as project icons (any other one can be typed or pasted). */
export const PROJECT_ICONS = [
  "📁",
  "🏠",
  "💼",
  "💡",
  "🎯",
  "📚",
  "🛠️",
  "💻",
  "🎨",
  "🎵",
  "🏃",
  "💰",
  "✈️",
  "🌱",
  "❤️",
];

/** The first visible character of `text` (one emoji, flags and skin tones included), or null. */
export function firstGrapheme(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const [first] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
  return first?.segment ?? null;
}

/** A project's icon when it has one, else its colored dot. `dotClass` sizes the dot. */
export function ProjectMark({
  project,
  dotClass,
  className,
}: {
  project: Pick<Project, "color" | "icon">;
  dotClass?: string;
  className?: string;
}) {
  if (project.icon) {
    return (
      <span
        aria-hidden
        className={cx("inline-flex w-[1.15em] shrink-0 justify-center leading-none", className)}
      >
        {project.icon}
      </span>
    );
  }
  return <Dot color={project.color} className={dotClass} />;
}
