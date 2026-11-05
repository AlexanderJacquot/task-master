// Settings → Calendar (M10, ADR 014): connect a Google account with the user's own OAuth
// client, pick the calendars shown in the app, see the last sync.

import { useEffect, useState } from "react";
import { Button, cx, Dot, INPUT } from "../../components/ui";
import { formatAgo } from "../../lib/dates";
import type { CalendarStatus } from "../../lib/types";
import { useApi } from "../../store/context";
import { Section } from "./SettingsPage";

const CONSOLE = "https://console.cloud.google.com/apis/credentials";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function CalendarSettings() {
  const api = useApi().calendar;
  const files = useApi().files;
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let live = true;
    api.status().then(
      (s) => {
        if (!live) return;
        setStatus(s);
        setClientId((id) => id || s.client_id);
      },
      (e) => live && setError(message(e)),
    );
    const off = api.onSynced((s) => live && setStatus(s));
    return () => {
      live = false;
      void off.then((stop) => stop());
    };
  }, [api]);

  if (!api) return null;

  const run = async (work: () => Promise<CalendarStatus>) => {
    setError(null);
    try {
      setStatus(await work());
    } catch (e) {
      setError(message(e));
    }
  };

  const connect = async () => {
    setWaiting(true);
    await run(() => api.connect(clientId, secret));
    setSecret("");
    setWaiting(false);
  };

  return (
    <Section
      title="Calendar"
      hint="Two-way sync with Google Calendar: your time blocks and day plans go to a calendar named “task-master” in your account (moving or deleting them there comes back here), and the calendars you pick below show in the Calendar view, read-only."
    >
      {status?.connected ? (
        <>
          <p className="text-sm text-ink-2" role="status">
            {status.syncing
              ? "Syncing…"
              : status.last_sync_at
                ? `Connected. Last synced ${formatAgo(status.last_sync_at)}.`
                : "Connected. The first sync starts in a few seconds."}
            {status.last_report && !status.syncing && (
              <span className="text-ink-3">
                {" "}
                ({status.last_report.created} added, {status.last_report.updated} updated,{" "}
                {status.last_report.deleted} removed, {status.last_report.pulled} changes from
                Google)
              </span>
            )}
          </p>
          {status.last_error && (
            <p role="alert" className="text-sm text-danger">
              Last sync failed: {status.last_error}
            </p>
          )}
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-xs text-ink-3">Calendars</legend>
            {status.sources.map((source) =>
              source.target ? (
                <div key={source.id} className="flex items-center gap-2 text-sm">
                  <Dot color={source.color} />
                  <span className="text-ink">{source.name}</span>
                  <span className="text-xs text-ink-3">receives your blocks and day plans</span>
                </div>
              ) : (
                <label key={source.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={source.shown}
                    onChange={(e) => void run(() => api.setShown(source.id, e.target.checked))}
                    className="accent-accent"
                  />
                  <Dot color={source.color} />
                  <span className="text-ink">{source.name}</span>
                  {source.primary && <span className="text-xs text-ink-3">primary</span>}
                </label>
              ),
            )}
            {status.sources.length === 0 && (
              <p className="text-xs text-ink-3">Your calendars appear after the first sync.</p>
            )}
          </fieldset>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void run(() => api.syncNow())}>
              Sync now
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void run(() => api.disconnect())}>
              Disconnect
            </Button>
          </div>
        </>
      ) : (
        <>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13px] text-ink-2">
            <li>
              In the{" "}
              <button
                type="button"
                className="text-accent underline"
                onClick={() => void files?.openUrl(CONSOLE)}
              >
                Google Cloud console
              </button>
              , create a project, enable the <b>Google Calendar API</b>, and set up the OAuth
              consent screen (External, add yourself as a user).
            </li>
            <li>
              Set the consent screen's publishing status to <b>In production</b>, so the sign-in
              does not expire after 7 days. Google will say the app is unverified; that is fine for
              your own use.
            </li>
            <li>
              Create credentials: <b>OAuth client ID</b>, type <b>Desktop app</b>. Paste its client
              ID and secret here. All of this is free.
            </li>
          </ol>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-24 text-ink-3">Client ID</span>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="….apps.googleusercontent.com"
              className={cx(INPUT, "w-96 py-1 text-[13px]")}
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-24 text-ink-3">Client secret</span>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={status?.configured ? "stored (leave empty to keep)" : ""}
              className={cx(INPUT, "w-96 py-1 text-[13px]")}
            />
          </label>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="primary"
              disabled={waiting || !clientId.trim()}
              onClick={() => void connect()}
            >
              Connect Google Calendar
            </Button>
            {waiting && (
              <span role="status" className="text-xs text-ink-3">
                Finish signing in in your browser…
              </span>
            )}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </Section>
  );
}
