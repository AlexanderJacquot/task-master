// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeCalendar } from "../../test/fakeCalendar";
import { fakeParse, snapshot } from "../../test/fixtures";
import { CalendarSettings } from "./CalendarSettings";

function renderWith(calendar: ReturnType<typeof fakeCalendar>) {
  const api: Api = {
    snapshot: async () => snapshot(),
    execute: async () => {
      throw new Error("not used");
    },
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
    calendar: calendar.api,
  };
  render(
    <StoreProvider store={createTaskStore(api)} api={api}>
      <CalendarSettings />
    </StoreProvider>,
  );
}

afterEach(cleanup);

describe("calendar settings", () => {
  it("connects with the pasted OAuth client", async () => {
    const calendar = fakeCalendar();
    renderWith(calendar);
    const connect = await screen.findByRole("button", { name: "Connect Google Calendar" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "123.apps.googleusercontent.com" },
    });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "s3cret" } });
    fireEvent.click(connect);
    await waitFor(() =>
      expect(calendar.calls).toEqual(["connect 123.apps.googleusercontent.com s3cret"]),
    );
    expect(await screen.findByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("lists the calendars, toggles one, syncs and disconnects", async () => {
    const calendar = fakeCalendar({
      configured: true,
      connected: true,
      last_sync_at: Date.now() - 60_000,
      last_report: { created: 2, updated: 0, deleted: 0, pulled: 1, events: 5 },
      sources: [
        {
          id: "tm",
          name: "task-master",
          color: null,
          primary: false,
          target: true,
          shown: false,
          synced_at: 1,
        },
        {
          id: "me",
          name: "Me",
          color: "#0b8043",
          primary: true,
          target: false,
          shown: true,
          synced_at: 1,
        },
        {
          id: "work",
          name: "Work",
          color: null,
          primary: false,
          target: false,
          shown: false,
          synced_at: null,
        },
      ],
    });
    renderWith(calendar);
    expect(await screen.findByText(/Last synced 1 min ago/)).toBeTruthy();
    expect(screen.getByText(/2 added/)).toBeTruthy();
    expect(screen.getByText("receives your blocks and day plans")).toBeTruthy();
    const work = screen.getByRole("checkbox", { name: /Work/ }) as HTMLInputElement;
    expect(work.checked).toBe(false);
    fireEvent.click(work);
    await waitFor(() => expect(calendar.calls).toContain("shown work true"));
    await waitFor(() =>
      expect((screen.getByRole("checkbox", { name: /Work/ }) as HTMLInputElement).checked).toBe(
        true,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(calendar.calls).toContain("sync"));
    act(() => calendar.synced({ last_error: "calendar sign-in needed: invalid_grant" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(within(screen.getByRole("alert")).getByText(/invalid_grant/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("button", { name: "Connect Google Calendar" })).toBeTruthy();
    expect(calendar.calls).toEqual(["shown work true", "sync", "disconnect"]);
  });
});

it("moves Calendar to the server and back without disconnecting Google", async () => {
  const calendar = fakeCalendar({ configured: true, connected: true, can_set_runner: true });
  renderWith(calendar);
  fireEvent.click(await screen.findByRole("button", { name: "Server" }));
  await waitFor(() => expect(calendar.calls).toEqual(["runner server"]));
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Disconnect" }) as HTMLButtonElement).disabled).toBe(
      true,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "This device" }));
  await waitFor(() => expect(calendar.calls).toEqual(["runner server", "runner this_device"]));
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Disconnect" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
});
