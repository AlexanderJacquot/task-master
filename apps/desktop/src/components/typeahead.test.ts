import { describe, expect, it } from "vitest";
import { typeaheadMatch } from "./ui";

describe("typeaheadMatch", () => {
  const labels = ["None", "Development", "Design", "Home lab"];
  it("prefers a prefix match", () => {
    expect(typeaheadMatch(labels, "d")).toBe(1);
    expect(typeaheadMatch(labels, "des")).toBe(2);
  });
  it("falls back to a substring", () => {
    expect(typeaheadMatch(labels, "lab")).toBe(3);
  });
  it("is -1 without a match", () => {
    expect(typeaheadMatch(labels, "zz")).toBe(-1);
  });
});
