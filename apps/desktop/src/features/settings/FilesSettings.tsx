// Settings → Files (ADR 023): what attached files take up on this device and on the sync
// server, and deleting old or large ones everywhere. Deleting removes the attachments (one
// undoable batch), then purges the content here; the next sync purges it on the server,
// whose tombstone makes the other devices drop their copy. Backups keep theirs.

import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FilesOverview_Serialize } from "../../bindings";
import { Button, Checkbox, cx, Select } from "../../components/ui";
import { FileIcon, FileTextIcon } from "../../components/TaskIcons";
import { formatSize, isImage } from "../../lib/attachments";
import { isoDate } from "../../lib/dates";
import {
  type FileFilter,
  type FileRow,
  type FileSort,
  fileRows,
  fileTotals,
  filterFiles,
  NO_FILTER,
  sortFiles,
} from "../../lib/files";
import { settingsApi } from "../../lib/settingsApi";
import { deleteAttachmentsOfFiles } from "../../store/actions";
import { useApi, useStoreState, useTaskStore } from "../../store/context";
import { Section } from "./SettingsPage";

const ROW_HEIGHT = 56;
const MB = 1024 * 1024;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sizeOf(rows: FileRow[]): number {
  return rows.reduce((sum, r) => sum + r.size, 0);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-36 flex-1 flex-col gap-0.5 rounded-lg border border-line px-3 py-2">
      <span className="text-xs text-ink-3">{label}</span>
      <span className="text-lg tabular-nums">{value}</span>
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </div>
  );
}

/** A sneak peek: the image itself when this device has it, else an icon by file type. */
function Preview({ row, url }: { row: FileRow; url: string | null }) {
  const [broken, setBroken] = useState(false);
  const first = row.attachments[0];
  if (first && url && isImage(first) && row.onDevice && !broken) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className="size-10 shrink-0 rounded-md border border-line object-cover"
      />
    );
  }
  const Icon =
    first && (first.mime === "application/pdf" || first.mime.startsWith("text/"))
      ? FileTextIcon
      : FileIcon;
  return (
    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-hover text-ink-3">
      <Icon size={18} />
    </span>
  );
}

