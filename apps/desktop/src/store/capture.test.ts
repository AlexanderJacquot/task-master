import { describe, expect, it } from "vitest";
import type { Api } from "../lib/api";
import type { Capture, Changes, Command, Tag } from "../lib/types";
import { fakeParse, project, snapshot } from "../test/fixtures";
import { captureTask, missingContainers } from "./actions";
import { createTaskStore } from "./store";

const homelab = project({ name: "Homelab" });
const known: Tag = {
  id: "g1",
  name: "quick",
  color: null,
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
};

async function setup() {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot({ projects: [homelab], tags: [known] }),
    execute: async (commands) => {
      executed.push(commands);
      return {
        batch_id: "b",
        op_seq: 1,
        tasks: [],
        projects: [],
        epics: [],
        tags: [],
        views: [],
        attachments: [],
        statuses: [],
      } as Changes;
    },
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
  };
  const store = createTaskStore(api);
  await store.getState().hydrate();
  return { store, executed };
}

const parse = (text: string): Capture => fakeParse(text, { projects: [homelab], tags: [known] });

describe("captureTask", () => {
  it("creates unknown tags and the task in one batch, with matched names as ids", async () => {
    const { store, executed } = await setup();
    const id = await captureTask(store, parse("Fix DNS #quick #new @Homelab !high"));
    expect(executed).toHaveLength(1);
    const [createTag, createTask] = executed[0] ?? [];
    expect(createTag).toMatchObject({ type: "create_tag", tag: { name: "new" } });
    const newTagId = (createTag?.type === "create_tag" && createTag.tag.id) || "";
    expect(createTask).toMatchObject({
      type: "create_task",
      task: { id, title: "Fix DNS", project_id: homelab.id, priority: "high" },
    });
    const task = store.getState().tasks[id as string];
    expect(task?.tag_ids).toEqual(["g1", newTagId].sort());
    expect(store.getState().tags[newTagId]?.name).toBe("new");
  });

  it("creates an unknown project and epic when asked to, and markers beat view defaults", async () => {
    const { store, executed } = await setup();
    const capture = parse("Plan trip @Travel +epic:Summer");
    expect(missingContainers(capture)).toEqual(['project "Travel"', 'epic "Summer"']);
    await captureTask(store, capture, { project_id: homelab.id, today_on: "2026-11-04" });
    const types = (executed[0] ?? []).map((c) => c.type);
    expect(types).toEqual(["create_project", "create_epic", "create_task"]);
    const task = executed[0]?.[2];
    const project = executed[0]?.[0];
    expect(task).toMatchObject({ task: { today_on: "2026-11-04" } });
    expect(task?.type === "create_task" && task.task.project_id).toBe(
      project?.type === "create_project" && project.project.id,
    );
  });

  it("refuses a line with no title", async () => {
    const { store, executed } = await setup();
    expect(await captureTask(store, parse("#quick !high"))).toBeNull();
    expect(executed).toHaveLength(0);
  });
});
