import { useEffect, useRef } from "react";

const MIDDLE = 1;

/** The nearest element from `target` up to `root` that can scroll vertically. */
function verticalScroller(target: EventTarget | null, root: HTMLElement): HTMLElement {
  for (
    let el = target instanceof Element ? target : null;
    el && el !== root;
    el = el.parentElement
  ) {
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight) continue;
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") return el;
  }
  return root;
}

/**
 * Middle-button drag pans the element like grabbing paper: the content follows the mouse.
 * It replaces the browser's middle-click autoscroll. Horizontal motion scrolls the element;
 * vertical motion scrolls whatever is under the pointer (a column, or the element itself).
 * Trackpads are untouched: two-finger swipes already scroll natively.
 */
export function useMiddleDragPan<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let pan: {
      id: number;
      x: number;
      y: number;
      left: number;
      top: number;
      vertical: HTMLElement;
    } | null = null;

    const end = () => {
      if (!pan) return;
      if (root.hasPointerCapture?.(pan.id)) root.releasePointerCapture(pan.id);
      pan = null;
      delete root.dataset.panning;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== MIDDLE) return;
      e.preventDefault();
      const vertical = verticalScroller(e.target, root);
      pan = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        left: root.scrollLeft,
        top: vertical.scrollTop,
        vertical,
      };
      root.setPointerCapture?.(e.pointerId);
      root.dataset.panning = "";
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!pan || e.pointerId !== pan.id) return;
      root.scrollLeft = pan.left - (e.clientX - pan.x);
      pan.vertical.scrollTop = pan.top - (e.clientY - pan.y);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pan && e.pointerId === pan.id) end();
    };
    // Chromium starts autoscroll (and Linux pastes the selection) from the mouse event
    // itself, so the compatibility mousedown and the auxclick are cancelled too.
    const cancelMiddle = (e: MouseEvent) => {
      if (e.button === MIDDLE) e.preventDefault();
    };

    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerup", onPointerUp);
    root.addEventListener("pointercancel", end);
    root.addEventListener("lostpointercapture", end);
    root.addEventListener("mousedown", cancelMiddle);
    root.addEventListener("auxclick", cancelMiddle);
    return () => {
      end();
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointercancel", end);
      root.removeEventListener("lostpointercapture", end);
      root.removeEventListener("mousedown", cancelMiddle);
      root.removeEventListener("auxclick", cancelMiddle);
    };
  }, []);

  return ref;
}
