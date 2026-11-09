// Settings → Sync (M13, ADR 015): connect to a task-master server, sign in or paste a
// token when it asks for one, choose how this device starts, then see the sync status.
// Setup of the server itself: docs/server.md.

import { useEffect, useRef, useState } from "react";
import { Button, cx, INPUT, Select } from "../../components/ui";
import { formatAgo } from "../../lib/dates";
import { settingsApi } from "../../lib/settingsApi";
import type { ConfigView, JoinMode, SyncStatus } from "../../lib/types";
import { useApi } from "../../store/context";
import { frequencyOptions, Section } from "./SettingsPage";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const AUTH_LABEL = {
  none: "no sign-in",
  token: "token",
  oidc: "sign-in",
} as const;

const SYNC_MINUTES = [0, 1, 5, 15, 30, 60];

function SyncFrequency() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    settingsApi.getConfig().then(
      (c) => live && setConfig(c),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  if (!config) return null;
  return (
    <Section
      title="Sync frequency"
      hint="How often this device syncs with the server. Sync also runs shortly after each edit, when the server announces changes and when the window gets focus."
    >
      <Select
        aria-label="Sync frequency"
        value={String(config.schedule.sync_minutes)}
        onValueChange={(v) =>
          settingsApi
            .setSchedule({ ...config.schedule, sync_minutes: Number(v) })
            .then(setConfig, (e) => setError(message(e)))
        }
        className="w-40"
        options={frequencyOptions(SYNC_MINUTES, config.schedule.sync_minutes)}
      />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </Section>
  );
}