function FileLine({
  row,
  url,
  checked,
  onToggle,
  onOpenTask,
}: {
  row: FileRow;
  url: string | null;
  checked: boolean;
  onToggle: () => void;
  onOpenTask: (id: string) => void;
}) {
  const where =
    !row.onDevice && row.onServer
      ? "Only on the server"
      : row.onDevice && row.onServer === false
        ? "Not on the server yet"
        : !row.onDevice && !row.onServer
          ? "Not downloaded"
          : null;
  return (
    <div className="flex h-full items-center gap-3 border-b border-line px-2 text-sm">
      <Checkbox checked={checked} onChange={onToggle} label={`Select ${row.name}`} />
      <Preview row={row} url={url} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" title={row.name}>
          {row.name}
          {row.attachments.length > 1 && (
            <span className="text-ink-3"> · attached {row.attachments.length} times</span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-ink-3">
          {row.task ? (
            <button
              type="button"
              className="truncate hover:text-accent hover:underline"
              onClick={() => row.task && onOpenTask(row.task.id)}
            >
              {row.task.title}
            </button>
          ) : (
            <span>No task uses it</span>
          )}
          {row.inDescription && (
            <span className="inline-flex shrink-0 items-center gap-1 text-high">
              <TriangleAlert size={12} aria-hidden /> In a description
            </span>
          )}
          {where && <span className="shrink-0">{where}</span>}
        </span>
      </div>
      <span className="w-20 shrink-0 text-right tabular-nums">{formatSize(row.size)}</span>
      <span className="w-24 shrink-0 text-right text-xs text-ink-3 tabular-nums">
        {row.addedAt ? isoDate(new Date(row.addedAt)) : ""}
      </span>
    </div>
  );
}

export function FilesSettings() {
  const store = useTaskStore();
  const filesApi = useApi().files;
  const navigate = useNavigate();
  const attachments = useStoreState((s) => s.attachments);
  const tasks = useStoreState((s) => s.tasks);
  const [overview, setOverview] = useState<FilesOverview_Serialize | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sort, setSort] = useState<FileSort>("largest");
  const [filter, setFilter] = useState<FileFilter>(NO_FILTER);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    () =>
      settingsApi.filesOverview().then(
        (o) => {
          setOverview(o);
          setError(null);
        },
        (e) => setError(message(e)),
      ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const server = overview?.server ?? null;
  const rows = useMemo(
    () =>
      overview
        ? fileRows({
            local: overview.local,
            server,
            attachments: Object.values(attachments),
            tasks,
          })
        : [],
    [overview, server, attachments, tasks],
  );
  const shown = useMemo(
    () => sortFiles(filterFiles(rows, filter, Date.now()), sort),
    [rows, filter, sort],
  );
  const totals = useMemo(() => fileTotals(rows, server), [rows, server]);
  const byHash = useMemo(() => new Map(rows.map((r) => [r.hash, r])), [rows]);
  const picked = [...selected].flatMap((h) => byHash.get(h) ?? []);
  const allShown = shown.length > 0 && shown.every((r) => selected.has(r.hash));

  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => shown[i]?.hash ?? i,
  });

  const toggle = (hash: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });

  async function remove(hashes: string[]) {
    setBusy(true);
    setNotice(null);
    try {
      const hadAttachments = hashes.some((hash) => (byHash.get(hash)?.attachments.length ?? 0) > 0);
      const deleted = await deleteAttachmentsOfFiles(store, hashes);
      if (hadAttachments && deleted === null) {
        throw new Error("Could not remove the attachments. File content was kept.");
      }
      const report = await settingsApi.purgeFiles(hashes);
      const kept = report.in_use
        ? ` ${plural(report.in_use, "file")} still used by a task ${report.in_use === 1 ? "was" : "were"} kept.`
        : "";
      const elsewhere = server
        ? " The server and your other devices remove them at their next sync."
        : "";
      setNotice(
        `Deleted ${plural(hashes.length - report.in_use, "file")}, ${formatSize(report.freed_bytes)} freed on this device.${elsewhere}${kept}`,
      );
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  const unusedHashes = rows.filter((r) => !r.attachments.length).map((r) => r.hash);
  const confirmRows = (confirm ?? []).flatMap((h) => byHash.get(h) ?? []);
  const confirmUsed = confirmRows.filter((r) => r.attachments.length).length;
  const confirmInDescription = confirmRows.filter((r) => r.inDescription).length;

  return (
    <>
      <Section
        title="Storage"
        hint="Attached files are stored once each on every device and on the sync server. Backups keep their own copy, so a deleted file can still be recovered from a backup."
      >
        {overview ? (
          <div className="flex flex-wrap gap-2">
            <Tile label="On this device" value={formatSize(totals.device)} />
            <Tile
              label="On the server"
              value={totals.server === null ? "—" : formatSize(totals.server)}
              hint={totals.server === null && !overview.server_error ? "Not syncing" : undefined}
            />
            <Tile
              label="Unused"
              value={formatSize(totals.unused)}
              hint={plural(totals.unusedCount, "file")}
            />
          </div>
        ) : (
          !error && <p className="text-sm text-ink-3">Reading files…</p>
        )}
        {overview?.server_error && (
          <p className="text-xs text-ink-3">Server files unavailable: {overview.server_error}</p>
        )}
        {totals.unusedCount > 0 && (
          <div>
            <Button size="sm" disabled={busy} onClick={() => setConfirm(unusedHashes)}>
              Clean up unused files
            </Button>
          </div>
        )}
      </Section>

      <Section
        title="Files"
        hint="Deleting a file removes it from its tasks, this device, the server and your other devices. Undo brings the attachment back, but not its content."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Sort files"
            value={sort}
            onValueChange={(v) => setSort(v as FileSort)}
            className="w-36"
            options={[
              { value: "largest", label: "Largest first" },
              { value: "oldest", label: "Oldest first" },
              { value: "newest", label: "Newest first" },
            ]}
          />
          <Select
            aria-label="Age"
            value={String(filter.olderThanDays)}
            onValueChange={(v) => setFilter({ ...filter, olderThanDays: Number(v) })}
            className="w-44"
            options={[
              { value: "0", label: "Any age" },
              { value: "30", label: "Older than a month" },
              { value: "90", label: "Older than 3 months" },
              { value: "365", label: "Older than a year" },
            ]}
          />
          <Select
            aria-label="Size"
            value={String(filter.largerThan)}
            onValueChange={(v) => setFilter({ ...filter, largerThan: Number(v) })}
            className="w-40"
            options={[
              { value: "0", label: "Any size" },
              { value: String(MB), label: "Larger than 1 MB" },
              { value: String(10 * MB), label: "Larger than 10 MB" },
            ]}
          />
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={filter.unusedOnly}
              onChange={() => setFilter({ ...filter, unusedOnly: !filter.unusedOnly })}
              className="size-4 shrink-0 cursor-pointer accent-accent"
            />
            Unused only
          </label>
        </div>

        <div className="flex items-center gap-3 px-2 pt-1 text-xs text-ink-3">
          <Checkbox
            checked={allShown}
            onChange={() => setSelected(allShown ? new Set() : new Set(shown.map((r) => r.hash)))}
            label="Select all shown"
          />
          <span className="flex-1">
            {plural(shown.length, "file")}, {formatSize(sizeOf(shown))}
          </span>
          <span className="w-20 text-right">Size</span>
          <span className="w-24 text-right">Added</span>
        </div>
        <div
          ref={scrollRef}
          className="max-h-[55vh] overflow-y-auto rounded-lg border border-line"
          data-testid="file-list"
        >
          {shown.length === 0 ? (
            <p className="p-4 text-sm text-ink-3">
              {overview ? "No files match." : "Reading files…"}
            </p>
          ) : (
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = shown[item.index];
                if (!row) return null;
                return (
                  <div
                    key={item.key}
                    className="absolute inset-x-0"
                    style={{ top: item.start, height: ROW_HEIGHT }}
                  >
                    <FileLine
                      row={row}
                      url={row.attachments[0] ? (filesApi?.url(row.attachments[0].id) ?? null) : null}
                      checked={selected.has(row.hash)}
                      onToggle={() => toggle(row.hash)}
                      onOpenTask={(taskId) =>
                        void navigate({ to: "/task/$taskId", params: { taskId }, search: {} })
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {picked.length > 0 && !confirm && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ink-2">
              {plural(picked.length, "file")} selected, {formatSize(sizeOf(picked))}
            </span>
            <Button
              size="sm"
              className="border-danger text-danger"
              disabled={busy}
              onClick={() => setConfirm(picked.map((r) => r.hash))}
            >
              Delete…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}
      </Section>

      {confirm && (
        <div
          role="alertdialog"
          aria-label="Delete files"
          className={cx(
            "sticky bottom-0 flex flex-col gap-2 border border-danger/40 bg-overlay p-3 text-sm",
            "rounded-lg shadow-lg",
          )}
        >
          <span>
            Delete {plural(confirmRows.length, "file")} ({formatSize(sizeOf(confirmRows))})
            permanently from this device, the server and your other devices?
            {confirmUsed > 0 &&
              ` ${confirmUsed === 1 ? "One is" : `${confirmUsed} are`} attached to tasks and will be removed from them.`}
            {confirmInDescription > 0 &&
              ` ${confirmInDescription === 1 ? "One is" : `${confirmInDescription} are`} shown in a description, which will show a missing file.`}{" "}
            Backups keep their copy.
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="border-danger text-danger"
              disabled={busy}
              onClick={() => void remove(confirm)}
            >
              {busy ? "Deleting…" : "Delete permanently"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="pt-3 text-sm text-ink-2">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="pt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}
