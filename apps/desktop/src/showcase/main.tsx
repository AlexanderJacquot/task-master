// The demo page (`showcase.html`): the real UI on sample data, without the Tauri shell.
// For README screenshots; development only (the release build has only index.html).
// Open http://localhost:1420/showcase.html#/<route> with `pnpm -C apps/desktop dev`.
import { RouterProvider } from "@tanstack/react-router";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import type { Api } from "../lib/api";
import { applyTheme, type Theme } from "../lib/theme";
import type { Changes } from "../lib/types";
import { createUpdateStore, UpdateProvider } from "../lib/updater";
import { createAppRouter } from "../router";
import { StoreProvider } from "../store/context";
import { createTaskStore } from "../store/store";
import { fakeParse } from "../test/fixtures";
import { demoSnapshot } from "./demo";

// Calls the UI makes straight to Tauri (window controls, events) answer nothing.
mockWindows("main");
mockIPC(() => null);

// ?theme=light|clean|dark (default dark, as in the app).
const theme = new URLSearchParams(location.search).get("theme");
applyTheme((theme === "light" || theme === "clean" ? theme : "dark") as Theme);

const snap = demoSnapshot();
const empty: Changes = {
  batch_id: "demo",
  op_seq: 0,
  tasks: [],
  projects: [],
  epics: [],
  tags: [],
  views: [],
  statuses: [],
  attachments: [],
  time_blocks: [],
  agent_sessions: [],
  agent_notes: [],
};
const api: Api = {
  snapshot: async () => snap,
  execute: async () => empty,
  undo: async () => null,
  redo: async () => null,
  search: async (text) =>
    snap.tasks.filter((t) => t.title.toLowerCase().includes(text.toLowerCase())).map((t) => t.id),
  taskActivity: async () => [],
  parseCapture: async (text) => fakeParse(text, snap),
  onChanged: async () => () => {},
};

const store = createTaskStore(api);
void store.getState().hydrate();
const updates = createUpdateStore({ check: async () => null, relaunch: async () => {} });

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");
createRoot(root).render(
  <StrictMode>
    <StoreProvider store={store} api={api}>
      <UpdateProvider value={updates}>
        <RouterProvider router={createAppRouter()} />
      </UpdateProvider>
    </StoreProvider>
  </StrictMode>,
);
