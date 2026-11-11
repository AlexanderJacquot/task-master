// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { descriptionExcerpt, useDescriptionFolded } from "./useDescriptionFolded";

describe("descriptionExcerpt", () => {
  it("takes the first line of text without markdown markers", () => {
    expect(descriptionExcerpt("\n## Plan **now**\nmore")).toBe("Plan now");
    expect(descriptionExcerpt("- [x] [Spec](https://x.y) ready")).toBe("Spec ready");
    expect(descriptionExcerpt("![shot](tm:1)\n> quoted")).toBe("quoted");
    expect(descriptionExcerpt("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(descriptionExcerpt("---\n\n")).toBe("");
  });
});

describe("useDescriptionFolded", () => {
  beforeEach(() => localStorage.clear());

  it("remembers the choice per variant", () => {
    const panel = renderHook(() => useDescriptionFolded("panel"));
    expect(panel.result.current[0]).toBe(false);
    act(() => panel.result.current[1](true));
    expect(panel.result.current[0]).toBe(true);

    expect(renderHook(() => useDescriptionFolded("panel")).result.current[0]).toBe(true);
    expect(renderHook(() => useDescriptionFolded("page")).result.current[0]).toBe(false);
  });

  it("opens for a task just created without forgetting the choice", () => {
    act(() => renderHook(() => useDescriptionFolded("panel")).result.current[1](true));
    expect(renderHook(() => useDescriptionFolded("panel", true)).result.current[0]).toBe(false);
    expect(renderHook(() => useDescriptionFolded("panel")).result.current[0]).toBe(true);
  });
});
