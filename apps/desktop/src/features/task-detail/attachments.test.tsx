// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api, FilesApi } from "../../lib/api";
import type { Activity, Attachment, Changes, Command, StoredUpload, Task } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore, type TaskStore } from "../../store/store";
import { attachment, fakeParse, STATUS, snapshot, task } from "../../test/fixtures";
import { dispatchFileDrop } from "../shell/useFileDrop";

/** Records every call; plain functions, as CLAUDE.md asks for mocks. */
function fakeFiles() {
  const calls = {
    storeData: [] as Array<{ name: string; mime: string; base64: string }>,
    storeFile: [] as string[],
    opened: [] as string[],
    urls: [] as string[],
  };
  const stored = (name: string, mime: string): StoredUpload => ({
    hash: "c".repeat(64),
    size: 4,
    name,
    mime,
  });
  const files: FilesApi = {
    storeData: async (name, mime, base64) => {
      calls.storeData.push({ name, mime, base64 });
      return stored(name, mime);
    },
    storeFile: async (path) => {
      calls.storeFile.push(path);
      const name = path.split("/").pop() ?? path;
      return stored(name, name.endsWith(".pdf") ? "application/pdf" : "image/png");
    },
    open: async (id) => {
      calls.opened.push(id);
    },
    saveCopy: async () => true,
    openUrl: async (url) => {
      calls.urls.push(url);
    },
    pickFiles: async () => ["/home/me/Documents/plan.pdf"],
    url: (id) => `tm://localhost/${id}`,
  };
  return { files, calls };
}

let store: TaskStore;

