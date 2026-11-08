// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import type { Changes, Command, Project } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, project, snapshot } from "../../test/fixtures";

async function renderProject(p: Project) {
  const executed: Command[][] = [];
  const empty = async () => null;
  const api: Api = {
    snapshot: async () => snapshot({ projects: [p] }),
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
        agent_sessions: [],
        agent_notes: [],
        statuses: [],
      } as Changes;
    },
    undo: empty,
    redo: empty,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
  } as Api;
  const store = createTaskStore(api);
  await store.getState().hydrate();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [`/project/${p.id}`] }));
  render(
    <StoreProvider store={store} api={api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
  const picker = await screen.findByRole("button", { name: "Project color and icon" });
  return { executed, picker };
}

const iconChanges = (executed: Command[][]) =>
  executed.flatMap((batch) =>
    batch.flatMap((c) =>
      c.type === "update_project" ? c.changes.flatMap((ch) => ("icon" in ch ? [ch.icon] : [])) : [],
    ),
  );

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("project icons", () => {
  it("shows an existing icon and can go back to the dot", async () => {
    const p = project({ name: "Homelab", icon: "🏠" });
    const { executed, picker } = await renderProject(p);
    expect(picker.textContent).toBe("🏠");

    fireEvent.click(picker);
    expect(screen.queryByLabelText("Custom icon")).toBeNull();
    expect(screen.queryByRole("button", { name: "Icon 🎯" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "No icon (show the color dot)" }));
    await waitFor(() => expect(iconChanges(executed)).toEqual([null]));
  });

  it("picks an engraving and shows it as an image", async () => {
    const { executed, picker } = await renderProject(project({ name: "Keep" }));
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("button", { name: "Engraving castle" }));
    await waitFor(() => expect(iconChanges(executed)).toEqual(["img:castle"]));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Project color and icon" }).querySelector("img"),
      ).not.toBeNull(),
    );
  });
});
