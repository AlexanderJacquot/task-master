// Settings → MCP: the lines that add this computer's `task-master-mcp` to the user's own
// Claude (docs/mcp.md), built from the binary's path the app found.

import type { McpSetup } from "../../lib/types";

/** Where the user adds the server. */
export type McpClient = "code" | "wsl" | "desktop" | "remote";

export const MCP_CLIENT_LABELS: Record<McpClient, string> = {
  code: "Claude Code",
  wsl: "Claude Code in WSL",
  desktop: "Claude Desktop",
  remote: "claude.ai and the mobile apps",
};

/** The clients that can use this computer's server, in the order the page offers them. */
export function mcpClients(setup: McpSetup): McpClient[] {
  const clients: McpClient[] = ["code"];
  if (setup.wsl_server) clients.push("wsl");
  if (setup.os !== "linux") clients.push("desktop");
  clients.push("remote");
  return clients;
}

/** A path as one shell word: single quotes for POSIX shells, double quotes on Windows. */
export function shellWord(path: string, windows: boolean): string {
  if (/^[\w/.:\\-]+$/.test(path)) return path;
  if (windows) return `"${path}"`;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The arguments the server gets: none, unless Claude may not edit the user's tasks. */
function serverArgs(editUserTasks: boolean): string[] {
  return editUserTasks ? [] : ["--no-edit-user-tasks"];
}

/** `claude mcp add` for this server; `windows` quotes for PowerShell/cmd. */
export function claudeCodeCommand(opts: {
  server: string;
  windows: boolean;
  everyProject: boolean;
  editUserTasks: boolean;
}): string {
  const scope = opts.everyProject ? " --scope user" : "";
  const args = serverArgs(opts.editUserTasks)
    .map((a) => ` ${a}`)
    .join("");
  return `claude mcp add${scope} task-master -- ${shellWord(opts.server, opts.windows)}${args}`;
}

/** The whole `claude_desktop_config.json` for a file that has no other servers yet. */
export function claudeDesktopConfig(server: string, editUserTasks: boolean): string {
  const args = serverArgs(editUserTasks);
  const entry = args.length > 0 ? { command: server, args } : { command: server };
  return JSON.stringify({ mcpServers: { "task-master": entry } }, null, 2);
}

/** Where Claude Desktop keeps its config ("Edit Config" opens it). */
export function claudeDesktopConfigPath(os: McpSetup["os"]): string {
  return os === "windows"
    ? "%APPDATA%\\Claude\\claude_desktop_config.json"
    : "~/Library/Application Support/Claude/claude_desktop_config.json";
}

/** For `~/.claude/settings.json`: calls to the server without asking each time. */
export const CLAUDE_CODE_ALLOW = `"permissions": { "allow": ["mcp__task-master"] }`;

/** The sync server's remote MCP endpoint (ADR 024), from the address Sync saved. */
export function remoteMcpUrl(syncUrl: string): string {
  return `${syncUrl.trim().replace(/\/+$/, "")}/mcp`;
}
