import { describe, expect, it } from "vitest";
import type { AgentSession, ProjectFolder } from "../../lib/types";
import { agentSession, project, task } from "../../test/fixtures";
import {
  defaultFolder,
  folderName,
  formatCost,
  formatDuration,
  recentFolders,
  shownSession,
  sortedSessions,
} from "./sessions";

const byId = (list: AgentSession[]) => Object.fromEntries(list.map((s) => [s.id, s]));

function folder(project_id: string, path: string, runtime: "native" | "wsl" = "native") {
  return { project_id, path, runtime, updated_at: 1 } satisfies ProjectFolder;
}

describe("which session shows", () => {
  it("a task's chip shows its running session, else its newest", () => {
    const old = agentSession({ task_id: "t", started_at: 10, state: "running" });
    const newer = agentSession({ task_id: "t", started_at: 20, state: "failed" });
    const other = agentSession({ task_id: "u", started_at: 30 });
    expect(shownSession(byId([old, newer, other]), "t")?.id).toBe(old.id);
    expect(shownSession(byId([{ ...old, state: "done" }, newer]), "t")?.id).toBe(newer.id);
    expect(shownSession(byId([other]), "t")).toBeUndefined();
  });

  it("treats a session in a terminal as active", () => {
    const old = agentSession({ task_id: "t", started_at: 10, state: "terminal" });
    const newer = agentSession({ task_id: "t", started_at: 20 });
    expect(shownSession(byId([old, newer]), "t")?.id).toBe(old.id);
    expect(sortedSessions(byId([old, newer]))[0]?.id).toBe(old.id);
  });

  it("lists running sessions first, then newest first", () => {
    const a = agentSession({ started_at: 10 });
    const b = agentSession({ started_at: 30 });
    const c = agentSession({ started_at: 5, state: "running" });
    expect(sortedSessions(byId([a, b, c])).map((s) => s.id)).toEqual([c.id, b.id, a.id]);
  });
});

describe("where a new session starts", () => {
  const app = project({ id: "p", parent_id: "area" });
  const projects = { p: app, area: project({ id: "area" }) };

  it("prefers the task's last folder, then its project's, then its area's, then the latest", () => {
    const t = task({ project_id: "p" });
    const elsewhere = agentSession({ task_id: "x", folder: "/recent", started_at: 50 });
    const own = agentSession({ task_id: t.id, folder: "/own", started_at: 10 });
    const folders = [folder("p", "/project"), folder("area", "/area")];

    expect(defaultFolder(t, byId([own, elsewhere]), folders, projects, "native")).toBe("/own");
    expect(defaultFolder(t, byId([elsewhere]), folders, projects, "native")).toBe("/project");
    expect(defaultFolder(t, byId([elsewhere]), folders.slice(1), projects, "native")).toBe("/area");
    expect(defaultFolder(t, byId([elsewhere]), [], projects, "native")).toBe("/recent");
    expect(defaultFolder(t, {}, [], projects, "native")).toBe("");
  });

  it("ignores folders of the other runtime", () => {
    const t = task({ project_id: "p" });
    const wsl = agentSession({ task_id: t.id, folder: "/home/me/app", runtime: "wsl" });
    const folders = [folder("p", "C:\\code\\app", "native"), folder("p", "/srv/app", "wsl")];
    expect(defaultFolder(t, byId([wsl]), folders, projects, "native")).toBe("C:\\code\\app");
    expect(defaultFolder(t, {}, folders, projects, "wsl")).toBe("/srv/app");
  });

  it("offers recent folders newest first, once each", () => {
    const list = [
      agentSession({ folder: "/a", started_at: 1 }),
      agentSession({ folder: "/b", started_at: 2 }),
      agentSession({ folder: "/a", started_at: 3 }),
      agentSession({ folder: "/w", started_at: 4, runtime: "wsl" }),
    ];
    expect(recentFolders(byId(list), "native")).toEqual(["/a", "/b"]);
    expect(recentFolders(byId(list), "native", 1)).toEqual(["/a"]);
  });
});

describe("formatting", () => {
  it("formats cost, duration and folder names", () => {
    expect(formatCost(null)).toBeNull();
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(4_500)).toBe("$0.0045");
    expect(formatCost(1_200_000)).toBe("$1.20");
    expect(formatDuration(44_600)).toBe("45 s");
    expect(formatDuration(3 * 60_000)).toBe("3 min");
    expect(formatDuration(65 * 60_000)).toBe("1 h 05");
    expect(folderName("/home/me/code/app/")).toBe("app");
    expect(folderName("C:\\Users\\me\\task-master")).toBe("task-master");
    expect(folderName("\\\\wsl.localhost\\Ubuntu\\home\\me\\x")).toBe("x");
  });
});
