// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FilesOverview_Serialize } from "../../bindings";
import type { Api } from "../../lib/api";
import { settingsApi } from "../../lib/settingsApi";
import type { Changes, Command } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { attachment, fakeParse, snapshot, task } from "../../test/fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("shows storage and warns about description links before deleting attachments in one batch", async () => {
  const hash = "a".repeat(64);
  const unusedHash = "b".repeat(64);
  const a = attachment({ task_id: "task", hash, name: "drawing.png", size: 1024 });
  const t = task({ id: "task", title: "Draft", description: `![image](attachment:${a.id})` });
  const overview: FilesOverview_Serialize = {
    local: [
      { hash, size: 1024, stored_at: 1, in_use: true },
      { hash: unusedHash, size: 2048, stored_at: 2, in_use: false },
    ],
    server: {
      files: [
        { hash, size: 1024, stored_at: 1 },
        { hash: unusedHash, size: 2048, stored_at: 2 },
      ],
      purged: [],
    },
    server_error: null,
  };
  const overviewCalls: number[] = [];
  const purged: string[][] = [];
  vi.spyOn(settingsApi, "filesOverview").mockImplementation(async () => {
    overviewCalls.push(1);
    return overview;
  });
  vi.spyOn(settingsApi, "purgeFiles").mockImplementation(async (hashes) => {
    purged.push(hashes);
    return { removed: hashes.length, freed_bytes: 1024, in_use: 0 };
  });

  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot({ tasks: [t], attachments: [a] }),
    execute: async (commands) => {
      executed.push(commands);
      return {
        batch_id: "batch",
        op_seq: 1,
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
      } satisfies Changes;
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
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/settings#files"] }));
  render(
    <StoreProvider store={store} api={api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );

  expect(await screen.findByText("drawing.png")).toBeTruthy();
  expect(screen.getByText("In a description")).toBeTruthy();
  expect(screen.getByText("Draft")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Clean up unused files" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select drawing.png" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
  const dialog = screen.getByRole("alertdialog", { name: "Delete files" });
  expect(dialog.textContent).toContain("shown in a description");
  expect(dialog.textContent).toContain("Backups keep their copy");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
  await waitFor(() => expect(purged).toEqual([[hash]]));
  expect(executed).toEqual([[{ type: "delete_attachment", id: a.id }]]);
  expect(overviewCalls.length).toBeGreaterThan(1);
  expect(screen.getByText(/freed on this device/)).toBeTruthy();
});
