// Settings → Agents (ADR 017): how this device runs the agent for "Send to agent".

import { useEffect, useState } from "react";
import { Button, cx, INPUT, Select } from "../../components/ui";
import type { ClaudeCheck, AgentSettings as Settings } from "../../lib/types";
import { useApi, useStoreState } from "../../store/context";
import { PERMISSION_MODES } from "../agents/sessions";
import { dollarsText, parseDollars } from "../agents/usage";
import { Section } from "./SettingsPage";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isWindows = typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
const isLinux =
  typeof navigator !== "undefined" &&
  /linux/i.test(navigator.userAgent) &&
  !/android/i.test(navigator.userAgent);

export function AgentSettings() {
  const api = useApi().agents;
  const statuses = useStoreState((s) => s.statuses);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [distros, setDistros] = useState<string[]>([]);
  const [check, setCheck] = useState<ClaudeCheck | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let live = true;
    api.settings().then(
      (s) => {
        if (!live) return;
        setSaved(s);
        setDraft(s);
      },
      (e) => live && setError(message(e)),
    );
    void api.distros().then(
      (d) => live && setDistros(d),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  if (!api || !draft) return null;
  const statusOptions = (fallback: string) => [
    { value: "", label: `Default (${fallback})` },
    ...statuses.map((s) => ({ value: s.id, label: s.name })),
  ];
  const edit = (patch: Partial<Settings>) => {
    setDraft({ ...draft, ...patch });
    setCheck(null);
    setNotice(null);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run("save", async () => {
      const next = await api.saveSettings(draft);
      setSaved(next);
      setDraft(next);
      setNotice("Saved.");
    });
  const detect = () =>
    run("detect", async () => {
      setCheck(null);
      setCheck(await api.detect(draft));
    });

  return (
    <Section
      id="agents"
      title="Agents"
      hint="Send to agent runs an agent in the background on this device, in the task's folder, with the task's context and task-master's tools to report its progress."
    >
      <Row label="Runs">
        <Select
          value={draft.runtime}
          onValueChange={(runtime) => edit({ runtime })}
          aria-label="Runtime"
          className="w-64"
          options={[
            { value: "native", label: isWindows ? "On Windows" : "On this computer" },
            { value: "wsl", label: "In WSL (Windows only)" },
          ]}
        />
      </Row>
      {draft.runtime === "wsl" && (
        <Row label="Distribution">
          {distros.length > 0 ? (
            <Select
              value={draft.wsl_distro ?? ""}
              onValueChange={(d) => edit({ wsl_distro: d || null })}
              aria-label="WSL distribution"
              className="w-64"
              options={[
                { value: "", label: "Default" },
                ...distros.map((d) => ({ value: d, label: d })),
              ]}
            />
          ) : (
            <input
              value={draft.wsl_distro ?? ""}
              onChange={(e) => edit({ wsl_distro: e.target.value || null })}
              placeholder="Default"
              aria-label="WSL distribution"
              className={cx(INPUT, "w-64 py-1 text-[13px]")}
            />
          )}
        </Row>
      )}
      <Row label="Agent command">
        <input
          value={draft.claude_path}
          onChange={(e) => edit({ claude_path: e.target.value })}
          aria-label="Agent command"
          className={cx(INPUT, "w-80 py-1 font-mono text-[12.5px]")}
        />
        <Button size="sm" disabled={!!busy} onClick={() => void detect()}>
          {busy === "detect" ? "Checking…" : "Check"}
        </Button>
      </Row>
      {check && (
        <p role="status" className="pl-28 text-xs text-ink-2">
          Found {check.version}
          {check.path !== draft.claude_path && (
            <>
              {" "}
              at <code className="text-ink">{check.path}</code>{" "}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => setDraft({ ...draft, claude_path: check.path })}
              >
                Use this path
              </button>
            </>
          )}
        </p>
      )}
      <Row label="Agent may">
        <Select
          value={draft.permission_mode}
          onValueChange={(permission_mode) => edit({ permission_mode })}
          aria-label="Default permissions"
          className="w-64"
          options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label }))}
        />
      </Row>
      <Row label="Model">
        <input
          value={draft.model ?? ""}
          onChange={(e) => edit({ model: e.target.value || null })}
          placeholder="The agent's default"
          aria-label="Model"
          className={cx(INPUT, "w-64 py-1 text-[13px]")}
        />
      </Row>
      <Row label="When sent">
        <Select
          value={draft.started_status_id ?? ""}
          onValueChange={(id) => edit({ started_status_id: id || null })}
          aria-label="Status when sent to an agent"
          className="w-64"
          options={statusOptions("In progress")}
        />
      </Row>
      <Row label="When done">
        <Select
          value={draft.done_status_id ?? ""}
          onValueChange={(id) => edit({ done_status_id: id || null })}
          aria-label="Status when the agent is done"
          className="w-64"
          options={statusOptions("Review")}
        />
      </Row>
      <p className="pl-28 text-xs text-ink-3">
        The app moves the task itself: to the first status when it is sent to an agent, to the
        second when the agent reports it done (a task you closed stays closed).
      </p>
      <div className="flex items-start gap-2 text-xs">
        <span className="w-26 shrink-0 pt-1.5 text-ink-3">Directive</span>
        <textarea
          value={draft.directive ?? ""}
          onChange={(e) => edit({ directive: e.target.value || null })}
          placeholder="Standing instructions for every agent, e.g. “Commit on a new branch, never on main.”"
          aria-label="Directive for every agent"
          rows={4}
          className={cx(INPUT, "w-[28rem] resize-y py-1 text-[13px]")}
        />
      </div>
      <p className="pl-28 text-xs text-ink-3">
        Added to the system prompt of every agent you start from now on, after the app's own rules.
        A running session keeps the directive it started with.
      </p>
      <Row label="Spend limits">
        {(["day", "week", "month"] as const).map((period) => (
          <LimitInput
            key={period}
            label={`per ${period}`}
            micros={draft.limits[LIMIT_KEY[period]]}
            onChange={(micros) =>
              edit({ limits: { ...draft.limits, [LIMIT_KEY[period]]: micros } })
            }
          />
        ))}
      </Row>
      <p className="pl-28 text-xs text-ink-3">
        In dollars, over every device's sessions; blank for no limit. The Agents page shows what is
        left, and Send to agent asks before starting once one is spent.
      </p>
      {isLinux && (
        <Row label="Terminal">
          <input
            value={draft.terminal ?? ""}
            onChange={(e) => edit({ terminal: e.target.value || null })}
            placeholder="$TERMINAL, else the first one found (kitty, konsole, …)"
            aria-label="Terminal command"
            className={cx(INPUT, "w-80 py-1 font-mono text-[12.5px]")}
          />
        </Row>
      )}
      <div className="flex items-center gap-3 pl-28">
        <Button size="sm" variant="primary" disabled={!dirty || !!busy} onClick={() => void save()}>
          Save
        </Button>
        {notice && <span className="text-xs text-ink-3">{notice}</span>}
        {error && (
          <span role="alert" className="text-xs text-red-700 dark:text-red-300">
            {error}
          </span>
        )}
      </div>
    </Section>
  );
}

const LIMIT_KEY = {
  day: "day_usd_micros",
  week: "week_usd_micros",
  month: "month_usd_micros",
} as const;

/** A dollar amount; keeps what is typed (e.g. `12.`) while the saved value is in micros. */
function LimitInput({
  label,
  micros,
  onChange,
}: {
  label: string;
  micros: number | null;
  onChange(micros: number | null): void;
}) {
  const [text, setText] = useState(() => dollarsText(micros));
  // Follow outside changes (load, save) without fighting the field while typing.
  useEffect(() => {
    setText((t) => (parseDollars(t) === micros ? t : dollarsText(micros)));
  }, [micros]);
  return (
    <span className="flex items-center gap-1 text-ink-3">
      $
      <input
        value={text}
        inputMode="decimal"
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseDollars(e.target.value));
        }}
        placeholder="none"
        aria-label={`Spend limit ${label}`}
        className={cx(INPUT, "w-20 py-1 text-[13px] tabular-nums")}
      />
      <span className="mr-2">{label}</span>
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-26 shrink-0 text-ink-3">{label}</span>
      {children}
    </div>
  );
}
