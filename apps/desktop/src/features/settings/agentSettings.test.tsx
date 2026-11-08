// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeAgents } from "../../test/fakeAgents";
import { STATUS, snapshot } from "../../test/fixtures";
import { pickOption } from "../../test/select";
import { AgentSettings } from "./AgentSettings";

afterEach(cleanup);

it("checks the agent, offers the path it found and saves the settings", async () => {
  const agents = fakeAgents();
  const api = { agents: agents.api } as Api;
  render(
    <StoreProvider store={createTaskStore(api)} api={api}>
      <AgentSettings />
    </StoreProvider>,
  );
  const path = await screen.findByRole("textbox", { name: "Agent command" });
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toHaveProperty("disabled", true);

  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  expect((await screen.findByRole("status")).textContent).toContain("Found 2.1.318");
  fireEvent.click(screen.getByRole("button", { name: "Use this path" }));
  expect(path).toHaveProperty("value", "/usr/bin/claude");

  fireEvent.click(save);
  await screen.findByText("Saved.");
  expect(agents.calls).toEqual(["save settings"]);
  expect((await agents.api.settings()).claude_path).toBe("/usr/bin/claude");
  await waitFor(() => expect(save).toHaveProperty("disabled", true));
});

it("picks the statuses a task moves to when sent to an agent and when it is done", async () => {
  const agents = fakeAgents();
  const api = { agents: agents.api, snapshot: async () => snapshot() } as unknown as Api;
  const store = createTaskStore(api);
  await store.getState().hydrate();
  render(
    <StoreProvider store={store} api={api}>
      <AgentSettings />
    </StoreProvider>,
  );
  const sent = await screen.findByRole("combobox", { name: "Status when sent to an agent" });
  expect(sent.textContent).toContain("Default (In progress)");
  await pickOption(sent, "Waiting");
  await pickOption(screen.getByRole("combobox", { name: "Status when the agent is done" }), "Done");

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved.");
  const saved = await agents.api.settings();
  expect(saved.started_status_id).toBe(STATUS.waiting);
  expect(saved.done_status_id).toBe(STATUS.done);
});
