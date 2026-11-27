// Writes a release's latest.json from the files already in that release (release.yml, ADR 009).
//
// Each build job's tauri-action reads latest.json, adds its own platforms and uploads it
// again. Jobs that finish close together overwrite each other: v0.31.0 shipped without
// `darwin-aarch64` and the Linux entries, so those installs could not update. The last job
// of the release workflow runs this to write the whole file again from the release's
// update bundles and their `.sig` files.
//
//   node apps/desktop/scripts/updater-json.mjs <tag> <output file>
//
// Reads the release through the GitHub API (GITHUB_TOKEN if set; GITHUB_REPOSITORY, else
// the public repository). Writes the file even when a platform is missing, then exits 1
// so the run shows it.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Platform keys the updater looks up, and the update file that serves each one. */
const PLATFORMS = [
  { pattern: /_aarch64\.app\.tar\.gz$/, keys: ["darwin-aarch64", "darwin-aarch64-app"] },
  { pattern: /_x64\.app\.tar\.gz$/, keys: ["darwin-x86_64", "darwin-x86_64-app"] },
  { pattern: /\.AppImage$/, keys: ["linux-x86_64", "linux-x86_64-appimage"] },
  { pattern: /\.deb$/, keys: ["linux-x86_64-deb"] },
  { pattern: /\.rpm$/, keys: ["linux-x86_64-rpm"] },
  // The NSIS setup is the default Windows entry (`updaterJsonPreferNsis`).
  { pattern: /-setup\.exe$/, keys: ["windows-x86_64", "windows-x86_64-nsis"] },
  { pattern: /\.msi$/, keys: ["windows-x86_64-msi"] },
];

/** One entry per OS the release must serve; a release without one of them is broken. */
export const REQUIRED = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"];

/**
 * The latest.json for a release. `release` is the GitHub API release object; `signatures`
 * maps an update file's name to the text of its `.sig` file. Update files without a
 * signature are left out: the updater would refuse them.
 */
export function updaterJson(release, signatures, pubDate) {
  const platforms = {};
  for (const { pattern, keys } of PLATFORMS) {
    const asset = release.assets.find((a) => pattern.test(a.name) && signatures.has(a.name));
    if (!asset) continue;
    for (const key of keys) {
      // The API URL, as tauri-action writes it: the updater asks for octet-stream.
      platforms[key] = { signature: signatures.get(asset.name).trim(), url: asset.url };
    }
  }
  return {
    version: release.tag_name.replace(/^v/, ""),
    notes: release.body ?? "",
    pub_date: pubDate,
    platforms,
  };
}

export function missingPlatforms(json) {
  return REQUIRED.filter((key) => !(key in json.platforms));
}

async function main([tag, output]) {
  if (!tag || !output) {
    console.error("usage: updater-json.mjs <tag> <output file>");
    process.exit(2);
  }
  const repo = process.env.GITHUB_REPOSITORY ?? "AlexanderJacquot/task-master";
  const headers = { "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const get = async (url, accept) => {
    const res = await fetch(url, { headers: { ...headers, Accept: accept } });
    if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
    return res;
  };

  const release = await (
    await get(
      `https://api.github.com/repos/${repo}/releases/tags/${tag}`,
      "application/vnd.github+json",
    )
  ).json();
  const signatures = new Map();
  for (const asset of release.assets.filter((a) => a.name.endsWith(".sig"))) {
    const text = await (await get(asset.url, "application/octet-stream")).text();
    signatures.set(asset.name.slice(0, -".sig".length), text);
  }

  const json = updaterJson(release, signatures, new Date().toISOString());
  writeFileSync(output, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`updater-json: ${tag}: ${Object.keys(json.platforms).join(", ")}`);

  const missing = missingPlatforms(json);
  if (missing.length > 0) {
    console.error(`updater-json: no signed update file for ${missing.join(", ")}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`updater-json: ${err.message}`);
    process.exit(1);
  });
}
