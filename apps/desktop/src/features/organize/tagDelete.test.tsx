// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import type { Changes, Command, Tag } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore, type TaskStore } from "../../store/store";
import { fakeParse, snapshot, task } from "../../test/fixtures";

function tag(id: string, name: string): Tag {
  return { id, name, color: null, created_at: 1, updated_at: 1, deleted_at: null };
}

const bug = tag("tag-bug", "bug");
const ui = tag("tag-ui", "UI");

async function renderAt(path: string) {
  const executed: Command[][] = [];
  const tasks = [
    task({ id: "t1", title: "Crash on save", tag_ids: [bug.id, ui.id] }),
    task({ id: "t2", title: "Typo", tag_ids: [bug.id] }),
  ];
  const empty = async () => null;
  const api = {
    snapshot: async () => snapshot({ tasks, tags: [bug, ui] }),
    execute: async (commands: Command[]) => {
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
        agent_sessions: [],
        agent_notes: [],
        statuses: [],
      } as Changes;
    },
    undo: empty,
    redo: empty,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text: string) => fakeParse(text),
    onChanged: async () => () => {},
  } as unknown as Api;
  localStorage.setItem("task-master.sidebar-sections", JSON.stringify({ tags: true }));
  const store: TaskStore = createTaskStore(api);
  await store.getState().hydrate();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <StoreProvider store={store} api={api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
  const sidebar = await screen.findByRole("link", { name: /^bug/ });
  return { executed, store, router, sidebar };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("deleting a tag", () => {
  it("from the tag page: takes it off its tasks and goes back to the inbox", async () => {
    const { executed, store, router } = await renderAt(`/tag/${bug.id}`);

    fireEvent.keyDown(await screen.findByRole("button", { name: "More tag actions" }), {
      key: "Enter",
    });
    expect(await screen.findByText("#bug · 2 tasks")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete tag" }));

    await waitFor(() => expect(executed).toEqual([[{ type: "delete_tag", id: bug.id }]]));
    const s = store.getState();
    expect(s.tags[bug.id]).toBeUndefined();
    expect(s.tasks.t1?.tag_ids).toEqual([ui.id]);
    expect(s.tasks.t2?.tag_ids).toEqual([]);
    await waitFor(() => expect(router.state.location.pathname).toBe("/inbox"));
    expect(screen.queryByRole("link", { name: /^bug/ })).toBeNull();
  });

  it("from the sidebar, on right-click", async () => {
    const { executed, sidebar } = await renderAt("/inbox");

    fireEvent.contextMenu(sidebar);
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete tag" }));

    await waitFor(() => expect(executed).toEqual([[{ type: "delete_tag", id: bug.id }]]));
    await waitFor(() => expect(screen.queryByRole("link", { name: /^bug/ })).toBeNull());
    expect(screen.getByRole("link", { name: /^UI/ })).toBeTruthy();
  });
});
