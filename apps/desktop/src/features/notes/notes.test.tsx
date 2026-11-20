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
function fakeApi(getStore: () => TaskStore, initial: Partial<Snapshot>) {
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
  };
  return { api, executed };
}

let store: TaskStore;

async function renderApp(path: string, initial: Partial<Snapshot> = {}) {
  const fake = fakeApi(() => store, initial);
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
});
