// Normalized store hydrated from the core's snapshot (plan, section 5).
// Writes are optimistic: apply locally, call `execute`, reconcile with the returned
// entities, roll back the touched entities on error.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { Api } from "../lib/api";
import type {
  Changes,
  Command,
  Epic,
  Project,
  Snapshot,
  Status,
  Tag,
  Task,
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
}

/** Local edits shown before the core confirms them. */
export interface Optimistic {
  upsert?: { tasks?: Task[]; projects?: Project[]; epics?: Epic[]; tags?: Tag[]; views?: View[] };
  remove?: { tasks?: string[]; projects?: string[]; epics?: string[]; views?: string[] };
}

export interface TaskStoreState extends Entities {
  ready: boolean;
  loadError: string | null;
  /** Last failed write, shown as a toast. */
  lastError: string | null;
  pending: number;
  hydrate(): Promise<void>;
  /** Runs commands as one undoable batch. Resolves to null when the core refused them. */
  mutate(commands: Command[], optimistic?: Optimistic): Promise<Changes | null>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  dismissError(): void;
  /** Starts listening for writes made elsewhere (CLI, MCP later). Returns an unsubscribe. */
  connect(): Promise<() => void>;
}

export type TaskStore = StoreApi<TaskStoreState>;

type Kind = "tasks" | "projects" | "epics" | "tags" | "views";
const KINDS: Kind[] = ["tasks", "projects", "epics", "tags", "views"];

function byId<T extends { id: string }>(list: T[]): ById<T> {
  return Object.fromEntries(list.map((item) => [item.id, item]));
}

function fromSnapshot(snapshot: Snapshot): Entities {
  return {
    tasks: byId(snapshot.tasks),
    projects: byId(snapshot.projects),
    epics: byId(snapshot.epics),
    tags: byId(snapshot.tags),
    views: byId(snapshot.views),
    statuses: snapshot.statuses,
  };
}

/** Upserts live entities and drops deleted ones. */
function applyChanges(state: Entities, changes: Changes): Partial<Entities> {
  const next: Partial<Entities> = {};
  for (const kind of KINDS) {
    const incoming = changes[kind] as Array<{ id: string; deleted_at: number | null }>;
    if (!incoming.length) continue;
    const map = { ...state[kind] } as ById<{ id: string }>;
    for (const entity of incoming) {
      if (entity.deleted_at === null) map[entity.id] = entity;
      else delete map[entity.id];
    }
    (next as Record<Kind, unknown>)[kind] = map;
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

  const store = createStore<TaskStoreState>()((set, get) => {
    const record = (changes: Changes | null) => {
      if (!changes) return;
      if (changes.batch_id) {
        ownBatches.add(changes.batch_id);
        // Each id leaves when its event arrives; the cap only guards against lost events.
        if (ownBatches.size > 500) ownBatches.delete(ownBatches.values().next().value as string);
      }
      set((s) => applyChanges(s, changes));
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

    return {
      tasks: {},
      projects: {},
      epics: {},
      tags: {},
      views: {},
      statuses: [],
      ready: false,
      loadError: null,
      lastError: null,
      pending: 0,

      async hydrate() {
        try {
          const snapshot = await api.snapshot();
          set({ ...fromSnapshot(snapshot), ready: true, loadError: null });
        } catch (err) {
          set({ loadError: message(err) });
        }
      },

      mutate(commands, optimistic) {
        // Remember what the optimistic edit replaces, entity by entity.
        const before = new Map<string, unknown>();
        if (optimistic) {
          set((s) => {
            const next: Partial<Entities> = {};
            for (const kind of KINDS) {
              const upserts = (optimistic.upsert?.[kind] ?? []) as Array<{ id: string }>;
              const removals =
                (optimistic.remove as Record<string, string[] | undefined>)?.[kind] ?? [];
              if (!upserts.length && !removals.length) continue;
              const map = { ...s[kind] } as ById<unknown>;
              for (const entity of upserts) {
                before.set(`${kind}:${entity.id}`, s[kind][entity.id]);
                map[entity.id] = entity;
              }
              for (const id of removals) {
                before.set(`${kind}:${id}`, s[kind][id]);
                delete map[id];
              }
              (next as Record<Kind, unknown>)[kind] = map;
            }
            return next;
          });
        }

        return enqueue(async () => {
          try {
            const changes = await api.execute(commands);
            record(changes);
            return changes;
          } catch (err) {
            set((s) => {
              const next: Partial<Record<Kind, ById<unknown>>> = {};
              for (const [key, value] of before) {
                const [kind, id] = key.split(":") as [Kind, string];
                const map = next[kind] ?? { ...(s[kind] as ById<unknown>) };
                next[kind] = map;
                if (value === undefined) delete map[id];
                else map[id] = value;
              }
              return { ...(next as Partial<Entities>), lastError: message(err) };
            });
            return null;
          }
        });
      },

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

      connect: () =>
        api.onChanged((event) => {
          if (get().pending === 0 && ownBatches.delete(event.batch_id)) return;
          unseenBatches.add(event.batch_id);
          settle();
        }),
    };
  });

  return store;
}
