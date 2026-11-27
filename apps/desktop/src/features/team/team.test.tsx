// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { mentionParts } from "../../lib/mentions";
import type { Changes, Command, Notice, Snapshot } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, note, project, STATUS, snapshot, task } from "../../test/fixtures";

const NO_CHANGES = { batch_id: null, op_seq: null } as unknown as Changes;

let executed: Command[][] = [];
let spaces: Array<string | undefined> = [];
let notices: Notice[] = [];

function api(team: Snapshot | null): Api {
  return {
    teamNotices: async () => notices,
    snapshot: async () => snapshot({ tasks: [task({ id: "mine", title: "Renew passport" })] }),
    teamSnapshot: async () => team,
    execute: async (commands, space) => {
      executed.push(commands);
      spaces.push(space);
      return NO_CHANGES;
    },
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
  };
}

async function renderAt(path: string, team: Snapshot | null) {
  const fake = api(team);
  const store = createTaskStore(fake);
  await store.getState().hydrate();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <StoreProvider store={store} api={fake}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
}

const ada = { id: "a", name: "Ada", color: null, created_at: 0, updated_at: 0, deleted_at: null };
const teamSpace = snapshot({
  projects: [project({ id: "tp", name: "Platform" })],
  tasks: [
    task({
      id: "t1",
      title: "Ship the API",
      project_id: "tp",
      assignee_id: "a",
      description: "Needs @Ada for the review",
    }),
    task({ id: "t2", title: "Team inbox item", status_id: STATUS.inProgress }),
  ],
  members: [ada],
  notes: [note({ id: "n1", title: "Q3 plan" })],
});

afterEach(() => {
  cleanup();
  executed = [];
  spaces = [];
  notices = [];
  localStorage.clear();
});

