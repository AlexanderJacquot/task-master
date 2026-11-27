// Files dragged in from the OS. Tauri intercepts them (the webview never sees an HTML
// drop) and reports their paths and position; this hook forwards a drop to the nearest
// `[data-file-drop]` element under the pointer as a `tm-file-drop` event, and marks the
// element under a drag with `data-drop-active` for styling.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";

export const FILE_DROP_EVENT = "tm-file-drop";

export interface FileDropDetail {
  paths: string[];
}

/**
 * A drag position from Tauri in CSS pixels. Tauri calls it physical, and it is on Windows
 * and Linux; on macOS wry reports points, which are already CSS pixels (dividing them by
 * the Retina ratio put every drop at half its place).
 */
export function dropPointToCss(
  x: number,
  y: number,
  userAgent = navigator.userAgent,
  ratio = window.devicePixelRatio || 1,
): [number, number] {
  const scale = /Macintosh|Mac OS X/.test(userAgent) ? 1 : ratio;
  return [x / scale, y / scale];
}

/** The drop target at a position reported by Tauri, if any. */
export function dropTargetAt(x: number, y: number) {
  const el = document.elementFromPoint(...dropPointToCss(x, y));
  return el?.closest<HTMLElement>("[data-file-drop]") ?? null;
}

let active: HTMLElement | null = null;

function highlight(target: HTMLElement | null) {
  if (active === target) return;
  active?.removeAttribute("data-drop-active");
  active = target;
  active?.setAttribute("data-drop-active", "");
}

export function dispatchFileDrop(target: HTMLElement, paths: string[]) {
  target.dispatchEvent(
    new CustomEvent<FileDropDetail>(FILE_DROP_EVENT, { detail: { paths }, bubbles: false }),
  );
}

/** Mounted once by the app shell. Outside Tauri (tests, plain browser) it does nothing. */
export function useFileDrop() {
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "leave") return highlight(null);
        const target = dropTargetAt(payload.position.x, payload.position.y);
        if (payload.type === "drop") {
          highlight(null);
          if (target && payload.paths.length) dispatchFileDrop(target, payload.paths);
        } else {
          highlight(target);
        }
      })
      .then(
        (stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        },
        (err) => console.warn("file drop unavailable", err),
      );
    return () => {
      cancelled = true;
      unlisten?.();
      highlight(null);
    };
  }, []);
}
