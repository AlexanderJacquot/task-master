import { describe, expect, it } from "vitest";
import type { Api } from "../lib/api";
import type { Attachment, Changes, Command, StoredUpload, Task } from "../lib/types";
import { attachment, fakeParse, snapshot, task } from "../test/fixtures";
import { attachFiles, deleteAttachment, renameAttachment } from "./actions";
import { createTaskStore } from "./store";

function setup(data: { tasks?: Task[]; attachments?: Attachment[] }, refuse = false) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot(data),
    execute: (commands) => {
      executed.push(commands);
      if (refuse) return Promise.reject(new Error("no stored file has hash"));
      return Promise.resolve({
        batch_id: `b${executed.length}`,
        op_seq: executed.length,
        tasks: [],
        projects: [],
        epics: [],
        tags: [],
        views: [],
        attachments: [],
        statuses: [],
      } as Changes);
    },
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
  };
  const store = createTaskStore(api);
  return { store, executed, ready: store.getState().hydrate() };
}

const upload = (name: string, mime = "image/png"): StoredUpload => ({
  hash: "b".repeat(64),
  size: 10,
  name,
  mime,
});

describe("attachment actions", () => {
  it("attaches several stored files in one batch, shown at once", async () => {
    const t = task();
    const { store, executed, ready } = setup({ tasks: [t] });
    await ready;
    const added = await attachFiles(store, t.id, [upload("a.png"), upload("b.pdf", "x/y")]);
    expect(added.map((a) => a.name)).toEqual(["a.png", "b.pdf"]);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toEqual(
      added.map((a) => ({
        type: "create_attachment",
        attachment: {
          id: a.id,
          task_id: t.id,
          hash: a.hash,
          name: a.name,
          mime: a.mime,
          size: 10,
        },
      })),
    );
    expect(Object.keys(store.getState().attachments).sort()).toEqual(added.map((a) => a.id).sort());
    expect(new Set(added.map((a) => a.id)).size).toBe(2);
  });

  it("rolls back and reports when the core refuses", async () => {
    const t = task();
    const { store, ready } = setup({ tasks: [t] }, true);
    await ready;
    expect(await attachFiles(store, t.id, [upload("a.png")])).toEqual([]);
    expect(store.getState().attachments).toEqual({});
    expect(store.getState().lastError).toMatch(/no stored file/);
  });

  it("renames (trimmed, skipping no-ops) and removes", async () => {
    const t = task();
    const a = attachment({ task_id: t.id, name: "old.png" });
    const { store, executed, ready } = setup({ tasks: [t], attachments: [a] });
    await ready;
    expect(await renameAttachment(store, a.id, " old.png ")).toBeNull();
    await renameAttachment(store, a.id, "  new.png ");
    expect(store.getState().attachments[a.id]?.name).toBe("new.png");
    expect(executed.at(-1)).toEqual([
      { type: "update_attachment", id: a.id, changes: [{ name: "new.png" }] },
    ]);
    await deleteAttachment(store, a.id);
    expect(store.getState().attachments[a.id]).toBeUndefined();
    expect(executed.at(-1)).toEqual([{ type: "delete_attachment", id: a.id }]);
  });
});
