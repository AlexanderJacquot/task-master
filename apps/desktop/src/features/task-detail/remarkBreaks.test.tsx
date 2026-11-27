// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { MarkdownView } from "./MarkdownView";

afterEach(cleanup);

// MarkdownView reads the team's members (for `@Name`); an empty store has none.
const api = {} as Api;

const view = (source: string) =>
  render(
    <StoreProvider store={createTaskStore(api)} api={api}>
      <MarkdownView source={source} attachments={{}} actions={{}} />
    </StoreProvider>,
  ).container;

describe("line returns in markdown", () => {
  it("break the line inside a paragraph", () => {
    const p = view("first line\nsecond line\r\nthird **bold**\nfourth").querySelector("p");
    expect(p?.querySelectorAll("br")).toHaveLength(3);
    expect(p?.textContent).toBe("first line\nsecond line\nthird bold\nfourth");
  });

  it("break the line inside list items and emphasis", () => {
    const c = view("- one\n  more\n- *a\nb*");
    const [first, second] = c.querySelectorAll("li");
    expect(first?.querySelectorAll("br")).toHaveLength(1);
    expect(second?.querySelectorAll("em br")).toHaveLength(1);
  });

  it("leave code blocks, blank-line paragraphs and hard breaks alone", () => {
    const c = view("a\n\nb  \nc\n\n```\nx\ny\n```");
    expect(c.querySelectorAll("p")).toHaveLength(2);
    expect(c.querySelectorAll("p br")).toHaveLength(1);
    expect(c.querySelector("pre br")).toBeNull();
    expect(c.querySelector("code")?.textContent).toBe("x\ny\n");
  });
});
