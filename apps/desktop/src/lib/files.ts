// Settings → Files (ADR 023): one row per stored content (by hash), joining this device's
// attachment folder, the sync server's, and the attachments that use each file.

import type { BlobList, StoredFileInfo } from "../bindings";
import type { Attachment, Task } from "./types";

export type FileRow = {
  hash: string;
  size: number;
  /** The first attachment's name, or the hash's start for a file nothing uses. */
  name: string;
  /** Live attachments of live tasks using it (several when the same file was attached twice). */
  attachments: Attachment[];
  /** The task of the first attachment. */
  task: Task | null;
  /** When it was first attached, else when it was stored. Unix ms. */
  addedAt: number;
  onDevice: boolean;
  /** `null` when the server's files are unknown (no sync, or it could not be read). */
  onServer: boolean | null;
  /** Shown as an image or link in a task's description: deleting it leaves a gap there. */
  inDescription: boolean;
};

export type FilesInput = {
  local: StoredFileInfo[];
  server: BlobList | null;
  /** Live attachments (the snapshot keeps only those of live tasks). */
  attachments: Attachment[];
  tasks: Record<string, Task>;
};

export function fileRows({ local, server, attachments, tasks }: FilesInput): FileRow[] {
  const localBy = new Map(local.map((f) => [f.hash, f]));
  const serverBy = new Map((server?.files ?? []).map((f) => [f.hash, f]));
  const purged = new Set(server?.purged ?? []);
  const usedBy = new Map<string, Attachment[]>();
  for (const a of attachments) {
    if (!tasks[a.task_id]) continue;
    const list = usedBy.get(a.hash);
    if (list) list.push(a);
    else usedBy.set(a.hash, [a]);
  }
  const hashes = new Set([...localBy.keys(), ...serverBy.keys(), ...usedBy.keys()]);
  const descriptions = Object.values(tasks)
    .map((t) => t.description ?? "")
    .filter((d) => d.includes("attachment:"));

  const rows: FileRow[] = [];
  for (const hash of hashes) {
    const used = (usedBy.get(hash) ?? []).sort((a, b) => a.created_at - b.created_at);
    const mine = localBy.get(hash);
    const theirs = serverBy.get(hash);
    // Purged and unused: the tombstone means it is on its way out everywhere.
    if (!used.length && purged.has(hash) && !mine) continue;
    const first = used[0];
    rows.push({
      hash,
      size: mine?.size ?? theirs?.size ?? first?.size ?? 0,
      name: first?.name ?? `Unused file ${hash.slice(0, 8)}`,
      attachments: used,
      task: first ? (tasks[first.task_id] ?? null) : null,
      addedAt: first?.created_at ?? mine?.stored_at ?? theirs?.stored_at ?? 0,
      onDevice: !!mine,
      onServer: server ? !!theirs : null,
      inDescription: used.some((a) => descriptions.some((d) => d.includes(`attachment:${a.id}`))),
    });
  }
  return rows;
}

export type FileSort = "largest" | "oldest" | "newest";
export type FileFilter = {
  unusedOnly: boolean;
  /** Older than this many days; 0 for any age. */
  olderThanDays: number;
  /** Larger than this many bytes; 0 for any size. */
  largerThan: number;
};

export const NO_FILTER: FileFilter = { unusedOnly: false, olderThanDays: 0, largerThan: 0 };

const DAY = 24 * 3600 * 1000;

export function filterFiles(rows: FileRow[], filter: FileFilter, now: number): FileRow[] {
  return rows.filter(
    (r) =>
      (!filter.unusedOnly || r.attachments.length === 0) &&
      (!filter.olderThanDays || r.addedAt < now - filter.olderThanDays * DAY) &&
      (!filter.largerThan || r.size > filter.largerThan),
  );
}

export function sortFiles(rows: FileRow[], sort: FileSort): FileRow[] {
  const by: Record<FileSort, (a: FileRow, b: FileRow) => number> = {
    largest: (a, b) => b.size - a.size || a.addedAt - b.addedAt,
    oldest: (a, b) => a.addedAt - b.addedAt || b.size - a.size,
    newest: (a, b) => b.addedAt - a.addedAt || b.size - a.size,
  };
  return [...rows].sort((a, b) => by[sort](a, b) || a.hash.localeCompare(b.hash));
}

export type FileTotals = {
  device: number;
  /** `null` when the server's files are unknown. */
  server: number | null;
  /** Content no live attachment uses, on this device or the server. */
  unused: number;
  unusedCount: number;
};

export function fileTotals(rows: FileRow[], server: BlobList | null): FileTotals {
  let device = 0;
  let unused = 0;
  let unusedCount = 0;
  for (const r of rows) {
    if (r.onDevice) device += r.size;
    if (!r.attachments.length) {
      unused += r.size;
      unusedCount += 1;
    }
  }
  const serverTotal = server ? server.files.reduce((sum, f) => sum + f.size, 0) : null;
  return { device, server: serverTotal, unused, unusedCount };
}
