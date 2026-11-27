import { describe, expect, it } from "vitest";
import { missingPlatforms, updaterJson } from "./updater-json.mjs";

const NAMES = [
  "latest.json",
  "task-master-0.31.0-1.x86_64.rpm",
  "task-master_0.31.0_amd64.AppImage",
  "task-master_0.31.0_amd64.deb",
  "task-master_0.31.0_x64-setup.exe",
  "task-master_0.31.0_x64_en-US.msi",
  "Task.Master_0.31.0_aarch64.app.tar.gz",
  "Task.Master_0.31.0_aarch64.dmg",
  "Task.Master_0.31.0_x64.app.tar.gz",
  "Task.Master_0.31.0_x64.dmg",
];

const release = {
  tag_name: "v0.31.0",
  body: "Notes",
  assets: NAMES.map((name, i) => ({ name, url: `https://api.github.com/assets/${i}` })),
};

const signed = (names) => new Map(names.map((name) => [name, `sig of ${name}\n`]));
const UPDATE_FILES = NAMES.filter((n) => !n.endsWith(".dmg") && n !== "latest.json");

describe("updaterJson", () => {
  it("lists every platform from the release's signed update files", () => {
    const json = updaterJson(release, signed(UPDATE_FILES), "2026-11-25T14:00:00.000Z");
    expect(json.version).toBe("0.31.0");
    expect(json.notes).toBe("Notes");
    expect(json.pub_date).toBe("2026-11-25T14:00:00.000Z");
    expect(Object.keys(json.platforms).sort()).toEqual([
      "darwin-aarch64",
      "darwin-aarch64-app",
      "darwin-x86_64",
      "darwin-x86_64-app",
      "linux-x86_64",
      "linux-x86_64-appimage",
      "linux-x86_64-deb",
      "linux-x86_64-rpm",
      "windows-x86_64",
      "windows-x86_64-msi",
      "windows-x86_64-nsis",
    ]);
    expect(json.platforms["darwin-aarch64"]).toEqual({
      signature: "sig of Task.Master_0.31.0_aarch64.app.tar.gz",
      url: "https://api.github.com/assets/6",
    });
    expect(json.platforms["windows-x86_64"].url).toBe("https://api.github.com/assets/4");
    expect(json.platforms["linux-x86_64"].url).toBe("https://api.github.com/assets/2");
    expect(missingPlatforms(json)).toEqual([]);
  });

  it("leaves out update files without a signature and reports the OS as missing", () => {
    const files = UPDATE_FILES.filter((n) => !n.includes("aarch64"));
    const json = updaterJson(release, signed(files), "2026-11-25T14:00:00.000Z");
    expect(json.platforms["darwin-aarch64"]).toBeUndefined();
    expect(missingPlatforms(json)).toEqual(["darwin-aarch64"]);
  });
});
