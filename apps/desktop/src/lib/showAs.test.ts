import { describe, expect, it } from "vitest";
import { availabilityNote, edgeStyle, fillShare, showAsLabel } from "./showAs";

describe("show as", () => {
  it("names what differs from a plain busy item", () => {
    expect(availabilityNote("busy", false)).toBe("");
    expect(availabilityNote("busy", true)).toBe("private");
    expect(availabilityNote("tentative", true)).toBe("tentative, private");
    expect(availabilityNote("free", false)).toBe("free");
    expect(showAsLabel("tentative")).toBe("Tentative");
  });

  it("draws tentative and free items lighter, with a broken outline", () => {
    expect(fillShare("busy", 22)).toBe(22);
    expect(fillShare("tentative", 22)).toBeLessThan(22);
    expect(fillShare("free", 22)).toBeLessThan(fillShare("tentative", 22));
    expect(edgeStyle("busy", "solid")).toBe("solid");
    expect(edgeStyle("tentative", "solid")).toBe("dashed");
    // Events are already dashed when busy.
    expect(edgeStyle("tentative", "dashed")).toBe("dotted");
    expect(edgeStyle("free", "dashed")).toBe("dotted");
  });
});
