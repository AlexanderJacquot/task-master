import { commands, events } from "../bindings";
import type { Activity, Changed, Changes, Command, CommandError, Snapshot } from "./types";

/** A failure reported by the core (`invalid`, `not_found`, `internal`) or by Tauri itself. */
export class ApiError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: CommandError | string };

async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const result = await call;
  if (result.status === "ok") return result.data;
  const { error } = result;
  // Framework failures (unknown command, bad argument) arrive as plain strings.
  if (typeof error === "string") throw new ApiError("internal", error);
  throw new ApiError(error.kind, error.message);
}

/** Everything the UI may ask of the core. Injected into the store so tests can fake it. */
export interface Api {
  snapshot(): Promise<Snapshot>;
  execute(commands: Command[]): Promise<Changes>;
  undo(): Promise<Changes | null>;
  redo(): Promise<Changes | null>;
  search(text: string, limit: number): Promise<string[]>;
  taskActivity(taskId: string, limit: number): Promise<Activity[]>;
  onChanged(handler: (event: Changed) => void): Promise<() => void>;
}

export const tauriApi: Api = {
  snapshot: () => unwrap(commands.snapshot()),
  execute: (list) => unwrap(commands.execute(list)),
  undo: () => unwrap(commands.undo()),
  redo: () => unwrap(commands.redo()),
  search: (text, limit) => unwrap(commands.search(text, limit)),
  taskActivity: (taskId, limit) => unwrap(commands.taskActivity(taskId, limit)),
  onChanged: (handler) => events.storeChanged.listen((event) => handler(event.payload)),
};
