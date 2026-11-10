// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useLook } from "../lib/theme";
import { DeleteIcon, SearchIcon } from "./TaskIcons";

afterEach(() => {
  cleanup();
  useLook.setState({ look: "medieval" });
});

describe("TaskIcons", () => {
  it("draws the medieval glyph, and a lucide icon in the clean look", () => {
    const { container } = render(<DeleteIcon size={20} />);
    const medieval = container.querySelector("svg");
    expect(medieval?.getAttribute("viewBox")).toBe("0.75 0.75 22.5 22.5");
    expect(medieval?.classList.contains("lucide")).toBe(false);
    act(() => useLook.setState({ look: "clean" }));
    const clean = container.querySelector("svg");
    expect(clean?.classList.contains("lucide-trash-2")).toBe(true);
    expect(clean?.getAttribute("width")).toBe("18.5");
  });

  it("keeps a caller's label in both looks", () => {
    useLook.setState({ look: "clean" });
    const { getByLabelText } = render(<SearchIcon aria-label="Search" className="x" />);
    expect(getByLabelText("Search").classList.contains("x")).toBe(true);
  });
});