async function renderTask(
  t: Task,
  attachments: Attachment[] = [],
  activity: Activity[] = [],
  others: Task[] = [],
) {
  const executed: Command[][] = [];
  const { files, calls } = fakeFiles();
  const api: Api = {
    snapshot: async () => snapshot({ tasks: [t, ...others], attachments }),
    execute: async (commands) => {
      executed.push(commands);
      return {
        batch_id: `b${executed.length}`,
        op_seq: executed.length,
        tasks: [],
        projects: [],
        epics: [],
        tags: [],
        views: [],
        attachments: [],
        time_blocks: [],
        statuses: [],
      } as Changes;
    },
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => activity,
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
    files,
  };
  store = createTaskStore(api);
  await store.getState().hydrate();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [`/task/${t.id}`] }));
  render(
    <StoreProvider store={store} api={api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
  const description = await screen.findByRole("region", { name: "Description" });
  return { executed, calls, description };
}

const descriptionSaves = (executed: Command[][]) =>
  executed.flatMap((batch) =>
    batch.flatMap((c) =>
      c.type === "update_task"
        ? c.changes.flatMap((ch) => ("description" in ch ? [ch.description] : []))
        : [],
    ),
  );

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("task description", () => {
  it("renders markdown with attached images, file links and outside links", async () => {
    const t = task({ title: "Bug" });
    const shot = attachment({ task_id: t.id, name: "shot.png" });
    const doc = attachment({ task_id: t.id, name: "spec.pdf", mime: "application/pdf" });
    t.description = [
      "## Steps",
      "**Bold** <script>alert(1)</script>",
      `![the bug](attachment:${shot.id})`,
      `See [the spec](attachment:${doc.id}) and [docs](https://example.com/docs).`,
      "![remote](https://example.com/x.png)",
    ].join("\n\n");
    const { calls, description } = await renderTask(t, [shot, doc]);

    expect(within(description).getByRole("heading", { name: "Steps" })).toBeTruthy();
    expect(description.querySelector("script")).toBeNull();
    const img = within(description).getByRole("img", { name: "the bug" }) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(`tm://localhost/${shot.id}`);
    expect(within(description).getByText("remote (external image)")).toBeTruthy();

    fireEvent.click(within(description).getByRole("button", { name: /the spec/ }));
    expect(calls.opened).toEqual([doc.id]);
    fireEvent.click(within(description).getByRole("link", { name: "docs" }));
    expect(calls.urls).toEqual(["https://example.com/docs"]);
    expect(description.querySelector(".cm-content"), "links do not start editing").toBeNull();
  });

  it("ticks a checklist item from the rendered view", async () => {
    const t = task({ description: "Todo\n\n- [ ] first\n- [ ] second" });
    const { executed, description } = await renderTask(t);
    const boxes = within(description).getAllByRole("checkbox");
    fireEvent.click(boxes[1] as HTMLElement);
    await waitFor(() =>
      expect(descriptionSaves(executed)).toEqual(["Todo\n\n- [ ] first\n- [x] second"]),
    );
  });

  it("opens the editor on click and renders again on Escape", async () => {
    const t = task({ description: "Hello" });
    const { description } = await renderTask(t);
    fireEvent.click(within(description).getByText("Hello"));
    const editor = await waitFor(() => {
      const el = description.querySelector(".cm-content");
      if (!el) throw new Error("no editor yet");
      return el as HTMLElement;
    });
    expect(editor.textContent).toBe("Hello");
    fireEvent.keyDown(editor, { key: "Escape" });
    fireEvent.blur(editor);
    await waitFor(() => expect(description.querySelector(".cm-content")).toBeNull());
    expect(within(description).getByText("Hello")).toBeTruthy();
  });

  it("attaches a pasted image and inserts it at the cursor", async () => {
    const t = task({ description: "" });
    const { executed, calls, description } = await renderTask(t);
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const editor = await waitFor(() => {
      const el = description.querySelector(".cm-content");
      if (!el) throw new Error("no editor yet");
      return el as HTMLElement;
    });
    const file = new File(["png!"], "image.png", { type: "image/png" });
    fireEvent.paste(editor, { clipboardData: { files: [file], getData: () => "" } });

    await waitFor(() => expect(calls.storeData).toHaveLength(1));
    expect(calls.storeData[0]).toMatchObject({ mime: "image/png", base64: btoa("png!") });
    expect(calls.storeData[0]?.name).toMatch(/^Pasted image .*\.png$/);
    const created = await waitFor(() => {
      const c = executed.flat().find((x) => x.type === "create_attachment");
      if (c?.type !== "create_attachment") throw new Error("not attached yet");
      return c.attachment;
    });
    expect(created.task_id).toBe(t.id);
    await waitFor(() =>
      expect(editor.textContent).toBe(`![${created.name}](attachment:${created.id})`),
    );
    expect(screen.getByRole("region", { name: "Attachments" }).textContent).toContain(created.name);
  });
});

describe("attachment list", () => {
  it("attaches files dropped from the OS and picked in the dialog", async () => {
    const t = task();
    const { executed, calls } = await renderTask(t);
    const section = screen.getByRole("region", { name: "Attachments" });
    dispatchFileDrop(section, ["/tmp/shots/login.png"]);
    expect(await within(section).findByText("login.png")).toBeTruthy();
    expect(calls.storeFile).toEqual(["/tmp/shots/login.png"]);

    fireEvent.click(within(section).getByRole("button", { name: "Attach file" }));
    expect(await within(section).findByText("plan.pdf")).toBeTruthy();
    const creates = executed.flat().filter((c) => c.type === "create_attachment");
    expect(creates).toHaveLength(2);
    expect(t.description, "the description is left alone").toBe("");

    fireEvent.click(within(section).getByRole("button", { name: /^plan\.pdf/ }));
    expect(calls.opened).toHaveLength(1);
  });

  it("files dropped on the description are inserted into it", async () => {
    const t = task({ description: "Intro" });
    const { executed, description } = await renderTask(t);
    dispatchFileDrop(description.querySelector("[data-file-drop]") as HTMLElement, ["/tmp/a.png"]);
    await waitFor(() => expect(descriptionSaves(executed)).toHaveLength(1));
    expect(descriptionSaves(executed)[0]).toMatch(/^Intro\n!\[a\.png\]\(attachment:[0-9a-f-]+\)$/);
  });

  it("lists attachment changes in the activity", async () => {
    const t = task();
    const entry = (kind: string, before: string, after: string): Activity => ({
      seq: 1,
      at: Date.now(),
      batch_id: "b",
      kind,
      fields: [{ field: "name", before, after }],
    });
    await renderTask(
      t,
      [],
      [entry("rename_attachment", '"a.pdf"', '"b.pdf"'), entry("attach", "null", '"a.pdf"')],
    );
    fireEvent.click(screen.getByText("Activity"));
    expect(await screen.findByText("Attached a.pdf")).toBeTruthy();
    expect(screen.getByText("Renamed the attachment a.pdf → b.pdf")).toBeTruthy();
  });
});

describe("task page look (mockup)", () => {
  it("shows set properties as pills, unset ones as quiet labels", async () => {
    const t = task({ priority: "high", description: "The current page explains every plan." });
    await renderTask(t);
    expect(screen.getByRole("combobox", { name: "Priority" }).textContent).toBe("High");
    expect(screen.getByLabelText("Due date").closest("span")?.textContent).toBe("Due date");
    expect(screen.getByText("Keep writing… Markdown works.")).toBeTruthy();
    expect(document.querySelector(".tm-dropcap")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add an estimate" }));
    const estimate = screen.getByLabelText("Estimate in minutes");
    fireEvent.change(estimate, { target: { value: "30" } });
    fireEvent.blur(estimate);
    expect(await screen.findByRole("button", { name: "Estimate: 30 minutes" })).toBeTruthy();
  });

  it("counts finished subtasks above the checklist", async () => {
    const t = task();
    const kids = [task({ parent_id: t.id, status_id: STATUS.done }), task({ parent_id: t.id })];
    await renderTask(t, [], [], kids);
    const bar = screen.getByRole("progressbar", { name: "Subtasks done" });
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(screen.getByText("1 of 2")).toBeTruthy();
  });
});

describe("task history", () => {
  let seq = 50;
  const change = (kind: string, fields: Array<[string, unknown, unknown]>): Activity => {
    seq -= 1;
    return {
      seq,
      at: Date.now() - seq * 60_000,
      batch_id: `b${seq}`,
      kind,
      fields: fields.map(([field, before, after]) => ({
        field,
        before: JSON.stringify(before),
        after: JSON.stringify(after),
      })),
    };
  };
  const updates = (executed: Command[][]) =>
    executed.flatMap((batch) => batch.filter((c) => c.type === "update_task"));

  it("undoes the last change from the activity", async () => {
    const t = task({ title: "Final", priority: "high" });
    const { executed } = await renderTask(
      t,
      [],
      [
        change("update", [["title", "Plan", "Final"]]),
        change("update", [["priority", "normal", "high"]]),
        change("create", []),
      ],
    );
    fireEvent.click(screen.getByText("Activity"));
    fireEvent.click(await screen.findByRole("button", { name: "Undo last change" }));
    await waitFor(() =>
      expect(updates(executed)).toEqual([
        { type: "update_task", id: t.id, changes: [{ title: "Plan" }] },
      ]),
    );
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("shows a description edit as a diff and restores an older version", async () => {
    const t = task({ title: "Final", description: "one\nTWO" });
    const { executed } = await renderTask(
      t,
      [],
      [
        change("update", [["description", "one\ntwo", "one\nTWO"]]),
        change("update", [["title", "Plan", "Final"]]),
        change("create", []),
      ],
    );
    fireEvent.click(screen.getByText("Activity"));
    fireEvent.click(await screen.findByRole("button", { name: "Edited the description" }));
    expect(screen.getByText("− two")).toBeTruthy();
    expect(screen.getByText("+ TWO")).toBeTruthy();

    // The version right after creation: both later changes go back.
    const restores = screen.getAllByRole("button", { name: /^Restore the version from/ });
    fireEvent.click(restores.at(-1) as HTMLElement);
    await waitFor(() =>
      expect(updates(executed)).toEqual([
        {
          type: "update_task",
          id: t.id,
          changes: [{ title: "Plan" }, { description: "one\ntwo" }],
        },
      ]),
    );
  });
});
