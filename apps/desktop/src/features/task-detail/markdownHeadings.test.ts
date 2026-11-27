import { describe, expect, it } from "vitest";
import { headingLevel } from "./markdownHeadings";

describe("headingLevel", () => {
  it("reads ATX and setext headings", () => {
    expect(headingLevel("ATXHeading1")).toBe(1);
    expect(headingLevel("ATXHeading3")).toBe(3);
    expect(headingLevel("SetextHeading2")).toBe(2);
  });
  it("ignores other nodes", () => {
    expect(headingLevel("HeaderMark")).toBe(0);
    expect(headingLevel("Paragraph")).toBe(0);
  });
});
