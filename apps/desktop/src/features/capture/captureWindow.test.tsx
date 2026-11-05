// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import type { Changes, Command } from "../../lib/types";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, snapshot } from "../../test/fixtures";
import { type CaptureControls, CaptureWindow } from "./CaptureWindow";

/** Records what the window was asked to do; plain functions, as CLAUDE.md asks. */
function fakeControls() {
  const calls: string[] = [];
  let blur: (() => void) | null = null;
  let opened: (() => void) | null = null;
  const controls: CaptureControls = {
    hide: async () => {
      calls.push("hide");
    },
    expand: async () => {
      calls.push("expand");
    },
    onOpened: async (handler) => {
      opened = handler;
      return () => {};
    },
    onBlur: async (handler) => {
      blur = handler;
      return () => {};
    },
  };
  return { controls, calls, blur: () => blur?.(), open: () => opened?.() };
}

async function renderWindow() {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot(),
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
        statuses: [],
      } as Changes;
    },
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
    files: {
      storeData: async () => {
        throw new Error("not used");
      },
      storeFile: async () => {
        throw new Error("not used");
      },
      open: async () => {},
      saveCopy: async () => false,
      openUrl: async () => {},
      pickFiles: async () => [],
      url: (id) => `tm://localhost/${id}`,
    },
  };
  const store = createTaskStore(api);
  await store.getState().hydrate();
  const fake = fakeControls();
  render(
    <StoreProvider store={store} api={api}>
      <CaptureWindow controls={fake.controls} />
    </StoreProvider>,
  );
  const input = await screen.findByRole("textbox", { name: "New task" });
  return { fake, executed, input };
}

afterEach(cleanup);

describe("the quick-capture window", () => {
  it("saves on Enter and hides, without growing", async () => {
    const { fake, executed, input } = await renderWindow();
    fireEvent.change(input, { target: { value: "Buy milk" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(executed.length).toBe(1));
    await waitFor(() => expect(fake.calls).toEqual(["hide"]));
    expect(screen.queryByRole("region", { name: "Description" })).toBeNull();
  });

  it("grows into the task editor on Shift+Enter and stays open on blur", async () => {
    const { fake, executed, input } = await renderWindow();
    fireEvent.change(input, { target: { value: "Write the report" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await screen.findByRole("region", { name: "Description" });
    expect(executed.length).toBe(1);
    expect(fake.calls).toEqual(["expand"]);
    expect((screen.getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement).value).toBe(
      "Write the report",
    );
    expect(screen.getByRole("region", { name: "Subtasks" })).toBeTruthy();
    // Ready to write: the cursor is in the description editor.
    const description = screen.getByRole("region", { name: "Description" });
    await waitFor(() => expect(description.contains(document.activeElement)).toBe(true));
    expect(document.activeElement?.classList.contains("cm-content")).toBe(true);

    act(() => fake.blur());
    expect(fake.calls).toEqual(["expand"]);
  });

  it("leaves a field on the first Esc, closes on the next, and opens small again", async () => {
    const { fake, input } = await renderWindow();
    fireEvent.change(input, { target: { value: "Plan the trip" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    const title = await screen.findByRole("textbox", { name: "Title" });

    title.focus();
    fireEvent.keyDown(title, { key: "Escape" });
    expect(document.activeElement).not.toBe(title);
    expect(fake.calls).toEqual(["expand"]);

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(fake.calls).toEqual(["expand", "hide"]));
    await screen.findByRole("textbox", { name: "New task" });

    act(() => fake.open());
    expect(screen.queryByRole("region", { name: "Description" })).toBeNull();
  });
});
