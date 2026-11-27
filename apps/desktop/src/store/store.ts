// Normalized store hydrated from the core's snapshot (plan, section 5).
// Writes are optimistic: apply locally, call `execute`, reconcile with the returned
// entities, roll back the touched entities on error.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { Api } from "../lib/api";
import type {
  AgentSession,
  Attachment,
  Changes,
  Command,
  Comment,
  Epic,
  Meeting,
  Member,
  Note,
  NoteFolder,
  Notice,
  Project,
  Snapshot,
  Space,
  Status,
  Tag,
  Task,
  TeamInfo,
  TerminalSession,
  TimeBlock,
  TranscriptSegment,
  View,
} from "../lib/types";

type ById<T> = Record<string, T>;

export interface Entities {
  tasks: ById<Task>;
  projects: ById<Project>;
  epics: ById<Epic>;
  tags: ById<Tag>;
  /** Saved views. */
  views: ById<View>;
  /** Workflow order. */
  statuses: Status[];
  /** Files attached to live tasks. */
  attachments: ById<Attachment>;
  /** Calendar blocks of live tasks. */
  time_blocks: ById<TimeBlock>;
  /** Agent sessions of live tasks, every device's (ADR 017). */
  agent_sessions: ById<AgentSession>;
  /** Live meetings (Scribe, ADR 025). */
  meetings: ById<Meeting>;
  /** Transcript segments of the meetings opened so far (not in the snapshot). */
  transcript_segments: ById<TranscriptSegment>;
  /** Claude Code sessions run in a terminal, read from their transcripts (M21). */
  terminal_sessions: ById<TerminalSession>;
  /** Notes and their folders (ADR 032). */
  notes: ById<Note>;
  note_folders: ById<NoteFolder>;
  /** Comments on tasks (ADR 033). */
  comments: ById<Comment>;
}

/** Local edits shown before the core confirms them. */
export interface Optimistic {
  upsert?: {
    tasks?: Task[];
    projects?: Project[];
    epics?: Epic[];
    tags?: Tag[];
    views?: View[];
    statuses?: Status[];
    attachments?: Attachment[];
    time_blocks?: TimeBlock[];
    agent_sessions?: AgentSession[];
    meetings?: Meeting[];
    transcript_segments?: TranscriptSegment[];
    terminal_sessions?: TerminalSession[];
    notes?: Note[];
    note_folders?: NoteFolder[];
    comments?: Comment[];
  };
  remove?: {
    tasks?: string[];
    projects?: string[];
    epics?: string[];
    tags?: string[];
    views?: string[];
    statuses?: string[];
    attachments?: string[];
    time_blocks?: string[];
    agent_sessions?: string[];
    meetings?: string[];
    transcript_segments?: string[];
    terminal_sessions?: string[];
    notes?: string[];
    note_folders?: string[];
    comments?: string[];
  };
}

export interface TaskStoreState extends Entities {
  /**
   * The team space (ADR 033): its rows sit in the maps above with the personal ones;
   * `teamIds` says which are the team's. `null` without a team: the app shows nothing of it.
   */
  team: { info: TeamInfo | null; statuses: Status[] } | null;
  teamIds: Record<string, true>;
  members: ById<Member>;
  /** Mentions and assignments by teammates, newest first (ADR 033). */
  notices: Notice[];
  /** What each running session of this device is doing now, by session id. */
  agentActivity: Record<string, string>;
  ready: boolean;
  loadError: string | null;
  /** Last failed write, shown as a toast. */
  lastError: string | null;
  pending: number;
  hydrate(): Promise<void>;
  /**
   * Runs commands as one undoable batch. Resolves to null when the core refused them.
   * `space` names where rows without a container go (ADR 033).
   */
  mutate(commands: Command[], optimistic?: Optimistic, space?: Space): Promise<Changes | null>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Moves a personal project to the team space (ADR 033): one undoable action. */
  shareProject(projectId: string): Promise<Changes | null>;
  dismissError(): void;
  /** Starts listening for writes made elsewhere (CLI, MCP) and for agent activity. */
  connect(): Promise<() => void>;
  /** Applies entities written outside `execute` (an agent session the shell recorded). */
  record(changes: Changes | null): void;
  /** Reads a meeting's transcript; kept up to date from then on. */
  loadTranscript(meetingId: string): Promise<void>;
}

