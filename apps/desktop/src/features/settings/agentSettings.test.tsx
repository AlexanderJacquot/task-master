// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeAgents } from "../../test/fakeAgents";
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
