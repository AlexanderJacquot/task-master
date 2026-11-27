// Builds the task-master MCP server (crates/mcp, ADR 017) and puts it where Tauri's
// `externalBin` expects it: src-tauri/binaries/task-master-mcp-<target triple>[.exe].
// The bundler then installs it next to the app's executable as `task-master-mcp`.
//
// Runs as the beforeBuildCommand of src-tauri/tauri.sidecar.conf.json, where the Tauri CLI
// sets TAURI_ENV_TARGET_TRIPLE (also for `--target` cross builds) and TAURI_ENV_DEBUG.
// By hand: `node scripts/sidecar.mjs [--target <triple>] [--debug]`.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = join(desktop, "..", "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const target =
  flag("--target") ||
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  /^host: (.+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
if (!target) throw new Error("cannot tell the target triple (rustc -vV has no host line)");
const debug = args.includes("--debug") || process.env.TAURI_ENV_DEBUG === "true";
const exe = target.includes("windows") ? ".exe" : "";

const cargo = ["build", "--locked", "-p", "taskmaster-mcp", "--target", target];
if (!debug) cargo.push("--release");
console.log(`sidecar: cargo ${cargo.join(" ")}`);
execFileSync("cargo", cargo, { cwd: workspace, stdio: "inherit" });

const built = join(
  workspace,
  "target",
  target,
  debug ? "debug" : "release",
  `task-master-mcp${exe}`,
);
const dest = join(desktop, "src-tauri", "binaries", `task-master-mcp-${target}${exe}`);
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(built, dest);
console.log(`sidecar: ${dest}`);
