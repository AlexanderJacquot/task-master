// Attachments in descriptions (ADR 011): `![name](attachment:<id>)` shows an image,
// `[name](attachment:<id>)` links any other file. Pure helpers, shared by the editor,
// the rendered view and the attachment list.

import type { Attachment } from "./types";

export const ATTACHMENT_SCHEME = "attachment:";

/** The attachment id in an `attachment:<id>` link, or null for any other URL. */
export function attachmentId(url: string | null | undefined): string | null {
  if (!url?.startsWith(ATTACHMENT_SCHEME)) return null;
  const id = url.slice(ATTACHMENT_SCHEME.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export function isImage(attachment: Pick<Attachment, "mime">): boolean {
  return attachment.mime.startsWith("image/");
}

/** Brackets and backslashes would end the link text early. */
function linkText(name: string): string {
  return name.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/** The markdown that shows (image) or links (other files) an attachment. */
export function attachmentMarkdown(attachment: Pick<Attachment, "id" | "name" | "mime">): string {
  const link = `[${linkText(attachment.name)}](${ATTACHMENT_SCHEME}${attachment.id})`;
  return isImage(attachment) ? `!${link}` : link;
}

/** Joins snippets into a block to insert: images on their own lines, links inline. */
export function insertionText(snippets: string[]): string {
  return snippets.join("\n");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Same limit as the core (`MAX_ATTACHMENT_BYTES`), checked early to fail fast. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** A name for pasted content that has none (clipboard screenshots are `image.png`). */
export function pastedName(file: { name: string; type: string }, now = new Date()): string {
  if (file.name && file.name !== "image.png") return file.name;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\+.*/, "") || "bin";
  const stamp = now.toISOString().slice(0, 19).replace("T", " ").replaceAll(":", "-");
  return `${file.type.startsWith("image/") ? "Pasted image" : "Pasted file"} ${stamp}.${ext}`;
}

/** Base64 of a file's bytes, for `storeData`. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Ticks or unticks the task-list item on 1-based `line` (`- [ ]` ↔ `- [x]`). Returns the
 * text unchanged when that line holds no task item.
 */
export function toggleTaskItem(markdown: string, line: number, checked: boolean): string {
  const lines = markdown.split("\n");
  const index = line - 1;
  const current = lines[index];
  if (current === undefined) return markdown;
  const next = current.replace(
    /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/,
    `$1[${checked ? "x" : " "}]`,
  );
  if (next === current) return markdown;
  lines[index] = next;
  return lines.join("\n");
}