export function SyncSettings() {
  const api = useApi().sync;
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the latest run reports: starting a sign-in over replaces the waiting one.
  const latestRun = useRef(0);

  useEffect(() => {
    if (!api) return;
    let live = true;
    api.status().then(
      (s) => live && setStatus(s),
      (e) => live && setError(message(e)),
    );
    const off = api.onChanged((s) => live && setStatus(s));
    return () => {
      live = false;
      void off.then((stop) => stop());
    };
  }, [api]);

  if (!api) return null;

  const run = async (label: string, work: () => Promise<SyncStatus>) => {
    const id = ++latestRun.current;
    const current = () => id === latestRun.current;
    setError(null);
    setBusy(label);
    try {
      const next = await work();
      if (current()) setStatus(next);
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      if (current()) setBusy(null);
    }
  };
  const signIn = () => void run("sign-in", () => api.signIn());

  const join = (mode: JoinMode) => {
    setConfirmReplace(false);
    void run("join", () => api.join(mode));
  };

  const needsCredentials = status?.configured && status.auth !== "none" && !status.signed_in;

  return (
    <>
      <Section
        title="Sync"
        hint="Keep this device in sync with your task-master server. Edits stay instant and work offline; they reach the server a moment later. When two devices change the same thing, the latest edit wins."
      >
        {!status?.configured ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run("connect", () => api.connect(url));
            }}
          >
            <label className="flex items-center gap-2 text-xs">
              <span className="w-24 text-ink-3">Server address</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://tasks.example.org"
                className={cx(INPUT, "w-80 py-1 text-[13px]")}
              />
            </label>
            <Button size="sm" variant="primary" type="submit" disabled={!url.trim() || !!busy}>
              Connect
            </Button>
          </form>
        ) : (
          <>
            <p className="text-sm text-ink-2">
              Server <span className="text-ink">{status.url}</span>
              {status.auth && <span className="text-ink-3"> ({AUTH_LABEL[status.auth]})</span>}
              {status.device_name && (
                <span className="text-ink-3"> · this device: {status.device_name}</span>
              )}
            </p>

            {needsCredentials && (
              <>
                {status.auth === "oidc" && (
                  <div className="flex items-center gap-3">
                    <Button size="sm" variant="primary" disabled={!!busy} onClick={signIn}>
                      Sign in
                    </Button>
                    {busy === "sign-in" && (
                      <>
                        <span role="status" className="text-xs text-ink-3">
                          Finish signing in in your browser…
                        </span>
                        <Button size="sm" variant="ghost" onClick={signIn}>
                          Start over
                        </Button>
                      </>
                    )}
                  </div>
                )}
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run("token", () => api.setToken(token)).then(() => setToken(""));
                  }}
                >
                  <label className="flex items-center gap-2 text-xs">
                    <span className="w-24 text-ink-3">
                      {status.auth === "oidc" ? "Or a token" : "Token"}
                    </span>
                    <input
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="tm_…"
                      className={cx(INPUT, "w-80 py-1 text-[13px]")}
                    />
                  </label>
                  <Button size="sm" type="submit" disabled={!token.trim() || !!busy}>
                    Save token
                  </Button>
                </form>
                <p className="text-xs text-ink-3">
                  Make one on the server with <code>task-master-server token add &lt;name&gt;</code>
                  .
                </p>
              </>
            )}

            {!needsCredentials && !status.joined && (
              <div className="flex flex-col gap-2">
                {status.server_empty ? (
                  <>
                    <p className="text-sm text-ink-2">
                      The server is empty. This device's tasks will be its first copy.
                    </p>
                    <div>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!!busy}
                        onClick={() => join("merge")}
                      >
                        Upload this device's tasks
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-ink-2">
                      The server already has tasks. How should this device start?
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!!busy}
                        onClick={() => join("merge")}
                      >
                        Merge: keep this device's tasks too
                      </Button>
                      <Button size="sm" disabled={!!busy} onClick={() => setConfirmReplace(true)}>
                        Replace with the server's tasks
                      </Button>
                    </div>
                    {confirmReplace && (
                      <div
                        role="alertdialog"
                        aria-label="Replace this device's tasks"
                        className="flex flex-wrap items-center gap-2 text-sm"
                      >
                        <span className="text-ink-2">
                          This device's tasks are backed up, then replaced by the server's.
                        </span>
                        <Button
                          size="sm"
                          className="border-danger text-danger"
                          onClick={() => join("replace")}
                        >
                          Replace
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmReplace(false)}>
                          Cancel
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {status.joined && (
              <>
                <p className="text-sm text-ink-2" role="status">
                  {status.syncing
                    ? "Syncing…"
                    : status.last_sync_at
                      ? `Synced ${formatAgo(status.last_sync_at)}.`
                      : "The first sync starts in a few seconds."}
                  {!status.syncing && status.last_sync_at && (
                    <span className="text-ink-3">
                      {" "}
                      ({status.last_pushed} sent, {status.last_pulled} received)
                    </span>
                  )}
                  {status.pending > 0 && !status.syncing && (
                    <span className="text-ink-3">
                      {" "}
                      {status.pending >= 1000 ? "1000+" : status.pending} change
                      {status.pending === 1 ? "" : "s"} waiting to be sent.
                    </span>
                  )}
                </p>
                {status.last_error && (
                  <p role="alert" className="text-sm text-danger">
                    Last sync failed: {status.last_error}
                  </p>
                )}
                {status.clock_warning && (
                  <p className="text-sm text-high">
                    This computer's clock is off by{" "}
                    {Math.round(Math.abs(status.clock_offset_ms) / 1000)} seconds. Sync corrects for
                    it, but set the clock to update automatically.
                  </p>
                )}
              </>
            )}

            <div className="flex gap-2">
              {status.joined && (
                <Button size="sm" onClick={() => void run("sync", () => api.syncNow())}>
                  Sync now
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => void run("disconnect", () => api.disconnect())}
              >
                {status.joined ? "Disconnect" : "Use another server"}
              </Button>
            </div>
          </>
        )}
        {busy === "connect" && (
          <p role="status" className="text-xs text-ink-3">
            Contacting the server…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </Section>
      <SyncFrequency />
    </>
  );
}
