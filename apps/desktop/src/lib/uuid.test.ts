import { describe, expect, it } from "vitest";
import { uuidv7 } from "./uuid";

describe("uuidv7", () => {
  it("is a well-formed v7 UUID", () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("sorts by creation time", () => {
    expect(uuidv7(1_000) < uuidv7(2_000)).toBe(true);
  });

  it("encodes the timestamp in the first 48 bits", () => {
    const id = uuidv7(0x0193_1234_5678);
    expect(id.startsWith("01931234-5678-7")).toBe(true);
  });
});
