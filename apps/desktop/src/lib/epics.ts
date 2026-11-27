// Which epics belong with which project: the epic pickers offer an epic only to the tasks
// of its home project (and that project's area), and the sidebar folds epics by project.
import type { Epic, Project } from "./types";

/**
 * Whether `epic` is offered for a task (or meeting) in `projectId`. An epic without a home
 * project goes anywhere, and anything goes outside a project (the Inbox). An epic of
 * project P goes to P's tasks, to the projects inside P when P is an area, and to the area
 * holding P.
 */
export function epicFitsProject(
  epic: Pick<Epic, "project_id">,
  projectId: string | null | undefined,
  projects: Record<string, Pick<Project, "parent_id">>,
): boolean {
  const home = epic.project_id;
  if (!home || !projectId || home === projectId) return true;
  return projects[projectId]?.parent_id === home || projects[home]?.parent_id === projectId;
}

/** `epics` offered for `projectId` (see `epicFitsProject`); `keep` stays whatever its home. */
export function epicsForProject<E extends Pick<Epic, "id" | "project_id">>(
  epics: E[],
  projectId: string | null | undefined,
  projects: Record<string, Pick<Project, "parent_id">>,
  keep?: string | null,
): E[] {
  return epics.filter((e) => e.id === keep || epicFitsProject(e, projectId, projects));
}

export interface EpicFolder<E> {
  project: Project;
  epics: E[];
}

/**
 * `epics` (already in display order) split into the ones without a live home project and
 * one folder per home project, in `order` (the sidebar's project ids) and then archived
 * projects by name.
 */
export function epicFolders<E extends Pick<Epic, "project_id">>(
  epics: E[],
  projects: Record<string, Project>,
  order: string[],
): { loose: E[]; folders: EpicFolder<E>[] } {
  const loose: E[] = [];
  const byProject = new Map<string, E[]>();
  for (const epic of epics) {
    const home = epic.project_id ? projects[epic.project_id] : undefined;
    if (!home) {
      loose.push(epic);
      continue;
    }
    const list = byProject.get(home.id);
    if (list) list.push(epic);
    else byProject.set(home.id, [epic]);
  }
  const position = new Map(order.map((id, i) => [id, i]));
  const folders = [...byProject.keys()]
    .map((id) => ({ project: projects[id] as Project, epics: byProject.get(id) ?? [] }))
    .sort((a, b) => {
      const pa = position.get(a.project.id) ?? Number.POSITIVE_INFINITY;
      const pb = position.get(b.project.id) ?? Number.POSITIVE_INFINITY;
      return pa !== pb ? pa - pb : a.project.name.localeCompare(b.project.name);
    });
  return { loose, folders };
}
