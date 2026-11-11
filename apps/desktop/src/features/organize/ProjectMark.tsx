import {
  ArrowUpRight,
  Beer,
  Bird,
  BookOpen,
  Castle,
  Cog,
  Coins,
  Compass,
  Crown,
  DoorOpen,
  Feather,
  Flag,
  Flame,
  Flower2,
  Hand,
  Handshake,
  Heart,
  Hourglass,
  House,
  Key,
  Landmark,
  Lightbulb,
  Lock,
  type LucideIcon,
  Map as MapIcon,
  Megaphone,
  Pointer,
  Scroll,
  ScrollText,
  Search,
  Shield,
  Stamp,
  Sword,
  Target,
  ThumbsUp,
  Trophy,
  Wallet,
} from "lucide-react";
import { cx, Dot } from "../../components/ui";
import { useIsClean } from "../../lib/theme";
import type { Project } from "../../lib/types";

const ENGRAVINGS = import.meta.glob("../../assets/project-icons/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** Engraved icons (`img:<name>` in `project.icon`), alphabetical. */
export const PROJECT_ENGRAVINGS: { id: string; name: string; url: string }[] = Object.entries(
  ENGRAVINGS,
)
  .map(([path, url]) => {
    const name = path.replace(/^.*\//, "").replace(/\.png$/, "");
    return { id: `img:${name}`, name, url };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const ENGRAVING_BY_ID = new Map(PROJECT_ENGRAVINGS.map((e) => [e.id, e]));

/** The clean theme draws each engraving as a line icon in the project's color (ADR 021). */
const CLEAN_ENGRAVINGS: Record<string, LucideIcon> = {
  arrow: ArrowUpRight,
  banner: Flag,
  book: BookOpen,
  bow: Target,
  campfire: Flame,
  castle: Castle,
  chalice: Trophy,
  coin: Coins,
  compass: Compass,
  crown: Crown,
  dagger: Sword,
  door: DoorOpen,
  fleur: Flower2,
  gear: Cog,
  hand: Hand,
  handshake: Handshake,
  heart: Heart,
  horn: Megaphone,
  hourglass: Hourglass,
  house: House,
  key: Key,
  lantern: Lightbulb,
  lock: Lock,
  magnifier: Search,
  map: MapIcon,
  parchment: ScrollText,
  pointing: Pointer,
  pouch: Wallet,
  quill: Feather,
  raven: Bird,
  scroll: Scroll,
  seal: Stamp,
  shield: Shield,
  tavern: Beer,
  thumbsup: ThumbsUp,
  tower: Landmark,
};

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
  const clean = useIsClean();
  const engraving = project.icon ? ENGRAVING_BY_ID.get(project.icon) : undefined;
  const Clean = engraving && clean ? CLEAN_ENGRAVINGS[engraving.name] : undefined;
  if (Clean) {
    return (
      <Clean
        aria-hidden
        strokeWidth={1.75}
        className={cx("inline-block size-[1.15em] shrink-0 text-ink-2", className)}
        style={project.color ? { color: project.color } : undefined}
      />
    );
  }
  if (engraving) {
    return (
      <img
        alt=""
        aria-hidden
        src={engraving.url}
        draggable={false}
        className={cx("inline-block size-[1.3em] shrink-0 object-contain", className)}
      />
    );
  }
  if (project.icon && !project.icon.startsWith("img:")) {
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
