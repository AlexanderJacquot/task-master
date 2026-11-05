// Settings → Agents (ADR 017): how this device runs Claude Code for "Send to Claude".

import { useEffect, useState } from "react";
import { Button, cx, INPUT, Select } from "../../components/ui";
import type { ClaudeCheck, AgentSettings as Settings } from "../../lib/types";
import { useApi } from "../../store/context";
import { PERMISSION_MODES } from "../agents/sessions";
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
      hint="Send to Claude runs Claude Code in the background on this device, in the task's folder, with the task's context and task-master's tools to report its progress."
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
      <Row label="Claude Code">
        <input
          value={draft.claude_path}
          onChange={(e) => edit({ claude_path: e.target.value })}
          aria-label="Claude Code command"
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
      <Row label="Claude may">
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
          placeholder="Claude Code's default"
          aria-label="Model"
          className={cx(INPUT, "w-64 py-1 text-[13px]")}
        />
      </Row>
      {isLinux && (
        <Row label="Terminal">
          <input
            value={draft.terminal ?? ""}
            onChange={(e) => edit({ terminal: e.target.value || null })}
            placeholder="$TERMINAL -e, else x-terminal-emulator -e"
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-26 shrink-0 text-ink-3">{label}</span>
      {children}
    </div>
  );
}
