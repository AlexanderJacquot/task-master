// The Windows release's `tauriScript` (release.yml, ADR 036). The release builds the app,
// has SignPath sign it, bundles the installers, has them signed and signs the update files
// in earlier steps, so tauri-action must not build again: it runs `<tauriScript> build
// <args>`, then uploads the installers it finds and writes their entries in latest.json.
// This stands in for that build and only checks that those files are there.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const conf = JSON.parse(readFileSync(join(desktop, "src-tauri", "tauri.conf.json"), "utf8"));
const { productName: name, version } = conf;
const bundle = join(desktop, "..", "..", "target", "release", "bundle");
const files = [
  join(bundle, "nsis", `${name}_${version}_x64-setup.exe`),
  join(bundle, "msi", `${name}_${version}_x64_en-US.msi`),
].flatMap((installer) => [installer, `${installer}.sig`]);

const missing = files.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`windows-prebuilt: missing ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`windows-prebuilt: ${files.length} files ready for tauri-action`);
