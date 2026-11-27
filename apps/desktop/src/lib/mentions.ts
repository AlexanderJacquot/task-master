// @mentions of team members (ADR 033, T5): finding the `@query` being typed, the members it
// matches, and the mentions in a text. Pure functions; the picker is components/MentionMenu.

import type { Member } from "./types";

/** The longest `@query` the picker follows ("@" plus a full name with a space or two). */
const MAX_QUERY = 32;

/** An `@query` being typed: `from` is the `@`'s offset. */
export interface MentionAt {
  from: number;
  query: string;
}

/**
 * The `@query` that ends at `caret`, or null. The `@` starts the text or follows a space or
 * an opening bracket (an address like a@b.c is not a mention); the query stays on one line
 * and does not start with a space.
 */
export function mentionAt(text: string, caret: number): MentionAt | null {
  const from = text.lastIndexOf("@", caret - 1);
  if (from < 0 || caret - from - 1 > MAX_QUERY) return null;
  const query = text.slice(from + 1, caret);
  if (/[\n@]/.test(query) || /^\s/.test(query)) return null;
  const before = from > 0 ? text[from - 1] : "";
  if (before && !/[\s([{"'“‘]/.test(before)) return null;
  return { from, query };
}

/** Members whose name, or a word of it, starts with `query` (any case), by name. */
export function matchMembers(members: Member[], query: string, limit = 6): Member[] {
  const q = query.toLowerCase();
  return members
    .filter((m) => {
      const name = m.name.toLowerCase();
      return name.startsWith(q) || name.split(/\s+/).some((word) => word.startsWith(q));
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** What picking `member` writes in place of the `@query`. */
export function mentionText(member: Member): string {
  return `@${member.name} `;
}

/** A pattern for `@Name` of any of `names`, longest first so "Ada L" wins over "Ada". */
function mentionPattern(names: string[]): RegExp | null {
  if (!names.length) return null;
  const escaped = [...names]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`@(?:${escaped.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

/** The text with each `@Name` of a member set apart. */
export function mentionParts(
  body: string,
  members: Member[],
): Array<{ text: string; mention: boolean }> {
  const pattern = mentionPattern(members.map((m) => m.name));
  if (!pattern) return [{ text: body, mention: false }];
  const parts: Array<{ text: string; mention: boolean }> = [];
  let last = 0;
  for (const match of body.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: body.slice(last, at), mention: false });
    parts.push({ text: match[0], mention: true });
    last = at + match[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last), mention: false });
  return parts;
}

/** The mdast nodes the remark plugin reads and writes (only what it needs of them). */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/**
 * A remark plugin that marks `@Name` of `members` in text (not in code or links) as a
 * `<span class="tm-mention">`, for MarkdownView.
 */
export function remarkMentions(members: Member[]) {
  return () => (tree: MdNode) => {
    if (!members.length) return;
    const walk = (node: MdNode) => {
      if (!node.children || node.type === "link" || node.type === "linkReference") return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value?.includes("@")) {
          walk(child);
          return [child];
        }
        return mentionParts(child.value, members).map((part) =>
          part.mention
            ? {
                type: "mention",
                children: [{ type: "text", value: part.text }],
                data: { hName: "span", hProperties: { className: ["tm-mention"] } },
              }
            : { type: "text", value: part.text },
        );
      });
    };
    walk(tree);
  };
}
