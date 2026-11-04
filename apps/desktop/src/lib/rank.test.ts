import { describe, expect, it } from "vitest";
import vectors from "../../../../crates/core/test-vectors/rank.json";
import { rankBetween } from "./rank";

describe("rankBetween matches the Rust core", () => {
  for (const c of vectors.cases) {
    it(`${c.a} .. ${c.b}`, () => {
      if (c.error) {
        expect(() => rankBetween(c.a, c.b)).toThrow();
      } else {
        expect(rankBetween(c.a, c.b)).toBe(c.expected);
      }
    });
  }
});
