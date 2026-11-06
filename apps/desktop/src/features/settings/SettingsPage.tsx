import { useRouterState } from "@tanstack/react-router";
import { open, save } from "@tauri-apps/plugin-dialog";
import { type ReactNode, useEffect, useState } from "react";
import { cx, Dot, InlineInput, Select } from "../../components/ui";
import { loadOpenInPanel, saveOpenInPanel } from "../../lib/capturePrefs";
import { formatAgo, isoDate } from "../../lib/dates";
import { settingsApi } from "../../lib/settingsApi";
import { loadTheme, saveTheme, THEME_LABELS, type Theme } from "../../lib/theme";
import type {
  BackupStatus,
  ConfigView,
  RemoteInput,
  Status,
  StatusCategory,
} from "../../lib/types";
import { createStatus, deleteStatus, moveStatus, updateStatus } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { PROJECT_COLORS } from "../organize/projectColors";
import { HeaderButton } from "../shell/ViewPage";
import { About } from "./About";
import { AgentSettings } from "./AgentSettings";
import { CalendarSettings } from "./CalendarSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { SyncSettings } from "./SyncSettings";

const CATEGORIES: Array<{ value: StatusCategory; label: string }> = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

export function Section({
  title,
  hint,
  id,
  children,
}: {
  title: string;
  hint?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-4 flex-col gap-2.5 border-b border-line py-6">
      <h2 className="font-display text-[19px] tracking-wide text-accent">{title}</h2>
      {hint && <p className="text-xs text-neutral-500">{hint}</p>}
      {children}
    </section>
  );
}

