import { describe, expect, it } from "vitest";
import { epicFitsProject, epicFolders, epicsForProject } from "./epics";
import type { Project } from "./types";

const project = (id: string, parent_id: string | null = null, extra: Partial<Project> = {}) =>
  ({
    id,
    parent_id,
    name: id,
    color: null,
    icon: null,
    rank: "a",
    archived_at: null,
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
    ...extra,
  }) as Project;

// An area "work" holding "web" and "api"; "home" on its own.
const projects: Record<string, Project> = {
  work: project("work"),
  web: project("web", "work"),
  api: project("api", "work"),
  home: project("home"),
  old: project("old", null, { archived_at: 1 }),
};

const epic = (id: string, project_id: string | null) => ({ id, project_id });

describe("epicFitsProject", () => {
  it("offers a loose epic anywhere, and any epic outside a project", () => {
    expect(epicFitsProject(epic("e", null), "web", projects)).toBe(true);
    expect(epicFitsProject(epic("e", "home"), null, projects)).toBe(true);
  });

  it("keeps a project's epic to that project", () => {
    expect(epicFitsProject(epic("e", "home"), "home", projects)).toBe(true);
    expect(epicFitsProject(epic("e", "home"), "web", projects)).toBe(false);
    expect(epicFitsProject(epic("e", "web"), "api", projects)).toBe(false);
  });

  it("offers an area's epic to its projects, and a project's epic to its area", () => {
    expect(epicFitsProject(epic("e", "work"), "web", projects)).toBe(true);
    expect(epicFitsProject(epic("e", "web"), "work", projects)).toBe(true);
    expect(epicFitsProject(epic("e", "work"), "home", projects)).toBe(false);
  });
});

describe("epicsForProject", () => {
  it("drops other projects' epics but keeps the current one", () => {
    const list = [epic("a", null), epic("b", "web"), epic("c", "home")];
    expect(epicsForProject(list, "web", projects).map((e) => e.id)).toEqual(["a", "b"]);
    expect(epicsForProject(list, "web", projects, "c").map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});

describe("epicFolders", () => {
  it("puts loose epics first and folds the rest by project in sidebar order", () => {
    const list = [
      epic("a", "home"),
      epic("b", null),
      epic("c", "web"),
      epic("d", "old"),
      epic("e", "home"),
      epic("f", "gone"),
    ];
    const { loose, folders } = epicFolders(list, projects, ["work", "web", "api", "home"]);
    expect(loose.map((e) => e.id)).toEqual(["b", "f"]);
    expect(folders.map((f) => [f.project.id, f.epics.map((e) => e.id)])).toEqual([
      ["web", ["c"]],
      ["home", ["a", "e"]],
      ["old", ["d"]],
    ]);
  });
});
