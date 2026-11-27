import { DragOverlay } from "@dnd-kit/core";
import type { ComponentProps } from "react";
import { createPortal } from "react-dom";
import { useRegionZoom } from "../lib/zoom";

/**
 * dnd-kit's DragOverlay for a zoomed region. The overlay is position: fixed at screen
 * coordinates, which a zoomed ancestor would scale a second time; it goes to the body
 * instead, and only its content takes the region's zoom.
 */
export function ZoomDragOverlay({ children, ...props }: ComponentProps<typeof DragOverlay>) {
  const zoom = useRegionZoom();
  if (zoom === 1) return <DragOverlay {...props}>{children}</DragOverlay>;
  return createPortal(
    <DragOverlay {...props}>
      {children ? <div style={{ zoom }}>{children}</div> : null}
    </DragOverlay>,
    document.body,
  );
}
