// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { createScribeStore, ScribeProvider } from "../../lib/scribe";
import type { Changes, Command, Meeting, TranscriptSegment } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, fakeScribe, meeting, snapshot } from "../../test/fixtures";
import { ScribeSettings } from "../settings/ScribeSettings";

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

function line(
  m: Meeting,
  id: string,
  start: number,
  speaker: string,
  text: string,
): TranscriptSegment {
  return {
    id,
    meeting_id: m.id,
    start_ms: start,
    end_ms: start + 4_000,
    speaker,
    text,
    edited: false,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
}

beforeAll(() => {
  // jsdom does not play media.
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
});

afterEach(() => cleanup());

async function renderMeeting(
  m: Meeting,
  lines: TranscriptSegment[],
  scribe = fakeScribe(),
  path = `/meeting/${m.id}`,
) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot({ meetings: [m] }),
    execute: async (commands) => {
      executed.push(commands);
      return { ...empty, batch_id: `b${executed.length}`, op_seq: executed.length };
    },
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
    transcript: async (id) => lines.filter((l) => l.meeting_id === id),
    searchTranscripts: async () => [],
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
  return { executed, store, scribe };
}

describe("Transcript", () => {
  it("names a voice, corrects and splits a line, then validates", async () => {
    const m = meeting({ state: "review", transcribed_at: 5 });
    const lines = [
      line(m, "l1", 0, "me", "Hello everyone."),
      line(m, "l2", 5_000, "s1", "Hi, the budget is ready. Next point."),
    ];
    const { executed, store } = await renderMeeting(m, lines);
    const panel = await screen.findByRole("region", { name: "Transcript" });
    expect(await within(panel).findByText("Hello everyone.")).toBeTruthy();
    expect(within(panel).getByText("To check")).toBeTruthy();

    // Name the second voice.
    const speakers = within(panel).getByRole("list", { name: "Speakers" });
    const name = within(speakers).getByPlaceholderText("Speaker 1");
    fireEvent.change(name, { target: { value: "Ada" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() =>
      expect(executed.at(-1)).toEqual([
        {
          type: "update_meeting",
          id: m.id,
          changes: [{ speaker_name: { speaker: "s1", name: "Ada" } }],
        },
      ]),
    );
    expect(store.getState().meetings[m.id]?.speakers).toEqual({ s1: "Ada" });

    // Correct the first line.
    fireEvent.click(within(panel).getByText("Hello everyone."));
    const text = within(panel).getByRole("textbox", { name: "Line text" });
    fireEvent.change(text, { target: { value: "Hello, everyone." } });
    fireEvent.keyDown(text, { key: "Enter" });
    await waitFor(() =>
      expect(executed.at(-1)).toEqual([
        { type: "update_segment", id: "l1", changes: [{ text: "Hello, everyone." }] },
      ]),
    );
    expect(await within(panel).findByText("(corrected)")).toBeTruthy();

    // Split the second line after its first sentence.
    fireEvent.click(within(panel).getByText("Hi, the budget is ready. Next point."));
    const second = within(panel).getByRole("textbox", { name: "Line text" }) as HTMLTextAreaElement;
    second.setSelectionRange(24, 24);
    fireEvent.click(within(panel).getByRole("button", { name: /Split here/ }));
    await waitFor(() =>
      expect(executed.at(-1)?.[0]).toMatchObject({ type: "split_segment", id: "l2", at: 24 }),
    );
    expect(await within(panel).findByText("Next point.")).toBeTruthy();
    expect(within(panel).getByText("Hi, the budget is ready.")).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(executed.at(-1)).toEqual([
        { type: "update_meeting", id: m.id, changes: [{ state: "validated" }] },
      ]),
    );
    expect(await within(panel).findByText("Checked")).toBeTruthy();
  });

  it("merges two voices into one", async () => {
    const m = meeting({ state: "review", transcribed_at: 5 });
    const lines = [line(m, "l1", 0, "s1", "One."), line(m, "l2", 5_000, "s2", "Two.")];
    const { executed } = await renderMeeting(m, lines);
    const panel = await screen.findByRole("region", { name: "Transcript" });
    await within(panel).findByText("Two.");
    fireEvent.click(within(panel).getByRole("combobox", { name: "Merge Speaker 2 into" }));
    fireEvent.click(await screen.findByRole("option", { name: "Speaker 1" }));
    await waitFor(() =>
      expect(executed.at(-1)).toEqual([
        { type: "reassign_speaker", meeting_id: m.id, from: "s2", to: "s1" },
      ]),
    );
  });

  it("plays the recording from a line's time", async () => {
    const m = meeting({ state: "review", transcribed_at: 5 });
    const scribe = fakeScribe();
    scribe.audio[m.id] = {
      state: "ready",
      started_at: m.started_at,
      duration_ms: 60_000,
      bytes: 1_000,
      tracks: [{ track: "mic", path: `meeting-audio/${m.id}/mic` }],
      warnings: [],
      job: null,
      purge_at: null,
    };
    await renderMeeting(m, [line(m, "l1", 12_000, "me", "Twelve seconds in.")], scribe);
    const panel = await screen.findByRole("region", { name: "Transcript" });
    const time = await within(panel).findByRole("button", { name: "0:12" });
    await waitFor(() => expect((time as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(time);
    const audio = document.querySelector("audio") as HTMLAudioElement;
    expect(audio.currentTime).toBe(12);
    const player = screen.getByRole("region", { name: "Recording" });
    expect(within(player).getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("transcribes a recording, shows its progress and when the audio goes", async () => {
    const m = meeting({ state: "held" });
    const scribe = fakeScribe();
    scribe.audio[m.id] = {
      state: "ready",
      started_at: m.started_at,
      duration_ms: 60_000,
      bytes: 1_000,
      tracks: [{ track: "mic", path: `meeting-audio/${m.id}/mic` }],
      warnings: [],
      job: null,
      purge_at: Date.now() + 24 * 60 * 60 * 1000,
    };
    await renderMeeting(m, [], scribe);
    const panel = await screen.findByRole("region", { name: "Recording" });
    expect(await within(panel).findByText(/The audio will be deleted on/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Transcribe" }));
    await waitFor(() => expect(scribe.calls).toEqual([`process:${m.id}`]));
    expect(await within(panel).findByText("Waiting to be transcribed…")).toBeTruthy();
    scribe.emitProgress({ meetingId: m.id, step: "speakers", fraction: 0.5 });
    expect(await within(panel).findByText("Telling the voices apart…")).toBeTruthy();
    expect(within(panel).getByText("50%")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(scribe.calls).toContain(`cancel-process:${m.id}`));
  });

  it("opens on a searched line", async () => {
    const m = meeting({ state: "validated", transcribed_at: 5 });
    await renderMeeting(
      m,
      [line(m, "l1", 0, "me", "First."), line(m, "l2", 5_000, "s1", "The budget.")],
      fakeScribe(),
      `/meeting/${m.id}?line=l2`,
    );
    const panel = await screen.findByRole("region", { name: "Transcript" });
    const current = await within(panel).findByText("The budget.");
    expect(current.closest("[data-line]")?.getAttribute("aria-current")).toBe("true");
  });
});

describe("Settings → Scribe models", () => {
  it("downloads a model with progress, then uses and deletes it", async () => {
    const scribe = fakeScribe();
    const scribeStore = createScribeStore(scribe.api);
    await scribeStore.getState().connect();
    const api: Api = {
      snapshot: async () => snapshot({}),
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
    render(
      <StoreProvider store={store} api={api}>
        <ScribeProvider value={{ store: scribeStore, api: scribe.api }}>
          <ScribeSettings />
        </ScribeProvider>
      </StoreProvider>,
    );
    const list = await screen.findByRole("list", { name: "Transcription models" });
    const small = within(list).getByText("Fast (small)").closest("li") as HTMLElement;
    fireEvent.click(within(small).getByRole("button", { name: /Download/ }));
    await waitFor(() => expect(scribe.calls).toEqual(["download:small"]));
    scribe.emitModelProgress({
      model: "small",
      done: 100_000_000,
      total: 521_010_528,
      finished: false,
      error: null,
    });
    expect(await within(small).findByRole("progressbar", { name: /Downloading/ })).toBeTruthy();

    scribe.setModels(
      scribe.models().map((m) => ({
        ...m,
        downloading: null,
        installed: m.id !== "large-v3-turbo",
        active: m.id === "small",
      })),
    );
    scribe.emitModelProgress({
      model: "small",
      done: 521_010_528,
      total: 521_010_528,
      finished: true,
      error: null,
    });
    expect(await within(small).findByText("In use")).toBeTruthy();
    fireEvent.click(within(small).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(scribe.calls).toContain("delete-model:small"));
    expect(await within(small).findByRole("button", { name: /Download/ })).toBeTruthy();
  });
});