export type TaskStore = StoreApi<TaskStoreState>;

type Kind =
  | "tasks"
  | "projects"
  | "epics"
  | "tags"
  | "views"
  | "statuses"
  | "attachments"
  | "time_blocks"
  | "agent_sessions"
  | "meetings"
  | "transcript_segments"
  | "terminal_sessions"
  | "notes"
  | "note_folders"
  | "comments";
const KINDS: Kind[] = [
  "tasks",
  "projects",
  "epics",
  "tags",
  "views",
  "statuses",
  "attachments",
  "time_blocks",
  "agent_sessions",
  "meetings",
  "transcript_segments",
  "terminal_sessions",
  "notes",
  "note_folders",
  "comments",
];

/** Statuses are kept as an array in workflow order; every other kind as a map by id. */
function mapOf(state: Entities, kind: Kind): ById<{ id: string }> {
  return kind === "statuses" ? byId(state.statuses) : { ...(state[kind] as ById<{ id: string }>) };
}

function fromMap(kind: Kind, map: ById<unknown>): Partial<Entities> {
  if (kind !== "statuses") return { [kind]: map } as Partial<Entities>;
  const list = Object.values(map as ById<Status>).sort((a, b) =>
    a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1,
  );
  return { statuses: list };
}

function byId<T extends { id: string }>(list: T[]): ById<T> {
  return Object.fromEntries(list.map((item) => [item.id, item]));
}

/** Everything but transcripts, which load per meeting. */
function fromSnapshot(snapshot: Snapshot): Omit<Entities, "transcript_segments"> {
  return {
    tasks: byId(snapshot.tasks),
    projects: byId(snapshot.projects),
    epics: byId(snapshot.epics),
    tags: byId(snapshot.tags),
    views: byId(snapshot.views),
    statuses: snapshot.statuses,
    attachments: byId(snapshot.attachments),
    time_blocks: byId(snapshot.time_blocks),
    agent_sessions: byId(snapshot.agent_sessions),
    meetings: byId(snapshot.meetings),
    terminal_sessions: byId(snapshot.terminal_sessions ?? []),
    notes: byId(snapshot.notes ?? []),
    note_folders: byId(snapshot.note_folders ?? []),
    comments: byId(snapshot.comments ?? []),
  };
}

/** The personal snapshot's entities with the team space's added (ADR 033). */
function withTeam(
  personal: Omit<Entities, "transcript_segments">,
  team: Snapshot | null,
  info: TeamInfo | null,
): Omit<Entities, "transcript_segments"> & Pick<TaskStoreState, "team" | "teamIds" | "members"> {
  if (!team) return { ...personal, team: null, teamIds: {}, members: {} };
  const shared = fromSnapshot(team);
  const teamIds: Record<string, true> = {};
  for (const list of [
    team.tasks,
    team.projects,
    team.epics,
    team.tags,
    team.attachments,
    team.notes ?? [],
    team.note_folders ?? [],
    team.comments ?? [],
  ]) {
    for (const item of list) teamIds[item.id] = true;
  }
  return {
    ...personal,
    // Statuses stay the personal workflow's: the defaults share their ids in both spaces.
    tasks: { ...personal.tasks, ...shared.tasks },
    projects: { ...personal.projects, ...shared.projects },
    epics: { ...personal.epics, ...shared.epics },
    tags: { ...personal.tags, ...shared.tags },
    attachments: { ...personal.attachments, ...shared.attachments },
    notes: { ...personal.notes, ...shared.notes },
    note_folders: { ...personal.note_folders, ...shared.note_folders },
    comments: { ...personal.comments, ...shared.comments },
    team: { info, statuses: team.statuses },
    teamIds,
    members: byId(team.members ?? []),
  };
}

