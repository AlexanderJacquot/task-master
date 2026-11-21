// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import type { Changes, Command, Snapshot } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore, type TaskStore } from "../../store/store";
import { fakeParse, note, noteFolder, STATUS, snapshot, task } from "../../test/fixtures";

/** A core that confirms every write with what the store optimistically shows. */
function fakeApi(getStore: () => TaskStore, initial: Partial<Snapshot>, extra: Partial<Api>) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot(initial),
    execute: async (commands) => {
      executed.push(commands);
      const s = getStore().getState();
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
        agent_sessions: [],
        agent_notes: [],
        meetings: [],
        transcript_segments: [],
        terminal_sessions: [],
        notes: Object.values(s.notes),
        note_folders: Object.values(s.note_folders),
        statuses: [],
      } as Changes;
    },
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
    ...extra,
  };
  return { api, executed };
}

let store: TaskStore;

async function renderApp(path: string, initial: Partial<Snapshot> = {}, extra: Partial<Api> = {}) {
  const fake = fakeApi(() => store, initial, extra);
  store = createTaskStore(fake.api);
  await store.getState().hydrate();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <StoreProvider store={store} api={fake.api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
  return { router, executed: fake.executed };
}

const sidebar = () => screen.getByRole("navigation", { name: "Sidebar" });

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("notes", () => {
  it("writes a new note from the sidebar; its title shows in the sidebar", async () => {
    const { router, executed } = await renderApp("/inbox");
    await screen.findByRole("heading", { name: "Inbox" });
    fireEvent.click(within(sidebar()).getByRole("button", { name: "New note" }));
    const title = await screen.findByRole("textbox", { name: "Title" });
    expect(router.state.location.pathname).toMatch(/^\/note\//);
    expect(executed[0]?.[0]).toMatchObject({ type: "create_note", note: { title: "" } });
    expect(within(sidebar()).getByRole("link", { name: "Untitled" })).toBeTruthy();

    fireEvent.change(title, { target: { value: "Reading list" } });
    // Saved once typing pauses.
    await waitFor(() =>
      expect(within(sidebar()).getByRole("link", { name: "Reading list" })).toBeTruthy(),
    );
    expect(executed.at(-1)?.[0]).toMatchObject({
      type: "update_note",
      changes: [{ title: "Reading list" }],
    });
  });

  it("links tasks from the text, and the task lists the note", async () => {
    const t = task({
      id: "0192f0c6-0000-7000-8000-00000000abcd",
      title: "Renew passport",
      status_id: STATUS.todo,
    });
    const n = note({ title: "Travel", body: `Before leaving: [passport](task:${t.id})` });
    const { router } = await renderApp(`/note/${n.id}`, { tasks: [t], notes: [n] });
    const link = await screen.findByRole("button", { name: "passport" });
    expect(link.getAttribute("title")).toBe("Open task: Renew passport");
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ task: t.id }));
    const panel = await screen.findByRole("complementary", { name: "Task details" });
    const notes = within(panel).getByRole("region", { name: "Notes" });
    expect(within(notes).getByRole("link", { name: /Travel.*links here/ })).toBeTruthy();
  });

  it("writes a note attached to a task from its panel", async () => {
    const t = task({ title: "Plan the offsite", status_id: STATUS.todo });
    const { router, executed } = await renderApp(`/inbox?task=${t.id}`, { tasks: [t] });
    const panel = await screen.findByRole("complementary", { name: "Task details" });
    const notes = within(panel).getByRole("region", { name: "Notes" });
    fireEvent.click(within(notes).getByRole("button", { name: "New note" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/note\//));
    expect(executed[0]?.[0]).toMatchObject({
      type: "create_note",
      note: { title: "Plan the offsite", task_id: t.id },
    });
    // The page shows the task it is attached to.
    const main = await screen.findByRole("button", { name: "Detach from the task" });
    expect(
      within(main.parentElement as HTMLElement).getByRole("link", { name: "Plan the offsite" }),
    ).toBeTruthy();
  });

  it("keeps notes in folders; deleting a folder keeps its notes", async () => {
    const folder = noteFolder({ name: "Ideas" });
    const inside = note({ title: "Garden", folder_id: folder.id });
    const { executed } = await renderApp("/inbox", { notes: [inside], note_folders: [folder] });
    await screen.findByRole("heading", { name: "Inbox" });
    const folderButton = within(sidebar()).getByRole("button", { name: "Ideas" });
    expect(folderButton.getAttribute("aria-expanded")).toBe("true");
    expect(within(sidebar()).getByRole("link", { name: "Garden" })).toBeTruthy();

    fireEvent.contextMenu(folderButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete folder" }));
    await waitFor(() => expect(executed).toHaveLength(1));
    expect(executed[0]?.[0]).toEqual({ type: "delete_note_folder", id: folder.id });
    expect(within(sidebar()).queryByRole("button", { name: /Ideas/ })).toBeNull();
    expect(within(sidebar()).getByRole("link", { name: "Garden" })).toBeTruthy();
    expect(store.getState().notes[inside.id]?.folder_id).toBeNull();
  });

  it("finds notes in the command palette, by title and by words in the body", async () => {
    const plan = note({ title: "Launch plan", body: "Budget approved by finance." });
    const other = note({ title: "Groceries" });
    const searched: string[] = [];
    const { router } = await renderApp(
      "/inbox",
      { notes: [plan, other] },
      {
        searchNotes: async (text) => {
          searched.push(text);
          return text.startsWith("budg")
            ? [{ note_id: plan.id, snippet: "[Budget] approved by finance." }]
            : [];
        },
      },
    );
    await screen.findByRole("heading", { name: "Inbox" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "Command" });
    const results = () => screen.getByRole("list", { name: "Results" });

    fireEvent.change(input, { target: { value: "groc" } });
    expect(await within(results()).findByRole("button", { name: /Groceries/ })).toBeTruthy();

    fireEvent.change(input, { target: { value: "budget" } });
    const hit = await within(results()).findByRole("button", {
      name: /Launch plan.*Budget approved by finance/,
    });
    expect(searched).toContain("budget");
    fireEvent.click(hit);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/note/${plan.id}`));
  });

  it("writes a note from the command palette", async () => {
    const { router, executed } = await renderApp("/inbox");
    await screen.findByRole("heading", { name: "Inbox" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "Command" });
    fireEvent.change(input, { target: { value: "new note" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/note\//));
    expect(executed[0]?.[0]).toMatchObject({ type: "create_note" });
  });

  it("attaches an image pasted in a note and shows it in the note", async () => {
    const n = note({ title: "Diagram" });
    const stored: string[] = [];
    await renderApp(
      `/note/${n.id}`,
      { notes: [n] },
      {
        files: {
          storeData: async (name, mime) => {
            stored.push(name);
            return { hash: "c".repeat(64), size: 4, name, mime };
          },
          storeFile: async (path) => ({ hash: "d".repeat(64), size: 4, name: path, mime: "x/y" }),
          open: async () => {},
          saveCopy: async () => true,
          openUrl: async () => {},
          pickFiles: async () => [],
          url: (id) => `tm://localhost/${id}`,
        },
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit description" }));
    const editor = await waitFor(() => {
      const el = document.querySelector(".cm-content");
      if (!el) throw new Error("no editor yet");
      return el as HTMLElement;
    });
    const file = new File(["png!"], "image.png", { type: "image/png" });
    fireEvent.paste(editor, { clipboardData: { files: [file], getData: () => "" } });
    await waitFor(() => expect(stored).toHaveLength(1));
    const attachment = await waitFor(() => {
      const a = Object.values(store.getState().attachments)[0];
      if (!a) throw new Error("not attached yet");
      return a;
    });
    expect(attachment).toMatchObject({ note_id: n.id, task_id: null });
    await waitFor(() =>
      expect(editor.textContent).toBe(`![${attachment.name}](attachment:${attachment.id})`),
    );
    expect(screen.getByRole("region", { name: "Attachments" }).textContent).toContain(
      attachment.name,
    );
  });

  it("moves a note dragged onto a folder in the sidebar", async () => {
    const folder = noteFolder({ name: "Ideas" });
    const loose = note({ title: "Garden" });
    const { executed } = await renderApp("/inbox", { notes: [loose], note_folders: [folder] });
    await screen.findByRole("heading", { name: "Inbox" });
    // jsdom has no layout: the folder's header sits at y 0–20, the note's row at 40–60.
    const header = document.querySelector(`[data-note-folder="${folder.id}"]`) as HTMLElement;
    const row = document.querySelector(`[data-note-row="${loose.id}"]`) as HTMLElement;
    const box = (top: number) => () =>
      ({
        top,
        bottom: top + 20,
        left: 0,
        right: 200,
        width: 200,
        height: 20,
        x: 0,
        y: top,
      }) as DOMRect;
    header.getBoundingClientRect = box(0);
    row.getBoundingClientRect = box(40);
    const at = (y: number) => ({
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 50,
      clientY: y,
    });
    fireEvent.pointerDown(row, at(50));
    fireEvent.pointerMove(document, at(30));
    fireEvent.pointerMove(document, at(10));
    await waitFor(() => expect(header.className).toContain("ring-accent"));
    fireEvent.pointerUp(document, at(10));
    await waitFor(() => expect(store.getState().notes[loose.id]?.folder_id).toBe(folder.id));
    expect(executed.at(-1)?.[0]).toMatchObject({
      type: "update_note",
      id: loose.id,
      changes: [{ folder_id: folder.id }, { rank: expect.any(String) }],
    });
  });
});
