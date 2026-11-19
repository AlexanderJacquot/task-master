// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { createScribeStore, ScribeProvider } from "../../lib/scribe";
import type { Changes, Meeting } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, fakeScribe, meeting, snapshot } from "../../test/fixtures";

const empty: Changes = {
  batch_id: "b",
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
  meetings: [],
  transcript_segments: [],
  terminal_sessions: [],
  statuses: [],
};

async function renderMeeting(m: Meeting, scribe = fakeScribe(), path = `/meeting/${m.id}`) {
  const api: Api = {
    snapshot: async () => snapshot({ meetings: [m] }),
    execute: async () => empty,
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
  };
  const store = createTaskStore(api);
  await store.getState().hydrate();
  const scribeStore = createScribeStore(scribe.api);
  await scribeStore.getState().connect();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <StoreProvider store={store} api={api}>
      <ScribeProvider value={{ store: scribeStore, api: scribe.api }}>
        <RouterProvider router={router} />
      </ScribeProvider>
    </StoreProvider>,
  );
  return { scribe, scribeStore, router };
}

afterEach(() => cleanup());

describe("Recording", () => {
  it("records a meeting with a reminder, a bar on every page, levels and stop", async () => {
    const m = meeting({ title: "Weekly sync" });
    const { scribe, router } = await renderMeeting(m);
    const panel = await screen.findByRole("region", { name: "Recording" });
    fireEvent.click(within(panel).getByRole("button", { name: /Record/ }));
    await waitFor(() => expect(scribe.calls).toEqual([`start:${m.id}`]));
    expect(await within(panel).findByText(/Tell everyone in the meeting/)).toBeTruthy();
    expect(within(panel).getByText(/Desk mic/)).toBeTruthy();

    const bar = screen.getByRole("status", { name: "Recording" });
    expect(within(bar).getByText("Weekly sync")).toBeTruthy();
    scribe.emitLevels({ meetingId: m.id, elapsedMs: 500, mic: 0.5, system: 0.2 });
    await waitFor(() =>
      expect(within(bar).getByRole("meter", { name: "You level" }).getAttribute("value")).toBe(
        "50",
      ),
    );

    // The bar stays on other pages and stops the recording from there.
    await router.navigate({ to: "/scribe", search: {} });
    const onScribe = await screen.findByRole("status", { name: "Recording" });
    fireEvent.click(within(onScribe).getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(scribe.calls).toContain(`stop:${m.id}`));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Recording" })).toBeNull());
  });

  it("plays a finished recording and deletes it after confirmation", async () => {
    const m = meeting();
    const scribe = fakeScribe();
    scribe.audio[m.id] = {
      state: "ready",
      started_at: m.started_at,
      duration_ms: 125_000,
      bytes: 3_200_000,
      tracks: [
        { track: "mic", path: `meeting-audio/${m.id}/mic` },
        { track: "system", path: `meeting-audio/${m.id}/system` },
      ],
      warnings: [],
    };
    await renderMeeting(m, scribe);
    const panel = await screen.findByRole("region", { name: "Recording" });
    expect(await within(panel).findByText("0:00 / 2:05")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "You" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Others" })).toBeTruthy();
    const sources = panel.querySelectorAll("audio");
    expect([...sources].map((a) => a.getAttribute("src"))).toEqual([
      `tm://localhost/meeting-audio/${m.id}/mic`,
      `tm://localhost/meeting-audio/${m.id}/system`,
    ]);
    fireEvent.click(within(panel).getByRole("button", { name: "Delete audio" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(scribe.calls).toEqual([`purge:${m.id}`]));
    expect(await within(panel).findByRole("button", { name: /Record/ })).toBeTruthy();
  });

  it("offers to keep an interrupted recording", async () => {
    const m = meeting({ state: "recording", ended_at: null });
    const scribe = fakeScribe();
    scribe.audio[m.id] = {
      state: "interrupted",
      started_at: m.started_at,
      duration_ms: 754_000,
      bytes: 10_000,
      tracks: [{ track: "mic", path: "x" }],
      warnings: [],
    };
    await renderMeeting(m, scribe);
    const panel = await screen.findByRole("region", { name: "Recording" });
    expect(await within(panel).findByText(/stopped unexpectedly after 12:34/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Keep what was recorded" }));
    await waitFor(() => expect(scribe.calls).toEqual([`recover:${m.id}:true`]));
    expect(await within(panel).findByText(/what was recorded was kept/)).toBeTruthy();
  });

  it("explains when this system cannot record, and a recording on another device", async () => {
    const scribe = fakeScribe();
    scribe.setStatus({
      support: { recording: false, system_audio: false, note: "Not on this system." },
      transcription: false,
      live: null,
    });
    const m = meeting();
    await renderMeeting(m, scribe);
    const panel = await screen.findByRole("region", { name: "Recording" });
    expect(await within(panel).findByText("Not on this system.")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /Record/ })).toBeNull();
    cleanup();

    const elsewhere = meeting({ state: "recording", ended_at: null });
    await renderMeeting(elsewhere);
    expect(await screen.findByText("Being recorded on another device.")).toBeTruthy();
  });
});
