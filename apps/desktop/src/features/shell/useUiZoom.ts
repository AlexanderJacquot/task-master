import { useEffect, useState } from "react";
import { loadZoom, saveZoom, stepZoom, wheelAccumulator, type ZoomRegion } from "../../lib/zoom";

export type UiZoom = Record<ZoomRegion, number>;

/**
 * Ctrl+wheel zooms the region under the pointer (`data-zoom-region` on its root): the
 * sidebar, or the page with its task panel. Ctrl+0 over a region puts it back to 100%.
 * A Ctrl+wheel something already handled (the lineage canvas zooms itself) is left alone.
 */
export function useUiZoom(): UiZoom {
  const [zoom, setZoom] = useState<UiZoom>(() => ({
    sidebar: loadZoom("sidebar"),
    main: loadZoom("main"),
  }));

  useEffect(() => {
    let hovered: ZoomRegion | null = null;
    const regionOf = (target: EventTarget | null): ZoomRegion | null => {
      const host =
        target instanceof Element ? target.closest<HTMLElement>("[data-zoom-region]") : null;
      const region = host?.dataset.zoomRegion;
      return region === "sidebar" || region === "main" ? region : null;
    };
    const update = (region: ZoomRegion, next: (z: number) => number) =>
      setZoom((current) => {
        const value = next(current[region]);
        if (value === current[region]) return current;
        saveZoom(region, value);
        return { ...current, [region]: value };
      });

    const accumulate = wheelAccumulator();
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
      // Never let the webview zoom the whole window.
      e.preventDefault();
      const region = regionOf(e.target);
      if (!region) return;
      const direction = accumulate(e.deltaY, e.deltaMode, e.timeStamp);
      if (direction) update(region, (z) => stepZoom(z, direction));
    };
    const pointer = (e: PointerEvent) => {
      hovered = regionOf(e.target);
    };
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key !== "0") return;
      if (!hovered) return;
      e.preventDefault();
      update(hovered, () => 1);
    };
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("pointerover", pointer);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("pointerover", pointer);
      window.removeEventListener("keydown", key);
    };
  }, []);

  return zoom;
}