/** Upserts live entities and drops deleted ones. */
function applyChanges(state: Entities, changes: Changes): Partial<Entities> {
  let next: Partial<Entities> = {};
  for (const kind of KINDS) {
    const incoming = (changes[kind] ?? []) as Array<{ id: string; deleted_at: number | null }>;
    if (!incoming.length) continue;
    const map = mapOf(state, kind);
    for (const entity of incoming) {
      if (entity.deleted_at === null) map[entity.id] = entity;
      else delete map[entity.id];
    }
    next = { ...next, ...fromMap(kind, map) };
  }
  return next;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createTaskStore(api: Api): TaskStore {
  // Writes run one at a time, in order, so rollbacks never interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const ownBatches = new Set<string>();
  const unseenBatches = new Set<string>();
  // Meetings whose transcript was read: re-read when the data is.
  const transcripts = new Set<string>();

  const store = createStore<TaskStoreState>()((set, get) => {
    const record = (changes: Changes | null) => {
      if (!changes) return;
      if (changes.batch_id) {
        ownBatches.add(changes.batch_id);
        // Each id leaves when its event arrives; the cap only guards against lost events.
        if (ownBatches.size > 500) ownBatches.delete(ownBatches.values().next().value as string);
      }
      set((s) => {
        const next: Partial<TaskStoreState> = applyChanges(s, changes);
        const teamIds = changes.team_ids ?? [];
        if (teamIds.length) {
          next.teamIds = { ...s.teamIds, ...Object.fromEntries(teamIds.map((id) => [id, true])) };
        }
        if (changes.members?.length) {
          const members = { ...s.members };
          for (const m of changes.members) {
            if (m.deleted_at === null) members[m.id] = m;
            else delete members[m.id];
          }
          next.members = members;
        }
        return next;
      });
    };

    /**
     * Once no write is in flight, matches change events against our own batches (an event
     * can arrive before or after `execute` returns) and re-reads everything if any batch
     * came from someone else.
     */
    const settle = () => {
      if (get().pending > 0 || unseenBatches.size === 0) return;
      let foreign = false;
      for (const batch of unseenBatches) {
        if (ownBatches.has(batch)) ownBatches.delete(batch);
        else foreign = true;
      }
      unseenBatches.clear();
      if (foreign) void get().hydrate();
    };

    const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
      set((s) => ({ pending: s.pending + 1 }));
      const run = queue.then(work, work);
      queue = run.catch(() => undefined);
      return run.finally(() => {
        set((s) => ({ pending: s.pending - 1 }));
        settle();
      });
    };

    /** Replaces the cached segments of these meetings with the core's. */
    const readTranscripts = async (meetingIds: string[]) => {
      const read = api.transcript;
      if (!read || meetingIds.length === 0) return;
      const fetched = await Promise.all(
        meetingIds.map(async (id) => [id, await read(id)] as const),
      );
      set((s) => {
        const ids = new Set(meetingIds);
        const map: ById<TranscriptSegment> = {};
        for (const seg of Object.values(s.transcript_segments)) {
          if (!ids.has(seg.meeting_id)) map[seg.id] = seg;
        }
        for (const [, list] of fetched) for (const seg of list) map[seg.id] = seg;
        return { transcript_segments: map };
      });
    };

    return {
      tasks: {},
      projects: {},
      epics: {},
      tags: {},
      views: {},
      statuses: [],
      attachments: {},
      time_blocks: {},
      agent_sessions: {},
      meetings: {},
      transcript_segments: {},
      terminal_sessions: {},
      notes: {},
      note_folders: {},
      team: null,
      teamIds: {},
      members: {},
      notices: [],
      comments: {},
      agentActivity: {},
      ready: false,
      loadError: null,
      lastError: null,
      pending: 0,

      async hydrate() {
        try {
          const [snapshot, team, info] = await Promise.all([
            api.snapshot(),
            api.teamSnapshot ? api.teamSnapshot() : Promise.resolve(null),
            api.sync
              ? api.sync.status().then(
                  (s) => s.team ?? null,
                  () => null,
                )
              : Promise.resolve(null),
          ]);
          set({ ...withTeam(fromSnapshot(snapshot), team, info), ready: true, loadError: null });
          if (team && api.teamNotices) {
            const notices = await api.teamNotices(0, 50).catch(() => []);
            set({ notices });
          } else {
            set({ notices: [] });
          }
          // Transcripts are not in the snapshot: read the open ones again.
          await readTranscripts([...transcripts]).catch(() => undefined);
        } catch (err) {
          set({ loadError: message(err) });
        }
      },

      mutate(commands, optimistic, space) {
        // Remember what the optimistic edit replaces, entity by entity.
        const before = new Map<string, unknown>();
        if (optimistic) {
          set((s) => {
            let next: Partial<Entities> = {};
            for (const kind of KINDS) {
              const upserts = (optimistic.upsert?.[kind] ?? []) as Array<{ id: string }>;
              const removals =
                (optimistic.remove as Record<string, string[] | undefined>)?.[kind] ?? [];
              if (!upserts.length && !removals.length) continue;
              const map = mapOf(s, kind) as ById<unknown>;
              for (const entity of upserts) {
                before.set(`${kind}:${entity.id}`, map[entity.id]);
                map[entity.id] = entity;
              }
              for (const id of removals) {
                before.set(`${kind}:${id}`, map[id]);
                delete map[id];
              }
              next = { ...next, ...fromMap(kind, map) };
            }
            // Rows written to the team space show as the team's before the core answers.
            if (space === "team") {
              const ids = Object.values(optimistic.upsert ?? {}).flatMap((list) =>
                ((list ?? []) as Array<{ id: string }>).map((e) => e.id),
              );
              if (ids.length) {
                return {
                  ...next,
                  teamIds: { ...s.teamIds, ...Object.fromEntries(ids.map((id) => [id, true])) },
                };
              }
            }
            return next;
          });
        }

        return enqueue(async () => {
          try {
            const changes = await api.execute(commands, space);
            record(changes);
            return changes;
          } catch (err) {
            set((s) => {
              const maps: Partial<Record<Kind, ById<unknown>>> = {};
              for (const [key, value] of before) {
                const [kind, id] = key.split(":") as [Kind, string];
                const map = maps[kind] ?? (mapOf(s, kind) as ById<unknown>);
                maps[kind] = map;
                if (value === undefined) delete map[id];
                else map[id] = value;
              }
              let next: Partial<Entities> = {};
              for (const [kind, map] of Object.entries(maps) as Array<[Kind, ById<unknown>]>) {
                next = { ...next, ...fromMap(kind, map) };
              }
              return { ...next, lastError: message(err) };
            });
            return null;
          }
        });
      },

      shareProject: (projectId) =>
        enqueue(async () => {
          if (!api.shareProject) return null;
          try {
            const changes = await api.shareProject(projectId);
            // The personal copies leave; the team's arrive under the same ids.
            set((s) => {
              const next: Partial<TaskStoreState> = applyChanges(s, changes);
              const teamIds = { ...s.teamIds };
              for (const id of changes.team_ids ?? []) teamIds[id] = true;
              return { ...next, teamIds };
            });
            if (changes.batch_id) ownBatches.add(changes.batch_id);
            // Deleted personal copies and live team rows share ids: read both spaces again.
            await get().hydrate();
            return changes;
          } catch (err) {
            set({ lastError: message(err) });
            return null;
          }
        }),

      undo: () =>
        enqueue(async () => {
          try {
            record(await api.undo());
          } catch (err) {
            set({ lastError: message(err) });
          }
        }),

      redo: () =>
        enqueue(async () => {
          try {
            record(await api.redo());
          } catch (err) {
            set({ lastError: message(err) });
          }
        }),

      dismissError: () => set({ lastError: null }),

      async loadTranscript(meetingId) {
        transcripts.add(meetingId);
        try {
          await readTranscripts([meetingId]);
        } catch (err) {
          set({ lastError: message(err) });
        }
      },

      async connect() {
        const stopChanges = await api.onChanged((event) => {
          if (get().pending === 0 && ownBatches.delete(event.batch_id)) return;
          unseenBatches.add(event.batch_id);
          settle();
        });
        const agents = api.agents;
        if (!agents) return stopChanges;
        // Activity is live state of this device's runs, never stored in the database.
        const stopActivity = await agents.onActivity(({ session_id, activity }) => {
          set((s) => {
            const next = { ...s.agentActivity };
            if (activity === null) delete next[session_id];
            else next[session_id] = activity;
            return { agentActivity: next };
          });
        });
        try {
          const live = await agents.live();
          set((s) => {
            const next = { ...s.agentActivity };
            for (const { session_id, activity } of live) {
              if (activity !== null) next[session_id] ??= activity;
            }
            return { agentActivity: next };
          });
        } catch {
          // No live runs to show; updates still arrive through the event.
        }
        return () => {
          stopChanges();
          stopActivity();
        };
      },

      record,
    };
  });

  return store;
}