function StatusRow({ status, first, last }: { status: Status; first: boolean; last: boolean }) {
  const store = useTaskStore();
  const color = status.color ?? null;
  return (
    <li className="flex items-center gap-2" data-testid="status-row">
      <div className="flex flex-col">
        <button
          type="button"
          aria-label={`Move ${status.name} left`}
          disabled={first}
          onClick={() => void moveStatus(store, status.id, -1)}
          className="text-xs leading-none text-neutral-500 disabled:opacity-30"
        >
          ▲
        </button>
        <button
          type="button"
          aria-label={`Move ${status.name} right`}
          disabled={last}
          onClick={() => void moveStatus(store, status.id, 1)}
          className="text-xs leading-none text-neutral-500 disabled:opacity-30"
        >
          ▼
        </button>
      </div>
      <Select
        aria-label={`${status.name} color`}
        value={color ?? ""}
        onValueChange={(c) => void updateStatus(store, status.id, [{ color: c || null }])}
        className="w-28 text-xs text-ink-2"
        options={[
          { value: "", label: "No color", icon: <Dot color={null} /> },
          ...PROJECT_COLORS.map((c) => ({ value: c, label: c, icon: <Dot color={c} /> })),
        ]}
      />
      <input
        aria-label="Status name"
        defaultValue={status.name}
        key={status.name}
        onBlur={(e) => {
          const name = e.currentTarget.value.trim();
          if (name && name !== status.name) void updateStatus(store, status.id, [{ name }]);
          else e.currentTarget.value = status.name;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-40 rounded border border-transparent bg-transparent px-1 hover:border-neutral-300 focus:border-blue-500 focus:outline-none dark:hover:border-neutral-700"
      />
      <Select
        aria-label={`${status.name} category`}
        value={status.category}
        onValueChange={(category) => void updateStatus(store, status.id, [{ category }])}
        className="w-32 text-xs"
        options={CATEGORIES}
      />
      <label className="flex items-center gap-1 text-xs text-neutral-500">
        WIP limit
        <input
          type="number"
          min={1}
          max={999}
          aria-label={`${status.name} WIP limit`}
          defaultValue={status.wip_limit ?? ""}
          key={status.wip_limit ?? "none"}
          placeholder="none"
          onBlur={(e) => {
            const raw = e.currentTarget.value.trim();
            const value = raw ? Number(raw) : null;
            if (value !== status.wip_limit)
              void updateStatus(store, status.id, [{ wip_limit: value }]);
          }}
          className="w-16 rounded border border-neutral-300 bg-transparent px-1 dark:border-neutral-700"
        />
      </label>
      <button
        type="button"
        aria-label={`Delete ${status.name}`}
        onClick={() => void deleteStatus(store, status.id)}
        className="ml-auto rounded px-1.5 text-xs text-neutral-500 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
      >
        Delete
      </button>
    </li>
  );
}

function Workflow() {
  const store = useTaskStore();
  const statuses = useStoreState((s) => s.statuses);
  const [adding, setAdding] = useState(false);
  return (
    <Section
      title="Workflow"
      hint="Board columns, left to right. A column holding tasks cannot be deleted or change category; the app keeps at least one To do and one Done column. Undo works here too."
    >
      <ol className="flex flex-col gap-1.5">
        {statuses.map((s, i) => (
          <StatusRow key={s.id} status={s} first={i === 0} last={i === statuses.length - 1} />
        ))}
      </ol>
      {adding ? (
        <InlineInput
          initial=""
          placeholder="Column name, e.g. Review"
          className="w-64"
          onCommit={(name) => {
            setAdding(false);
            void createStatus(store, name, "in_progress");
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div>
          <HeaderButton onClick={() => setAdding(true)}>Add column</HeaderButton>
        </div>
      )}
    </Section>
  );
}

function Appearance() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  return (
    <Section title="Appearance">
      <div className="flex gap-3" role="radiogroup" aria-label="Theme">
        {(["dark", "light", "system"] as const).map((t) => (
          <label key={t} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="theme"
              checked={theme === t}
              onChange={() => {
                setTheme(t);
                saveTheme(t);
              }}
              className="accent-accent"
            />
            {THEME_LABELS[t]}
          </label>
        ))}
      </div>
    </Section>
  );
}

function AddingTasks() {
  const [open, setOpen] = useState(loadOpenInPanel);
  return (
    <Section title="Adding tasks" hint="Remembered on this computer.">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={open}
          onChange={(e) => {
            setOpen(e.target.checked);
            saveOpenInPanel(e.target.checked);
          }}
          className="accent-accent"
        />
        Open a task added from a view's top row in the side panel, ready to describe
      </label>
    </Section>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Desktop-only settings: data folder, backups, export/import, remote backup. */
function Data() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [confirmImport, setConfirmImport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    settingsApi.getConfig().then(setConfig, (e) => setNote({ text: message(e), error: true }));
    settingsApi.backupStatus().then(setStatus, () => {});
  }, []);

  const run = async (work: () => Promise<string | undefined>) => {
    setBusy(true);
    setNote(null);
    try {
      const text = await work();
      if (text) setNote({ text });
    } catch (e) {
      setNote({ text: message(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const stamp = (ms: number | null | undefined) => (ms ? formatAgo(ms) : "never");

  return (
    <>
      <Section
        title="Data folder"
        hint="Where the database and its backups live. Changing it copies the data there (or opens the database already there) and restarts the app."
      >
        <p className="font-mono text-xs break-all">{config?.data_dir ?? "…"}</p>
        <div className="flex gap-2">
          <HeaderButton
            onClick={() =>
              void run(async () => {
                const dir = await open({ directory: true, title: "Choose the data folder" });
                if (typeof dir === "string") await settingsApi.setDataDir(dir);
                return undefined;
              })
            }
          >
            Change…
          </HeaderButton>
          {config?.custom_data_dir && (
            <HeaderButton
              onClick={() => void run(() => settingsApi.setDataDir(null).then(() => undefined))}
            >
              Use the default folder
            </HeaderButton>
          )}
        </div>
      </Section>

      <Section
        title="Backups"
        hint="A copy of the database is made every day (the last 14 are kept), and before every import. Attached files are copied into the backup folder's attachments/ as they are added."
      >
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-neutral-500">Folder</dt>
          <dd className="font-mono break-all">{status?.dir || "…"}</dd>
          <dt className="text-neutral-500">Last local backup</dt>
          <dd>
            {status?.last_local ?? "none yet"} ({stamp(status?.last_local_at)})
          </dd>
          <dt className="text-neutral-500">Last upload</dt>
          <dd>
            {status?.last_remote ?? "none"} ({stamp(status?.last_remote_at)})
          </dd>
          {status?.remote_error && (
            <>
              <dt className="text-neutral-500">Upload problem</dt>
              <dd className="text-amber-700 dark:text-amber-400">
                {status.remote_error} (retried every 15 minutes)
              </dd>
            </>
          )}
        </dl>
        <div className="flex gap-2">
          <HeaderButton
            onClick={() =>
              void run(async () => {
                setStatus(await settingsApi.backupNow());
                return "Backup done.";
              })
            }
          >
            {busy ? "Working…" : "Back up now"}
          </HeaderButton>
        </div>
      </Section>

      <Section
        title="Export and import"
        hint="Export writes everything to a JSON file, and attached files to a folder beside it (name-attachments). Import replaces all current data with a file's content (and takes in that folder when it is there): a backup is taken first, and it cannot be undone."
      >
        <div className="flex flex-wrap items-center gap-2">
          <HeaderButton
            onClick={() =>
              void run(async () => {
                const path = await save({
                  title: "Export task-master data",
                  defaultPath: `task-master-${isoDate()}.json`,
                  filters: [{ name: "JSON", extensions: ["json"] }],
                });
                if (!path) return undefined;
                await settingsApi.exportTo(path);
                return `Exported to ${path}`;
              })
            }
          >
            Export…
          </HeaderButton>
          <HeaderButton
            onClick={() =>
              void run(async () => {
                const path = await open({
                  title: "Import task-master data",
                  filters: [{ name: "JSON", extensions: ["json"] }],
                });
                if (typeof path === "string") setConfirmImport(path);
                return undefined;
              })
            }
          >
            Import…
          </HeaderButton>
          {confirmImport && (
            <span className="flex items-center gap-2 text-xs" role="alert">
              Replace all data with {confirmImport}?
              <HeaderButton
                primary
                onClick={() =>
                  void run(async () => {
                    const path = confirmImport;
                    setConfirmImport(null);
                    const s = await settingsApi.importFrom(path);
                    const missing = s.missing_files
                      ? ` ${s.missing_files} attached file(s) were not found: copy the "-attachments" folder next to the export file and import again.`
                      : "";
                    return `Imported ${s.tasks} tasks, ${s.projects} projects, ${s.epics} epics, ${s.tags} tags, ${s.views} views and ${s.attachments} attachments.${missing}`;
                  })
                }
              >
                Replace everything
              </HeaderButton>
              <HeaderButton onClick={() => setConfirmImport(null)}>Cancel</HeaderButton>
            </span>
          )}
        </div>
      </Section>

      {config && <RemoteBackupForm config={config} onSaved={setConfig} />}

      {note && (
        <p
          role="status"
          className={cx(
            "py-2 text-sm",
            note.error ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-400",
          )}
        >
          {note.text}
        </p>
      )}
    </>
  );
}

function RemoteBackupForm({
  config,
  onSaved,
}: {
  config: ConfigView;
  onSaved(config: ConfigView): void;
}) {
  const r = config.remote;
  const [form, setForm] = useState<RemoteInput>({
    enabled: r?.enabled ?? false,
    endpoint: r?.endpoint ?? "https://s3.solarnexus.space",
    bucket: r?.bucket ?? "task-master",
    region: r?.region ?? "garage",
    access_key: r?.access_key ?? "",
    secret_key: "",
    prefix: r?.prefix ?? "backups",
  });
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const field = (key: keyof RemoteInput, label: string, type = "text") => (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-24 text-neutral-500">{label}</span>
      <input
        type={type}
        value={String(form[key])}
        placeholder={key === "secret_key" && r?.has_secret ? "stored (leave empty to keep)" : ""}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="w-80 rounded border border-neutral-300 bg-transparent px-1.5 py-0.5 dark:border-neutral-700"
      />
    </label>
  );
  return (
    <Section
      title="Remote backup"
      hint="Uploads each daily backup to an S3-compatible bucket (Garage in the homelab) whenever it is reachable; off the network, it retries later. One-way: restore by importing or by copying a backup back."
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        Upload backups
      </label>
      {field("endpoint", "Endpoint")}
      {field("bucket", "Bucket")}
      {field("region", "Region")}
      {field("prefix", "Prefix")}
      {field("access_key", "Access key")}
      {field("secret_key", "Secret key", "password")}
      <div className="flex gap-2">
        <HeaderButton
          onClick={() =>
            settingsApi.testRemoteBackup(form).then(
              () => setNote({ text: "Connection works: a probe object was written." }),
              (e) => setNote({ text: message(e), error: true }),
            )
          }
        >
          Test connection
        </HeaderButton>
        <HeaderButton
          primary
          onClick={() =>
            settingsApi.setRemoteBackup(form).then(
              (c) => {
                onSaved(c);
                setForm({ ...form, secret_key: "" });
                setNote({ text: "Saved." });
              },
              (e) => setNote({ text: message(e), error: true }),
            )
          }
        >
          Save
        </HeaderButton>
      </div>
      {note && (
        <p
          role="status"
          className={cx(
            "text-xs",
            note.error ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-400",
          )}
        >
          {note.text}
        </p>
      )}
    </Section>
  );
}

function Shortcuts() {
  // Opened from the shortcuts overlay ("Change shortcuts"): bring the section into view.
  const hash = useRouterState({ select: (r) => r.location.hash });
  useEffect(() => {
    if (hash === "shortcuts") document.getElementById("shortcuts")?.scrollIntoView();
  }, [hash]);
  return (
    <Section
      id="shortcuts"
      title="Keyboard shortcuts"
      hint="Add a key combination to an action, or two keys in a row (G, then I). A combination used elsewhere moves here. Press ? anywhere to see them all."
    >
      <ShortcutSettings />
    </Section>
  );
}

export function SettingsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="px-10 pt-7 pb-2">
        <h1 className="font-display text-[34px] leading-tight tracking-wide">Settings</h1>
      </header>
      <div className="max-w-3xl px-10 pb-10">
        <About />
        <Workflow />
        <Appearance />
        <AddingTasks />
        <Shortcuts />
        <SyncSettings />
        <CalendarSettings />
        <AgentSettings />
        <Data />
      </div>
    </div>
  );
}
