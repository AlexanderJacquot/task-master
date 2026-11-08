import { cx, Dot } from "../../components/ui";
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
  const engraving = project.icon ? ENGRAVING_BY_ID.get(project.icon) : undefined;
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
