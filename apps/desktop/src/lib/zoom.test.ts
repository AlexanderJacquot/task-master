// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  loadZoom,
  saveZoom,
  stepZoom,
  unzoomTransform,
  WHEEL_STEP_PX,
  wheelAccumulator,
  ZOOM_STEPS,
} from "./zoom";

it("steps through the scale and stops at its ends", () => {
  expect(stepZoom(1, 1)).toBe(1.05);
  expect(stepZoom(1, -1)).toBe(0.95);
  expect(ZOOM_STEPS[0]).toBe(0.3);
  expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(ZOOM_STEPS[0]);
  expect(stepZoom(2, 1)).toBe(2);
  // An off-scale value snaps to the nearest step first.
  expect(stepZoom(0.93, 1)).toBe(1);
});

it("comes back to exactly 100% after zooming out and in", () => {
  let zoom = 1;
  for (let i = 0; i < 3; i++) zoom = stepZoom(zoom, -1);
  for (let i = 0; i < 3; i++) zoom = stepZoom(zoom, 1);
  expect(zoom).toBe(1);
});

it("makes one step per mouse notch and gathers small touchpad deltas", () => {
  const notch = wheelAccumulator();
  expect(notch(-WHEEL_STEP_PX, 0, 0)).toBe(1);
  expect(notch(WHEEL_STEP_PX, 0, 10)).toBe(-1);
  // Lines (Firefox-style deltas) count as a notch each.
  expect(notch(3, 1, 20)).toBe(-1);

  const pinch = wheelAccumulator();
  const steps = [0, 1, 2, 3, 4, 5].map((i) => pinch(-10, 0, 100 + i * 16));
  expect(steps.filter((s) => s !== 0)).toEqual([1]);
  // A pause starts over.
  expect(pinch(-10, 0, 5_000)).toBe(0);
});

it("remembers each region's zoom and forgets 100%", () => {
  saveZoom("sidebar", 0.8);
  saveZoom("main", 1.25);
  expect(loadZoom("sidebar")).toBe(0.8);
  expect(loadZoom("main")).toBe(1.25);
  saveZoom("sidebar", 1);
  expect(localStorage.getItem("task-master.zoom.sidebar")).toBeNull();
  expect(loadZoom("sidebar")).toBe(1);
  localStorage.setItem("task-master.zoom.main", "garbage");
  expect(loadZoom("main")).toBe(1);
  localStorage.removeItem("task-master.zoom.main");
});

it("turns a screen-px transform into layout px of the zoomed box", () => {
  expect(unzoomTransform({ x: 80, y: -40, scaleX: 1, scaleY: 1 }, 0.8)).toEqual({
    x: 100,
    y: -50,
    scaleX: 1,
    scaleY: 1,
  });
  expect(unzoomTransform(null, 0.8)).toBeNull();
  const same = { x: 3, y: 4 };
  expect(unzoomTransform(same, 1)).toBe(same);
});
