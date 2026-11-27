import { describe, expect, it } from "vitest";
import {
  attachmentId,
  attachmentMarkdown,
  fileToBase64,
  formatSize,
  pastedName,
  toggleTaskItem,
} from "./attachments";

const ID = "0192f0c4-1d2e-7a3b-8c4d-5e6f7a8b9c0d";

describe("attachment links", () => {
  it("reads ids only from attachment: links with a uuid", () => {
    expect(attachmentId(`attachment:${ID}`)).toBe(ID);
    expect(attachmentId("attachment:../../etc/passwd")).toBeNull();
    expect(attachmentId("https://example.com/a.png")).toBeNull();
    expect(attachmentId(undefined)).toBeNull();
  });

  it("writes images as images and other files as links, escaping brackets", () => {
    expect(attachmentMarkdown({ id: ID, name: "shot.png", mime: "image/png" })).toBe(
      `![shot.png](attachment:${ID})`,
    );
    expect(attachmentMarkdown({ id: ID, name: "plan [v2].pdf", mime: "application/pdf" })).toBe(
      `[plan \\[v2\\].pdf](attachment:${ID})`,
    );
  });
});

describe("task-list items", () => {
  const text = "Steps\n- [ ] open settings\n  * [x] nested\n1. [ ] numbered\nplain [ ] line";

  it("ticks and unticks the item on a line", () => {
    expect(toggleTaskItem(text, 2, true).split("\n")[1]).toBe("- [x] open settings");
    expect(toggleTaskItem(text, 3, false).split("\n")[2]).toBe("  * [ ] nested");
    expect(toggleTaskItem(text, 4, true).split("\n")[3]).toBe("1. [x] numbered");
  });

  it("leaves lines without an item alone", () => {
    expect(toggleTaskItem(text, 1, true)).toBe(text);
    expect(toggleTaskItem(text, 5, true)).toBe(text);
    expect(toggleTaskItem(text, 99, true)).toBe(text);
  });
});

describe("pasted files", () => {
  it("names clipboard screenshots by time and keeps real names", () => {
    const at = new Date("2026-11-05T09:30:12Z");
    expect(pastedName({ name: "image.png", type: "image/png" }, at)).toBe(
      "Pasted image 2026-11-05 09-30-12.png",
    );
    expect(pastedName({ name: "", type: "image/jpeg" }, at)).toBe(
      "Pasted image 2026-11-05 09-30-12.jpg",
    );
    expect(pastedName({ name: "", type: "image/svg+xml" }, at)).toMatch(/\.svg$/);
    expect(pastedName({ name: "report.pdf", type: "application/pdf" }, at)).toBe("report.pdf");
  });

  it("encodes bytes as base64, also past one chunk", async () => {
    expect(await fileToBase64(new Blob(["hello"]))).toBe("aGVsbG8=");
    const big = new Uint8Array(0x8000 * 2 + 3).fill(65);
    expect(atob(await fileToBase64(new Blob([big])))).toBe("A".repeat(big.length));
  });

  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(200 * 1024)).toBe("200 KB");
    expect(formatSize(3.25 * 1024 * 1024)).toBe("3.3 MB");
  });
});
