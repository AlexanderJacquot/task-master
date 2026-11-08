// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fitHeight, TitleField } from "./TitleField";

function withScrollHeight(el: HTMLElement, value: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => value });
}

describe("TitleField", () => {
  it("sets the height to the content height", () => {
    const el = document.createElement("textarea");
    withScrollHeight(el, 138);
    fitHeight(el);
    expect(el.style.height).toBe("138px");
  });

  it("grows as the title is typed", () => {
    render(<TitleField aria-label="Title" defaultValue="Short" />);
    const field = screen.getByLabelText("Title") as HTMLTextAreaElement;
    withScrollHeight(field, 92);
    fireEvent.input(field, { target: { value: "A much longer title that wraps" } });
    expect(field.style.height).toBe("92px");
  });
});
