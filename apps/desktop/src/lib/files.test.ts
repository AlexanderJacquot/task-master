import { describe, expect, it } from "vitest";
import type { BlobList, StoredFileInfo } from "../bindings";
import { attachment, task } from "../test/fixtures";
import { fileRows, fileTotals, filterFiles, sortFiles } from "./files";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const local = (hash: string, size: number, stored_at: number): StoredFileInfo => ({
  hash,
  size,
  stored_at,
  in_use: false,
});

describe("files overview", () => {
  it("joins duplicate attachments with device and server content, including missing content", () => {
    const firstTask = task({ id: "first", title: "First", description: "" });
    const secondTask = task({ id: "second", title: "Second" });
    const first = attachment({ task_id: firstTask.id, hash: A, name: "photo.png", created_at: 20 });
    const second = attachment({
      task_id: secondTask.id,
      hash: A,
      name: "other.png",
      created_at: 30,
    });
    firstTask.description = `![photo](attachment:${first.id})`;
    const missing = attachment({ task_id: secondTask.id, hash: C, name: "lost.png" });
    const server: BlobList = {
      files: [
        { hash: A, size: 100, stored_at: 10 },
        { hash: B, size: 300, stored_at: 5 },
      ],
      purged: [C],
    };
    const rows = fileRows({
      local: [local(A, 100, 10)],
      server,
      attachments: [second, first, missing, attachment({ task_id: "deleted", hash: B })],
      tasks: { first: firstTask, second: secondTask },
    });
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.hash === A)).toMatchObject({
      size: 100,
      name: "photo.png",
      task: firstTask,
      onDevice: true,
      onServer: true,
      inDescription: true,
      attachments: [first, second],
    });
    expect(rows.find((r) => r.hash === B)).toMatchObject({
      size: 300,
      onDevice: false,
      onServer: true,
      attachments: [],
    });
    expect(rows.find((r) => r.hash === C)).toMatchObject({
      name: "lost.png",
      onDevice: false,
      onServer: false,
      attachments: [missing],
    });
    expect(fileTotals(rows, server)).toEqual({
      device: 100,
      server: 400,
      unused: 300,
      unusedCount: 1,
    });
  });

  it("keeps local unused content visible and marks server availability unknown offline", () => {
    const rows = fileRows({ local: [local(B, 42, 100)], server: null, attachments: [], tasks: {} });
    expect(rows[0]).toMatchObject({ onDevice: true, onServer: null, addedAt: 100 });
    expect(fileTotals(rows, null)).toEqual({
      device: 42,
      server: null,
      unused: 42,
      unusedCount: 1,
    });
  });

  it("filters by age, size and use, and sorts without changing the source", () => {
    const rows = fileRows({
      local: [local(A, 10, 100), local(B, 20, 200), local(C, 20, 300)],
      server: null,
      attachments: [attachment({ task_id: "t", hash: C, created_at: 300 })],
      tasks: { t: task({ id: "t" }) },
    });
    expect(
      filterFiles(
        rows,
        { unusedOnly: true, olderThanDays: 1, largerThan: 10 },
        200 + 2 * 86_400_000,
      ).map((r) => r.hash),
    ).toEqual([B]);
    expect(sortFiles(rows, "largest").map((r) => r.hash)).toEqual([B, C, A]);
    expect(sortFiles(rows, "oldest").map((r) => r.hash)).toEqual([A, B, C]);
    expect(sortFiles(rows, "newest").map((r) => r.hash)).toEqual([C, B, A]);
    expect(rows.map((r) => r.hash)).toEqual([A, B, C]);
  });
});
