// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { zoomOf } from "../../lib/zoom";
import { useUiZoom } from "./useUiZoom";

function Harness() {
  const zoom = useUiZoom();
  return (
    <div>
      <div data-zoom-region="sidebar" data-zoom={zoom.sidebar} data-testid="sidebar">
        <span data-testid="in-sidebar">sidebar</span>
      </div>
      <div data-zoom-region="main" data-zoom={zoom.main} data-testid="main">
        <span data-testid="in-main">main</span>
        <canvas data-testid="canvas" />
      </div>
    </div>
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function wheel(target: Element, init: WheelEventInit) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

it("zooms only the region under the pointer, and remembers it", () => {
  const { getByTestId } = render(<Harness />);
  const event = wheel(getByTestId("in-sidebar"), { deltaY: 100, ctrlKey: true });
  expect(event.defaultPrevented).toBe(true);
  expect(getByTestId("sidebar").dataset.zoom).toBe("0.95");
  expect(getByTestId("main").dataset.zoom).toBe("1");

  wheel(getByTestId("in-main"), { deltaY: -100, ctrlKey: true });
  wheel(getByTestId("in-main"), { deltaY: -100, ctrlKey: true });
  expect(getByTestId("main").dataset.zoom).toBe("1.1");
  expect(localStorage.getItem("task-master.zoom.main")).toBe("1.1");
  expect(zoomOf(getByTestId("in-main"))).toBe(1.1);
});

it("leaves a plain wheel and a Ctrl+wheel already handled alone", () => {
  const { getByTestId } = render(<Harness />);
  const plain = wheel(getByTestId("in-main"), { deltaY: 100 });
  expect(plain.defaultPrevented).toBe(false);

  const canvas = getByTestId("canvas");
  const own = (e: Event) => e.preventDefault();
  canvas.addEventListener("wheel", own);
  wheel(canvas, { deltaY: 100, ctrlKey: true });
  canvas.removeEventListener("wheel", own);
  expect(getByTestId("main").dataset.zoom).toBe("1");
});

it("puts the hovered region back to 100% with Ctrl+0", () => {
  localStorage.setItem("task-master.zoom.sidebar", "0.75");
  const { getByTestId } = render(<Harness />);
  expect(getByTestId("sidebar").dataset.zoom).toBe("0.75");
  act(() => {
    getByTestId("in-sidebar").dispatchEvent(new Event("pointerover", { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", ctrlKey: true }));
  });
  expect(getByTestId("sidebar").dataset.zoom).toBe("1");
});
