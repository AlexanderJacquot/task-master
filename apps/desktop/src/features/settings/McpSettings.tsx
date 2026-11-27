// Settings → MCP: how to add this computer's task-master MCP server to the Claude the user
// runs every day (docs/mcp.md), with the lines filled in for this OS and this install.

import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Checkbox, IconButton, Select } from "../../components/ui";
import type { McpSetup } from "../../lib/types";
import { useApi } from "../../store/context";
import {
  CLAUDE_CODE_ALLOW,
  claudeCodeCommand,
  claudeDesktopConfig,
  claudeDesktopConfigPath,
  MCP_CLIENT_LABELS,
  type McpClient,
  mcpClients,
  remoteMcpUrl,
} from "./mcpSetup";
import { Section } from "./SettingsPage";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function McpSettings() {
  const api = useApi();
  const agents = api.agents;
  const [setup, setSetup] = useState<McpSetup | null>(null);
  const [syncUrl, setSyncUrl] = useState<string | null>(null);
  const [client, setClient] = useState<McpClient>("code");
  const [everyProject, setEveryProject] = useState(true);
  const [editUserTasks, setEditUserTasks] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agents) return;
    let live = true;
    agents.mcpSetup().then(
      (s) => live && setSetup(s),
      (e) => live && setError(message(e)),
    );
    // Start from what Settings → Agents says: the same switch, and WSL when agents run there.
    agents.settings().then(
      (s) => {
        if (!live) return;
        setEditUserTasks(s.edit_user_tasks);
        if (s.runtime === "wsl") setClient((c) => (c === "code" ? "wsl" : c));
      },
      () => undefined,
    );
    api.sync?.status().then(
      (s) => live && setSyncUrl(s.configured && s.url ? s.url : null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [agents, api.sync]);

  if (!agents) return null;
  const clients = setup ? mcpClients(setup) : [];
  const shown = clients.includes(client) ? client : "code";
  const server = shown === "wsl" ? setup?.wsl_server : setup?.server;

  return (
    <Section
      id="mcp"
      title="MCP"
      hint="Add task-master's tools to the Claude you use every day, so any conversation can read your tasks, plan your week or file a task. Send to agent already gives them to its own sessions."
    >
      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      {setup && (
        <>
          <Row label="Server">
            {setup.server ? (
              <Copyable text={setup.server} label="Copy the server's path" />
            ) : (
              <span role="alert" className="text-xs text-red-700 dark:text-red-300">
                {setup.problem ?? "The MCP server was not found."}
              </span>
            )}
          </Row>
          {setup.appimage && (
            <p className="pl-28 text-xs text-ink-3">
              An AppImage mounts this path only while the app runs. For a lasting one, install a
              package (AUR, .deb, .rpm: <code>/usr/bin/task-master-mcp</code>) or build it with{" "}
              <code>cargo build --release -p taskmaster-mcp</code>.
            </p>
          )}
          <Row label="Add it to">
            <Select<McpClient>
              value={shown}
              onValueChange={setClient}
              aria-label="Add it to"
              className="w-64"
              options={clients.map((c) => ({ value: c, label: MCP_CLIENT_LABELS[c] }))}
            />
          </Row>
          {shown !== "remote" && (
            <Row label="">
              <Checkbox
                checked={editUserTasks}
                onChange={() => setEditUserTasks(!editUserTasks)}
                label="Let Claude edit my tasks"
              />
              <span className="text-xs text-ink-3">
                Let Claude edit my tasks (off: it reads everything and only changes its own agent
                tasks)
              </span>
            </Row>
          )}
          {(shown === "code" || shown === "wsl") && server && (
            <ClaudeCodeSteps
              server={server}
              windows={setup.os === "windows" && shown === "code"}
              everyProject={everyProject}
              onEveryProject={() => setEveryProject(!everyProject)}
              editUserTasks={editUserTasks}
            />
          )}
          {shown === "desktop" && setup.server && (
            <Steps>
              <li>
                In Claude Desktop, open Settings → Developer → <b>Edit Config</b>. It opens{" "}
                <code>{claudeDesktopConfigPath(setup.os)}</code>.
              </li>
              <li>
                Put this in it. If the file already has <code>mcpServers</code>, add only the{" "}
                <code>"task-master"</code> entry to them.
                <CodeBlock
                  text={claudeDesktopConfig(setup.server, editUserTasks)}
                  label="Copy the config"
                />
              </li>
              <li>Quit and reopen Claude Desktop. task-master shows under the tools menu.</li>
            </Steps>
          )}
          {shown === "remote" && <RemoteSteps syncUrl={syncUrl} />}
        </>
      )}
    </Section>
  );
}

