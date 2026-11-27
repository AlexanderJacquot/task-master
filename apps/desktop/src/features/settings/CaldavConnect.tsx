// Settings → Calendar → CalDAV (ADR 037): iCloud, Fastmail, Nextcloud or any CalDAV server,
// with a user name and an app password (kept in the OS keychain by the shell).

import { useState } from "react";
import { Button, cx, INPUT } from "../../components/ui";

type Preset = "icloud" | "fastmail" | "nextcloud" | "other";

type PresetInfo = {
  label: string;
  url: string;
  user: string;
  help: { text: string; link?: string };
};

const ORDER: Preset[] = ["icloud", "fastmail", "nextcloud", "other"];

const PRESETS: Record<Preset, PresetInfo> = {
  icloud: {
    label: "iCloud",
    url: "https://caldav.icloud.com",
    user: "Apple ID (name@icloud.com)",
    help: {
      text: "At appleid.apple.com, open Sign-In and Security → App-Specific Passwords and create one for task-master. Your Apple ID password does not work here.",
      link: "https://appleid.apple.com",
    },
  },
  fastmail: {
    label: "Fastmail",
    url: "https://caldav.fastmail.com",
    user: "Fastmail address",
    help: {
      text: "In Fastmail, open Settings → Privacy & Security and create an app password with access to Calendars (CalDAV).",
    },
  },
  nextcloud: {
    label: "Nextcloud",
    url: "",
    user: "Nextcloud user name",
    help: {
      text: "Enter https://<your server>/remote.php/dav. In Nextcloud, open Personal settings → Security and create an app password.",
    },
  },
  other: {
    label: "Other",
    url: "",
    user: "User name",
    help: {
      text: "Enter your CalDAV server's address; it is found from there (/.well-known/caldav).",
    },
  },
};

/** A readable name for a connected server. */
export function caldavName(serverUrl: string): string {
  const host = (() => {
    try {
      return new URL(serverUrl).host;
    } catch {
      return serverUrl;
    }
  })();
  if (host.endsWith("icloud.com")) return "iCloud";
  if (host.endsWith("fastmail.com")) return "Fastmail";
  return host;
}

export function CaldavConnect({
  busy,
  connect,
  openUrl,
}: {
  busy: boolean;
  connect: (serverUrl: string, username: string, password: string) => Promise<void>;
  openUrl?: (url: string) => void;
}) {
  const [preset, setPreset] = useState<Preset>("icloud");
  const [url, setUrl] = useState(PRESETS.icloud.url);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const current = PRESETS[preset];

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] text-ink-2">
        The way to your iPhone's calendar: blocks, day plans and due dates go to a{" "}
        <b>task-master</b> calendar in your account, and your other calendars can show here.
      </p>
      <fieldset className="flex items-center gap-2">
        <legend className="sr-only">Provider</legend>
        {ORDER.map((id) => ({ id, ...PRESETS[id] })).map((p) => (
          <label key={p.id} className="flex items-center gap-1 text-[13px] text-ink-2">
            <input
              type="radio"
              name="caldav-preset"
              checked={preset === p.id}
              onChange={() => {
                setPreset(p.id);
                setUrl(p.url);
              }}
              className="accent-accent"
            />
            {p.label}
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-ink-3">
        {current.help.text}{" "}
        {current.help.link && openUrl && (
          <button
            type="button"
            className="text-accent underline"
            onClick={() => current.help.link && openUrl(current.help.link)}
          >
            Open
          </button>
        )}
      </p>
      <label className="flex items-center gap-2 text-xs">
        <span className="w-24 text-ink-3">Server</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://cloud.example.org/remote.php/dav"
          className={cx(INPUT, "w-96 py-1 text-[13px]")}
        />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <span className="w-24 text-ink-3">User name</span>
        <input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder={current.user}
          autoComplete="username"
          className={cx(INPUT, "w-96 py-1 text-[13px]")}
        />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <span className="w-24 text-ink-3">App password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="xxxx-xxxx-xxxx-xxxx"
          autoComplete="off"
          className={cx(INPUT, "w-96 py-1 text-[13px]")}
        />
      </label>
      <p className="text-xs text-ink-3">The password is kept in your system's keychain.</p>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !url.trim() || !user.trim() || !password}
          onClick={() => void connect(url, user, password).then(() => setPassword(""))}
        >
          Connect {preset === "other" ? "CalDAV" : current.label}
        </Button>
        {busy && (
          <span role="status" className="text-xs text-ink-3">
            Finding your calendars…
          </span>
        )}
      </div>
    </div>
  );
}
