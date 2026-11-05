import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
const source = "src/assets/brand/app-icon.svg";
function generate(args) {
  const result = spawnSync("pnpm", ["tauri", "icon", source, ...args], {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
generate(["-o", "src-tauri/icons"]);
const temporary = mkdtempSync(join(tmpdir(), "task-master-icons-"));
generate(["-o", temporary, "-p", "1024"]);
copyFileSync(join(temporary, "1024x1024.png"), join(cwd, "src-tauri/app-icon.png"));
