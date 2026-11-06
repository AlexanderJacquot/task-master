import type { ComponentProps } from "react";
import paths from "../assets/icons/paths.json";

type IconProps = ComponentProps<"svg"> & { size?: number | string };

// The glyphs are drawn on a 24-unit grid and stay within ~0.9..22.1 (stroke included; the
// lineage tree reaches 0.9), so the viewBox crops that 22.5-unit area: icons render ~7%
// larger in the same layout box without clipping. The stroke width is scaled down by the
// same factor (1.75 * 22.5/24) to keep the line weight.
const VIEW_BOX = "0.75 0.75 22.5 22.5";
const STROKE_WIDTH = 1.64;

function TaskIcon({ name, size = 24, ...props }: IconProps & { name: keyof typeof paths }) {
  // Decorative unless the caller names it, matching lucide-react's behaviour.
  const label = props["aria-label"];
  const labelled = label !== undefined;
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden when unlabelled, <title> when labelled
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={VIEW_BOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? "img" : undefined}
      {...props}
    >
      {labelled && <title>{label}</title>}
      <path d={paths[name]} />
    </svg>
  );
}
const icon = (name: keyof typeof paths) => (props: IconProps) => (
  <TaskIcon {...props} name={name} />
);

/** Cross with manuscript terminals. */
export const AddIcon = icon("add");
/** Sealed letter. */
export const InboxIcon = icon("inbox");
/** Castle keep. */
export const ProjectsIcon = icon("projects");
/** Hourglass. */
export const DueDateIcon = icon("due-date");
/** Anvil. */
export const SettingsIcon = icon("settings");
/** Lantern. */
export const SearchIcon = icon("search");
/** Brazier. */
export const DeleteIcon = icon("delete");
/** Knight's great helm. */
export const AgentsIcon = icon("agents");
/** Open almanac. */
export const CalendarIcon = icon("calendar");
/** Open scroll. */
export const AllTasksIcon = icon("all-tasks");
/** Closed treasure chest. */
export const ArchiveIcon = icon("archive");
/** Open chest with a rising arrow. */
export const UnarchiveIcon = icon("unarchive");
/** Swallowtail pennant. */
export const PriorityIcon = icon("priority");
/** Gonfalon banner. */
export const BookmarkIcon = icon("bookmark");
/** Quill: cut nib and bare barrel, notched vane, a line of ink. */
export const EditIcon = icon("edit");
/** Tarot sun: the ☉ disc ringed by alternating straight and wavy rays. */
export const TodayIcon = icon("today");
/** Balance scales. */
export const MetricsIcon = icon("metrics");
/** Oak tree. */
export const LineageIcon = icon("lineage");
/** Fletched arrow. */
export const SendIcon = icon("send");
/** Candle clock. */
export const EstimateIcon = icon("estimate");
/** Wax seal with a tick. */
export const DoneIcon = icon("done");
/** Crown (epic mark). */
export const CrownIcon = icon("crown");
/** Heater shield (epic mark). */
export const ShieldIcon = icon("shield");
