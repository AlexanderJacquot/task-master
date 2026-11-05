// jsdom has no layout engine. These stubs let the virtualizer and CodeMirror run in tests;
// they only apply where `window` exists (component tests opt in with @vitest-environment).
if (typeof window !== "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

  // Give every element a viewport-sized box so virtualized lists render their rows.
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1000, width: 1000, height: 800 };
  HTMLElement.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
  for (const [prop, value] of [
    ["offsetHeight", 800],
    ["offsetWidth", 1000],
    ["clientHeight", 800],
    ["clientWidth", 1000],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }

  // Radix Select scrolls the chosen option into view and checks pointer capture.
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};

  // CodeMirror measures text through Range rects.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
}
