import { describe, expect, it } from "vitest";
import { matchMembers, mentionAt, mentionParts, remarkMentions } from "./mentions";
import type { Member } from "./types";

const member = (id: string, name: string): Member => ({
  id,
  name,
  color: null,
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
});
const ada = member("a", "Ada Lovelace");
const bob = member("b", "Bob");

describe("mentionAt", () => {
  it("finds the @query before the caret", () => {
    expect(mentionAt("@", 1)).toEqual({ from: 0, query: "" });
    expect(mentionAt("hi @bo", 6)).toEqual({ from: 3, query: "bo" });
    expect(mentionAt("hi (@Ada L", 10)).toEqual({ from: 4, query: "Ada L" });
    // The caret in the middle: only what is before it.
    expect(mentionAt("hi @bob there", 5)).toEqual({ from: 3, query: "b" });
  });

  it("leaves addresses, other lines, and long or spaced queries alone", () => {
    expect(mentionAt("mail a@b", 8)).toBeNull();
    expect(mentionAt("@bo\nb", 5)).toBeNull();
    expect(mentionAt("@ bob", 5)).toBeNull();
    expect(mentionAt(`@${"x".repeat(33)}`, 34)).toBeNull();
    expect(mentionAt("no at sign", 10)).toBeNull();
  });
});

describe("matchMembers", () => {
  it("matches the start of the name or of any word, in any case", () => {
    expect(matchMembers([bob, ada], "")).toEqual([ada, bob]);
    expect(matchMembers([bob, ada], "lov")).toEqual([ada]);
    expect(matchMembers([bob, ada], "B")).toEqual([bob]);
    expect(matchMembers([bob, ada], "ada l")).toEqual([ada]);
    expect(matchMembers([bob, ada], "zed")).toEqual([]);
  });
});

describe("mentions in a text", () => {
  it("sets apart full names, longest first, not the start of a longer word", () => {
    expect(mentionParts("@Ada Lovelace and @bobby, @Bob.", [ada, bob])).toEqual([
      { text: "@Ada Lovelace", mention: true },
      { text: " and @bobby, ", mention: false },
      { text: "@Bob", mention: true },
      { text: ".", mention: false },
    ]);
  });

  it("marks mentions in markdown text but not in code or links", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "ask @Bob " },
            { type: "inlineCode", value: "@Bob" },
            { type: "link", children: [{ type: "text", value: "@Bob" }] },
          ],
        },
      ],
    };
    remarkMentions([bob])()(tree);
    const paragraph = tree.children[0]?.children ?? [];
    expect(paragraph.map((n) => n.type)).toEqual(["text", "mention", "text", "inlineCode", "link"]);
    expect(paragraph[1]).toMatchObject({
      children: [{ type: "text", value: "@Bob" }],
      data: { hName: "span" },
    });
  });
});
