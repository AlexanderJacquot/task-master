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
/** Lowered portcullis (stop). */
export const StopIcon = icon("stop");
/** Hanging tag (label). */
export const TagIcon = icon("tag");
/** Arrow nocked on a drawn bow (play / resume). */
export const PlayIcon = icon("play");
/** Grimoire with a prompt rune (open terminal). */
export const TerminalIcon = icon("terminal");
/** Three iron rivets (more menu). */
export const MoreIcon = icon("more");
/** Ruled ledger page (list layout). */
export const ListIcon = icon("list");
/** Three hanging banners (board layout). */
export const ColumnsIcon = icon("columns");
/** Sieve over falling drops (filter). */
export const FilterIcon = icon("filter");
/** Hand lever on a base (display options). */
export const OptionsIcon = icon("options");
/** Messenger raven (update available). */
export const UpdateIcon = icon("update");
/** Open chest with a coin hoard (choose folder). */
export const FolderOpenIcon = icon("folder-open");
/** Struck-through chest (forget folder). */
export const FolderClearIcon = icon("folder-clear");
/** Rolled scroll tied with a ribbon (attach file). */
export const AttachIcon = icon("attach");
/** Scroll lowered on a rope (download). */
export const DownloadIcon = icon("download");
/** Parchment sheet with a folded corner. */
export const FileIcon = icon("file");
/** Parchment sheet with ink lines. */
export const FileTextIcon = icon("file-text");
/** Cog sailing out (open externally). */
export const ExternalIcon = icon("external");
/** Pen over a name plaque (rename). */
export const RenameIcon = icon("rename");
/** Four-point compass star (expand, fit). */
export const ExpandIcon = icon("expand");
/** Hourglass turned back (undo, reset). */
export const UndoIcon = icon("undo");
/** Mill wheel in waves (refresh, check again). */
export const RefreshIcon = icon("refresh");
/** Six-spoke wheel, symmetric so it can be spun with CSS (loading). */
export const SpinnerIcon = icon("spinner");
/** Open almanac with a cross (schedule a task). */
export const CalendarPlusIcon = icon("calendar-plus");
/** Pennant on a stake (location). */
export const MapPinIcon = icon("map-pin");
/** Ledger with ticks (subtasks done). */
export const ListChecksIcon = icon("list-checks");
/** Twig with a leaf (child of). */
export const ChildIcon = icon("child");
/** Forked bough (lineage). */
export const BranchIcon = icon("branch");
/** Stone wall (auto arrange). */
export const GridIcon = icon("grid");
/** Pointing gauntlet (select tool). */
export const PointerIcon = icon("pointer");
/** Dash with manuscript terminals, the cross's partner (zoom out). */
export const MinusIcon = icon("minus");
/** Fletched arrow pointing right. */
export const ArrowRightIcon = icon("arrow-right");
/** Fletched arrow pointing left. */
export const ArrowLeftIcon = icon("arrow-left");
/** Double spearheads pointing right. */
export const SpearsRightIcon = icon("spears-right");
/** Double spearheads pointing left. */
export const SpearsLeftIcon = icon("spears-left");
/** Heraldic roundel (epic mark). */
export const RoundelIcon = icon("roundel");
/** Heraldic billet (epic mark). */
export const BilletIcon = icon("billet");
/** Heraldic pile (epic mark). */
export const PileIcon = icon("pile");
/** Voided lozenge (epic mark). */
export const LozengeIcon = icon("lozenge");
/** Bezant on a hexagon (epic mark). */
export const BezantIcon = icon("bezant");
/** Heraldic mullet, a five-point star (epic mark). */
export const MulletIcon = icon("mullet");
/** Crossed swords (close, remove). */
export const CloseIcon = icon("close");
/** Tick (done, selected). */
export const CheckIcon = icon("check");