describe("team mode", () => {
  it("shows no team section on a personal instance", async () => {
    await renderAt("/inbox", null);
    await screen.findByRole("heading", { name: "Inbox" });
    expect(screen.queryByText("Team overview")).toBeNull();
  });

  it("lists team projects apart and keeps team tasks out of the Inbox", async () => {
    await renderAt("/inbox", teamSpace);
    await screen.findByRole("heading", { name: "Inbox" });
    expect(screen.getByText("Team overview")).toBeTruthy();
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.getByText("Renew passport")).toBeTruthy();
    expect(screen.queryByText("Team inbox item")).toBeNull();
  });

  it("shows each member's work on the Team page", async () => {
    await renderAt("/team", teamSpace);
    const column = await screen.findByRole("region", { name: "Ada" });
    expect(within(column).getByText("Ship the API")).toBeTruthy();
    const unassigned = screen.getByRole("region", { name: "Unassigned" });
    expect(within(unassigned).getByText("Team inbox item")).toBeTruthy();
  });

  it("adds a task from a member's column, assigned to them, in the team", async () => {
    await renderAt("/team", teamSpace);
    const column = await screen.findByRole("region", { name: "Ada" });
    fireEvent.click(within(column).getByRole("button", { name: "New task for Ada" }));
    fireEvent.change(within(column).getByRole("combobox", { name: "Team project" }), {
      target: { value: "tp" },
    });
    const input = within(column).getByRole("textbox", { name: "New task for Ada" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(executed).toHaveLength(0); // nothing typed yet
    fireEvent.change(input, { target: { value: "Write the release notes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(executed).toHaveLength(1));
    expect(executed[0]?.[0]).toMatchObject({
      type: "create_task",
      task: { title: "Write the release notes", project_id: "tp", assignee_id: "a" },
    });
    expect(spaces).toEqual(["team"]);
    expect(within(column).getByText("Write the release notes")).toBeTruthy();

    // The project carries over to the next column; the team inbox has none.
    const unassigned = screen.getByRole("region", { name: "Unassigned" });
    fireEvent.click(within(unassigned).getByRole("button", { name: "New unassigned task" }));
    expect(
      (within(unassigned).getByRole("combobox", { name: "Team project" }) as HTMLSelectElement)
        .value,
    ).toBe("tp");
    fireEvent.change(within(unassigned).getByRole("combobox", { name: "Team project" }), {
      target: { value: "" },
    });
    const loose = within(unassigned).getByRole("textbox", { name: "New unassigned task" });
    fireEvent.change(loose, { target: { value: "Triage the bug reports" } });
    fireEvent.keyDown(loose, { key: "Enter" });
    await waitFor(() => expect(executed).toHaveLength(2));
    const created = executed[1]?.[0];
    expect(created).toMatchObject({ type: "create_task", task: { project_id: null } });
    expect(created && "task" in created && "assignee_id" in created.task).toBe(false);
    expect(spaces[1]).toBe("team");
    // Shown as the team's at once (this fake core returns no team ids).
    expect(within(unassigned).getByText("Triage the bug reports")).toBeTruthy();

    fireEvent.keyDown(loose, { key: "Escape" });
    expect(within(unassigned).queryByRole("textbox", { name: "New unassigned task" })).toBeNull();
  });

  it("comments on team tasks only, and marks mentions", async () => {
    await renderAt("/inbox?task=t1", teamSpace);
    const box = await screen.findByRole("textbox", { name: "New comment" });
    fireEvent.change(box, { target: { value: "@Ada please review" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(executed.length).toBe(1));
    expect(executed[0]?.[0]).toMatchObject({
      type: "create_comment",
      comment: { task_id: "t1", body: "@Ada please review" },
    });
    // The description shows the mention set apart.
    expect(document.querySelector(".tm-mention")?.textContent).toBe("@Ada");
    expect(mentionParts("hi @ada and @Bob", [ada])).toEqual([
      { text: "hi ", mention: false },
      { text: "@ada", mention: true },
      { text: " and @Bob", mention: false },
    ]);
    cleanup();
    await renderAt("/inbox?task=mine", teamSpace);
    await screen.findByRole("complementary", { name: "Task details" });
    expect(screen.queryByRole("textbox", { name: "New comment" })).toBeNull();
  });

  it("lists teammates while typing @ in a comment", async () => {
    await renderAt("/inbox?task=t1", teamSpace);
    const box = (await screen.findByRole("textbox", {
      name: "New comment",
    })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Thanks a@b" } });
    fireEvent.select(box);
    expect(screen.queryByRole("listbox", { name: "Mention a teammate" })).toBeNull();
    fireEvent.change(box, { target: { value: "Thanks @a" } });
    fireEvent.select(box);
    const list = screen.getByRole("listbox", { name: "Mention a teammate" });
    expect(within(list).getByRole("option", { name: /Ada/, selected: true })).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("Thanks @Ada ");
    expect(screen.queryByRole("listbox", { name: "Mention a teammate" })).toBeNull();
    expect(executed).toHaveLength(0); // Enter picked; it did not post

    // No match: nothing to pick, and Esc closes an open list.
    fireEvent.change(box, { target: { value: "@zed" } });
    fireEvent.select(box);
    expect(screen.queryByRole("listbox", { name: "Mention a teammate" })).toBeNull();
    fireEvent.change(box, { target: { value: "@" } });
    fireEvent.select(box);
    expect(screen.getByRole("listbox", { name: "Mention a teammate" })).toBeTruthy();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Mention a teammate" })).toBeNull();
  });

  it("assigns a team task from the side panel; a personal task has no assignee", async () => {
    await renderAt("/inbox?task=t2", teamSpace);
    await screen.findByRole("complementary", { name: "Task details" });
    expect(screen.getAllByLabelText("Assignee").length).toBeGreaterThan(0);
    cleanup();
    await renderAt("/inbox?task=mine", teamSpace);
    await screen.findByRole("complementary", { name: "Task details" });
    expect(screen.queryByLabelText("Assignee")).toBeNull();
  });

  it("lists what teammates did for you, and counts it until seen", async () => {
    notices = [
      { seq: 9, at: Date.now(), kind: "mention", task_id: "t1", comment_id: "c", author_id: "a" },
      { seq: 8, at: Date.now(), kind: "mention", note_id: "n1", author_id: "a" },
    ];
    await renderAt("/inbox", teamSpace);
    const overview = await screen.findByRole("link", { name: /Team overview/ });
    expect(overview.textContent).toContain("2");
    cleanup();
    await renderAt("/team", teamSpace);
    const forYou = await screen.findByRole("region", { name: "For you" });
    expect(within(forYou).getByText(/mentioned you on/)).toBeTruthy();
    expect(within(forYou).getByText("Ship the API")).toBeTruthy();
    expect(within(forYou).getByText("Q3 plan")).toBeTruthy();
    fireEvent.click(within(forYou).getByText("Q3 plan"));
    expect(await screen.findByDisplayValue("Q3 plan")).toBeTruthy();
    expect(localStorage.getItem("task-master.team-notices-seen")).toBe("9");
  });
});
