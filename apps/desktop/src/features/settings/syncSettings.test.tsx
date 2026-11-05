// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api, SyncApi } from "../../lib/api";
import type { AuthMode, SyncStatus } from "../../lib/types";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, snapshot } from "../../test/fixtures";
import { SyncSettings } from "./SyncSettings";

const EMPTY: SyncStatus = {
  configured: false,
  url: "",
  device_name: "",
  auth: null,
  signed_in: false,
  server_empty: null,
  joined: false,
  syncing: false,
  last_sync_at: null,
  last_error: null,
  last_pushed: 0,
  last_pulled: 0,
  clock_offset_ms: 0,
  clock_warning: false,
  pending: 0,
};

/** A fake server behind the sync API: `auth` decides what connecting needs. */
function fakeSync(
  auth: AuthMode,
  opts: { serverEmpty?: boolean; start?: Partial<SyncStatus> } = {},
) {
  let status: SyncStatus = { ...EMPTY, ...opts.start };
  const calls: string[] = [];
  let listener: ((s: SyncStatus) => void) | null = null;
  const update = (patch: Partial<SyncStatus>) => {
    status = { ...status, ...patch };
    return status;
  };
  const api: SyncApi = {
    status: async () => status,
    connect: async (url) => {
      calls.push(`connect ${url}`);
      return update({
        configured: true,
        url,
        auth,
        device_name: "Laptop",
        server_empty: auth === "none" ? (opts.serverEmpty ?? false) : null,
      });
    },
    setToken: async (token) => {
      calls.push(`token ${token}`);
      if (token !== "tm_good") throw new Error("not authorized: unknown or revoked token");
      return update({ signed_in: true, server_empty: opts.serverEmpty ?? false });
    },
    signIn: async () => {
      calls.push("sign-in");
      return update({ signed_in: true, server_empty: opts.serverEmpty ?? false });
    },
    join: async (mode) => {
      calls.push(`join ${mode}`);
      return update({ joined: true });
    },
    syncNow: async () => {
      calls.push("sync");
      return status;
    },
    disconnect: async () => {
      calls.push("disconnect");
      status = { ...EMPTY };
      return status;
    },
    onChanged: async (handler) => {
      listener = handler;
      return () => {
        listener = null;
      };
    },
  };
  return { api, calls, push: (patch: Partial<SyncStatus>) => listener?.(update(patch)) };
}

function renderWith(sync: SyncApi) {
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
    sync,
  };
  render(
    <StoreProvider store={createTaskStore(api)} api={api}>
      <SyncSettings />
    </StoreProvider>,
  );
}

async function connect(url: string) {
  fireEvent.change(await screen.findByLabelText("Server address"), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}

afterEach(cleanup);

describe("sync settings", () => {
  it("signs in with OIDC, then replaces this device's tasks only after confirming", async () => {
    const sync = fakeSync("oidc");
    renderWith(sync.api);
    await connect("tasks.example.org");
    expect(await screen.findByText("(sign-in)")).toBeTruthy();
    expect(screen.getByText(/this device: Laptop/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/already has tasks/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Replace with the server's tasks" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Replace this device's tasks" });
    expect(confirm.textContent).toMatch(/backed up/);
    expect(sync.calls).not.toContain("join replace");
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    expect(await screen.findByText(/first sync starts/)).toBeTruthy();
    expect(sync.calls).toEqual(["connect tasks.example.org", "sign-in", "join replace"]);
  });

  it("starts a waiting sign-in over and ignores the replaced attempt", async () => {
    const sync = fakeSync("oidc");
    // Each sign-in waits for the browser until the test settles it.
    const attempts: { resolve: () => void; reject: (e: Error) => void }[] = [];
    const finish = sync.api.signIn;
    sync.api.signIn = () =>
      new Promise<SyncStatus>((resolve, reject) => {
        attempts.push({
          resolve: () => void finish().then(resolve),
          reject: (e) => reject(e),
        });
      });
    renderWith(sync.api);
    await connect("tasks.example.org");

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Finish signing in in your browser/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    await waitFor(() => expect(attempts).toHaveLength(2));

    // The backend fails the replaced attempt; the newer one is still waiting.
    await act(async () => attempts[0]?.reject(new Error("replaced by a newer sign-in")));
    expect(screen.queryByText(/replaced/)).toBeNull();
    expect(screen.getByText(/Finish signing in in your browser/)).toBeTruthy();

    await act(async () => attempts[1]?.resolve());
    expect(await screen.findByText(/already has tasks/)).toBeTruthy();
    expect(screen.queryByText(/Finish signing in/)).toBeNull();
  });

  it("asks for a token, shows a refused one, and uploads to an empty server", async () => {
    const sync = fakeSync("token", { serverEmpty: true });
    renderWith(sync.api);
    await connect("http://nas:8080");
    const field = await screen.findByLabelText("Token");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();

    fireEvent.change(field, { target: { value: "tm_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/revoked/);

    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "tm_good" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    expect(await screen.findByText(/The server is empty/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upload this device's tasks" }));
    await waitFor(() => expect(sync.calls).toContain("join merge"));
  });

  it("goes straight to the start choice on a server without sign-in", async () => {
    const sync = fakeSync("none");
    renderWith(sync.api);
    await connect("http://192.168.1.5:8080");
    expect(await screen.findByText("(no sign-in)")).toBeTruthy();
    expect(screen.queryByLabelText("Token")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Merge: keep this device's tasks too" }));
    await waitFor(() => expect(sync.calls).toContain("join merge"));
  });

  it("shows the sync status, errors and the clock warning, and disconnects", async () => {
    const sync = fakeSync("none", {
      start: {
        configured: true,
        url: "https://tasks.example.org",
        auth: "none",
        joined: true,
        last_sync_at: Date.now() - 120_000,
        last_pushed: 3,
        last_pulled: 7,
        pending: 2,
      },
    });
    renderWith(sync.api);
    expect(await screen.findByText(/Synced 2 min ago/)).toBeTruthy();
    expect(screen.getByText(/3 sent, 7 received/)).toBeTruthy();
    expect(screen.getByText(/2 changes waiting/)).toBeTruthy();

    act(() => sync.push({ syncing: true }));
    expect(await screen.findByText("Syncing…")).toBeTruthy();
    act(() =>
      sync.push({
        syncing: false,
        last_error: "server unreachable: tasks.example.org",
        clock_warning: true,
        clock_offset_ms: -95_000,
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/unreachable/);
    expect(screen.getByText(/clock is off by 95 seconds/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(sync.calls).toContain("sync"));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByLabelText("Server address")).toBeTruthy();
  });
});
