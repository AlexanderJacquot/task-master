import { expect, it } from "vitest";
import { fitCamera, MAX_ZOOM, MIN_ZOOM, worldPoint, zoomAt } from "./canvas";
import { NODE_HEIGHT, NODE_WIDTH } from "./graph";

it("keeps the canvas point under the cursor fixed while zooming and clamps zoom", () => {
  const camera = { x: -320, y: 140, zoom: 0.8 };
  const cursor = { x: 230, y: 410 };
  const before = worldPoint(cursor, camera);
  for (const scale of [0, 0.5, 1.5, 10]) {
    const next = zoomAt(camera, cursor, scale);
    const after = worldPoint(cursor, next);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(next.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(next.zoom).toBeLessThanOrEqual(MAX_ZOOM);
  }
});

it("fits freely placed cards, including negative coordinates, inside the viewport", () => {
  const points = [
    { x: -600, y: -300 },
    { x: 800, y: 700 },
  ];
  const camera = fitCamera(points, 1200, 900);
  for (const point of points) {
    expect(point.x * camera.zoom + camera.x).toBeGreaterThanOrEqual(50);
    expect(point.y * camera.zoom + camera.y).toBeGreaterThanOrEqual(80);
    expect((point.x + NODE_WIDTH) * camera.zoom + camera.x).toBeLessThanOrEqual(1150);
    expect((point.y + NODE_HEIGHT) * camera.zoom + camera.y).toBeLessThanOrEqual(820);
  }
});