function ClaudeCodeSteps({
  server,
  windows,
  everyProject,
  onEveryProject,
  editUserTasks,
}: {
  server: string;
  windows: boolean;
  everyProject: boolean;
  onEveryProject: () => void;
  editUserTasks: boolean;
}) {
  return (
    <>
      <Row label="">
        <Checkbox checked={everyProject} onChange={onEveryProject} label="In every project" />
        <span className="text-xs text-ink-3">
          In every project (off: only in the folder where you run the command)
        </span>
      </Row>
      <Steps>
        <li>
          Run this in a terminal:
          <CodeBlock
            text={claudeCodeCommand({ server, windows, everyProject, editUserTasks })}
            label="Copy the command"
          />
        </li>
        <li>
          Check it with <code>claude mcp list</code>, or <code>/mcp</code> inside Claude Code.
        </li>
        <li>
          Optional: to skip the approval prompt on each call, add this to{" "}
          <code>~/.claude/settings.json</code>:
          <CodeBlock text={CLAUDE_CODE_ALLOW} label="Copy the permission" />
        </li>
      </Steps>
    </>
  );
}

function RemoteSteps({ syncUrl }: { syncUrl: string | null }) {
  if (!syncUrl) {
    return (
      <p className="pl-28 text-xs text-ink-3">
        claude.ai and the mobile apps cannot start a program on this computer: they reach your sync
        server instead. Set up Sync first, then come back here.
      </p>
    );
  }
  return (
    <Steps>
      <li>
        The sync server must run with <code>TM_MCP=on</code> and sign-in through your identity
        provider (<code>TM_AUTH=oidc</code>), with an OAuth client for Claude (docs/mcp.md, section
        5).
      </li>
      <li>
        On claude.ai: Settings → Connectors → <b>Add custom connector</b>, with this URL:
        <CodeBlock text={remoteMcpUrl(syncUrl)} label="Copy the URL" />
      </li>
      <li>
        Under Advanced settings, use your own OAuth client: client ID{" "}
        <code>task-master-claude</code>, no secret. Connect and sign in. The mobile apps get the
        connector too.
      </li>
    </Steps>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-26 shrink-0 text-ink-3">{label}</span>
      {children}
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="ml-28 flex list-decimal flex-col gap-2.5 pl-4 text-xs text-ink-2 [&_code]:font-mono [&_code]:text-[12px]">
      {children}
    </ol>
  );
}

/** A line of text to copy, as is. */
function Copyable({ text, label }: { text: string; label: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className="font-mono text-[12.5px] break-all">{text}</code>
      <CopyButton text={text} label={label} />
    </span>
  );
}

/** A command or file content to copy. */
function CodeBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="mt-1.5 flex items-start gap-1 rounded-md border border-line bg-neutral-500/5 py-1.5 pr-1 pl-2.5">
      <pre className="min-w-0 flex-1 overflow-x-auto py-0.5 font-mono text-[12px] whitespace-pre-wrap break-all text-ink">
        {text}
      </pre>
      <CopyButton text={text} label={label} />
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <IconButton
      label={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => {},
        );
      }}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </IconButton>
  );
}
