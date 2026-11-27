// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Api, SyncApi } from "../../lib/api";
import type { SyncStatus } from "../../lib/types";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeAgents } from "../../test/fakeAgents";
import { pickOption } from "../../test/select";
import { McpSettings } from "./McpSettings";

afterEach(cleanup);

const MAC = "/Applications/Task Master.app/Contents/MacOS/task-master-mcp";

function show(agents: ReturnType<typeof fakeAgents>, syncUrl?: string) {
  const sync = syncUrl
    ? ({ status: async () => ({ configured: true, url: syncUrl }) as SyncStatus } as SyncApi)
    : undefined;
  const api = { agents: agents.api, sync } as Api;
  render(
    <StoreProvider store={createTaskStore(api)} api={api}>
      <McpSettings />
    </StoreProvider>,
  );
}

it("fills in the claude mcp add line for this computer's server", async () => {
  show(fakeAgents());
  expect(
    await screen.findByText(`claude mcp add --scope user task-master -- '${MAC}'`),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("checkbox", { name: "In every project" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Let Claude edit my tasks" }));
  expect(
    screen.getByText(`claude mcp add task-master -- '${MAC}' --no-edit-user-tasks`),
  ).toBeTruthy();
});

it("starts from Settings → Agents: WSL and no editing", async () => {
  const windows = "C:\\Users\\alex\\AppData\\Local\\task-master\\task-master-mcp.exe";
  show(
    fakeAgents({
      settings: { runtime: "wsl", edit_user_tasks: false },
      mcpSetup: {
        os: "windows",
        server: windows,
        wsl_server: "/mnt/c/Users/alex/AppData/Local/task-master/task-master-mcp.exe",
      },
    }),
  );
  expect(
    await screen.findByText(
      "claude mcp add --scope user task-master -- /mnt/c/Users/alex/AppData/Local/task-master/task-master-mcp.exe --no-edit-user-tasks",
    ),
  ).toBeTruthy();
});

it("gives Claude Desktop's config, and the sync server's URL for claude.ai", async () => {
  show(fakeAgents(), "https://tasks.example.com/");
  const client = await screen.findByRole("combobox", { name: "Add it to" });
  await pickOption(client, "Claude Desktop");
  expect(screen.getByText(/Application Support\/Claude\/claude_desktop_config\.json/)).toBeTruthy();
  expect(screen.getByText(/"command": "\/Applications\/Task Master\.app/)).toBeTruthy();

  await pickOption(client, "claude.ai and the mobile apps");
  expect(await screen.findByText("https://tasks.example.com/mcp")).toBeTruthy();
});

it("says why when the server is missing", async () => {
  show(
    fakeAgents({ mcpSetup: { server: null, problem: "the task-master MCP server is missing" } }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain("is missing");
});
