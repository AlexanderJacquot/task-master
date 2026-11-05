import { useMemo } from "react";
import type { Project } from "../../lib/types";
import { useStoreState } from "../../store/context";

const byRank = (a: Project, b: Project) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0);

/**
 * Open projects in sidebar order (each area, then its projects). Ctrl+1 to Ctrl+9 jump to
 * the first nine.
 */
export function useProjectOrder(): string[] {
  const projects = useStoreState((s) => s.projects);
  return useMemo(() => {
    const list = Object.values(projects).filter((p) => p.archived_at === null);
    return list
      .filter((p) => p.parent_id === null)
      .sort(byRank)
      .flatMap((area) => [
        area.id,
        ...list
          .filter((p) => p.parent_id === area.id)
          .sort(byRank)
          .map((p) => p.id),
      ]);
  }, [projects]);
}
