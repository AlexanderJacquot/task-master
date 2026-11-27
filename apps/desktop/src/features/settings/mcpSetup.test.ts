import { expect, it } from "vitest";
import {
  claudeCodeCommand,
  claudeDesktopConfig,
  claudeDesktopConfigPath,
  mcpClients,
  remoteMcpUrl,
  shellWord,
} from "./mcpSetup";

const MAC = "/Applications/Task Master.app/Contents/MacOS/task-master-mcp";
const WINDOWS = "C:\\Users\\alex\\AppData\\Local\\task-master\\task-master-mcp.exe";

it("offers the clients this computer's server can serve", () => {
  const base = { server: "/x", appimage: false, problem: null };
  expect(mcpClients({ ...base, os: "linux", wsl_server: null })).toEqual(["code", "remote"]);
  expect(mcpClients({ ...base, os: "mac", wsl_server: null })).toEqual([
    "code",
    "desktop",
    "remote",
  ]);
  expect(mcpClients({ ...base, os: "windows", wsl_server: "/mnt/c/x" })).toEqual([
    "code",
    "wsl",
    "desktop",
    "remote",
  ]);
});

it("quotes a path only when the shell needs it", () => {
  expect(shellWord("/usr/bin/task-master-mcp", false)).toBe("/usr/bin/task-master-mcp");
  expect(shellWord(WINDOWS, true)).toBe(WINDOWS);
  expect(shellWord(MAC, false)).toBe(`'${MAC}'`);
  expect(shellWord("/home/o'neil/tm", false)).toBe(`'/home/o'\\''neil/tm'`);
  expect(shellWord("C:\\Users\\Jo Doe\\tm.exe", true)).toBe(`"C:\\Users\\Jo Doe\\tm.exe"`);
});

it("builds the claude mcp add line with the scope and the editing switch", () => {
  expect(
    claudeCodeCommand({ server: MAC, windows: false, everyProject: true, editUserTasks: true }),
  ).toBe(`claude mcp add --scope user task-master -- '${MAC}'`);
  expect(
    claudeCodeCommand({
      server: WINDOWS,
      windows: true,
      everyProject: false,
      editUserTasks: false,
    }),
  ).toBe(`claude mcp add task-master -- ${WINDOWS} --no-edit-user-tasks`);
});

it("writes Claude Desktop's config with the path escaped as JSON", () => {
  expect(JSON.parse(claudeDesktopConfig(WINDOWS, true))).toEqual({
    mcpServers: { "task-master": { command: WINDOWS } },
  });
  expect(claudeDesktopConfig(WINDOWS, true)).toContain(
    '"C:\\\\Users\\\\alex\\\\AppData\\\\Local\\\\task-master\\\\task-master-mcp.exe"',
  );
  expect(JSON.parse(claudeDesktopConfig(MAC, false))).toEqual({
    mcpServers: { "task-master": { command: MAC, args: ["--no-edit-user-tasks"] } },
  });
  expect(claudeDesktopConfigPath("mac")).toContain("Application Support/Claude");
  expect(claudeDesktopConfigPath("windows")).toBe("%APPDATA%\\Claude\\claude_desktop_config.json");
});

it("appends /mcp to the sync server's address", () => {
  expect(remoteMcpUrl("https://tasks.example.com/")).toBe("https://tasks.example.com/mcp");
  expect(remoteMcpUrl(" https://tasks.example.com ")).toBe("https://tasks.example.com/mcp");
});
