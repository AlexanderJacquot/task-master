import type { ComponentProps } from "react";
import paths from "../assets/icons/paths.json";

type IconProps = ComponentProps<"svg"> & { size?: number | string };
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
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
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
/** Quill. */
export const EditIcon = icon("edit");
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
