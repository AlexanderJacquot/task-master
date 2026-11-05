import { beforeEach, describe, expect, it, vi } from "vitest";

// A plain function rather than vi.fn(): vi.fn's result tracking leaves a derived promise
// unhandled when the mock returns a rejection, which fails the test after it passed.
const tauri = vi.hoisted(() => ({
  reply: (): Promise<unknown> => Promise.resolve(undefined),
  calls: [] as unknown[][],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => {
    tauri.calls.push(args);
    return tauri.reply();
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { ApiError, tauriApi } = await import("./api");

async function failure(call: Promise<unknown>): Promise<InstanceType<typeof ApiError>> {
  const err = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as InstanceType<typeof ApiError>;
}

describe("tauriApi", () => {
  beforeEach(() => {
    tauri.calls.length = 0;
  });

  it("passes commands through and returns the core's data", async () => {
    const changes = {
      batch_id: "b",
      op_seq: 1,
      tasks: [],
      projects: [],
      epics: [],
      tags: [],
      views: [],
      attachments: [],
    };
    tauri.reply = () => Promise.resolve(changes);
    const cmd = { type: "delete_task", id: "t" } as const;

    await expect(tauriApi.execute([cmd])).resolves.toEqual(changes);
    expect(tauri.calls).toEqual([["execute", { commands: [cmd] }]]);
  });

  it("turns core errors into ApiError with their kind", async () => {
    tauri.reply = () => Promise.reject({ kind: "invalid", message: "title cannot be empty" });
    const err = await failure(tauriApi.execute([]));
    expect(err.kind).toBe("invalid");
    expect(err.message).toBe("title cannot be empty");
  });

  it("wraps framework string errors", async () => {
    tauri.reply = () => Promise.reject("command not found");
    const err = await failure(tauriApi.snapshot());
    expect(err.kind).toBe("internal");
    expect(err.message).toBe("command not found");
  });

  it("calls task_activity with camelCase args (Tauri maps them to snake_case)", async () => {
    tauri.reply = () => Promise.resolve([]);
    await tauriApi.taskActivity("t1", 20);
    expect(tauri.calls).toEqual([["task_activity", { taskId: "t1", limit: 20 }]]);
  });
});
