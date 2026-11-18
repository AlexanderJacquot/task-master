import { describe, expect, it } from "vitest";
import { dropPointToCss } from "./useFileDrop";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/131.0";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15";

describe("dropPointToCss", () => {
  it("keeps macOS points as they are, even on a Retina screen", () => {
    expect(dropPointToCss(300, 120, MAC, 2)).toEqual([300, 120]);
  });

  it("divides physical pixels by the device pixel ratio elsewhere", () => {
    expect(dropPointToCss(300, 120, WINDOWS, 1.5)).toEqual([200, 80]);
    expect(dropPointToCss(300, 120, LINUX, 2)).toEqual([150, 60]);
  });
});
