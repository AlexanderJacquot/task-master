// Export the Roadmap as an image (ADR 034). The core draws the SVG from the rows the page
// shows (`roadmap_svg`), so the sync server can draw the same one later; PNG is rasterized
// here on a canvas, copied with the clipboard API or written where the user saves it.

import { save } from "@tauri-apps/plugin-dialog";
import { commands } from "../../bindings";
import { ApiError } from "../../lib/api";
import type {
  CommandError,
  ImageRow,
  ImageTheme,
  RenderedImage,
  RoadmapImage,
} from "../../lib/types";
import type { Link, Row } from "./timeline";

export type ImageFormat = "png" | "svg";

/**
 * The image's rows: only what is on the timeline. An epic or task without a bar, and a
 * group with no bar under it, stay out (pass rows built from the scheduled items, so group
 * counts and spans are theirs).
 */
export function imageRows(rows: Row[]): ImageRow[] {
  const out: ImageRow[] = [];
  for (const row of rows) {
    if (row.kind === "group") {
      if (!row.span) continue;
      out.push({
        kind: "group",
        label: row.label,
        color: row.color,
        count: row.count,
        start: row.span.start,
        end: row.span.end,
      });
    } else {
      const { item } = row;
      const { bar } = item;
      if (!bar) continue;
      out.push({
        kind: "item",
        id: item.id,
        title: item.title,
        depth: row.depth,
        start: bar.start,
        end: bar.end,
        done: item.done,
        progress: item.progress,
        color: item.color,
      });
    }
  }
  return out;
}

/** The arrows between rows that are in the image. */
export function imageLinks(links: Link[], rows: ImageRow[]) {
  const shown = new Set(rows.flatMap((row) => (row.kind === "item" ? [row.id] : [])));
  return links
    .filter((link) => shown.has(link.from) && shown.has(link.to))
    .map(({ from, to }) => ({ from, to }));
}

/** The app's theme now (the classes `applyTheme` sets on <html>). */
export function currentImageTheme(root: HTMLElement = document.documentElement): ImageTheme {
  if (root.classList.contains("dark")) return "dark";
  if (root.classList.contains("clean")) return "clean";
  return "light";
}

/** "ui-roadmap-2026-11-21.png" from the title and the day. */
export function imageFileName(title: string, today: string, format: ImageFormat): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "roadmap"}-${today}.${format}`;
}

/** The path with the format's extension (a GTK save dialog does not add it). */
export function withExtension(path: string, format: ImageFormat): string {
  return path.toLowerCase().endsWith(`.${format}`) ? path : `${path}.${format}`;
}

/** Pixels per SVG pixel in the PNG: sharp (2x) unless that would make a canvas too big. */
export function pngScale(width: number, height: number): number {
  const side = 16_384;
  const area = 64_000_000;
  return Math.min(2, side / width, side / height, Math.sqrt(area / (width * height)));
}

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: CommandError | string };

async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const result = await call;
  if (!result) throw new ApiError("internal", "Images are drawn by the desktop app.");
  if (result.status === "ok") return result.data;
  const { error } = result;
  if (typeof error === "string") throw new ApiError("internal", error);
  throw new ApiError(error.kind, error.message);
}

/** The roadmap as SVG, drawn by the core. */
export function renderSvg(image: RoadmapImage): Promise<RenderedImage> {
  return unwrap(commands.roadmapSvg(image));
}

/** Rasterizes the SVG on a canvas. Fonts fall back to the system's sans-serif. */
export async function svgToPng(rendered: RenderedImage): Promise<Blob> {
  const scale = pngScale(rendered.width, rendered.height);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not draw the image."));
    // A data URL (not a blob URL) keeps WebKit from tainting the canvas.
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(rendered.width * scale);
  canvas.height = Math.round(rendered.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not draw the image.");
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not make the PNG."))),
      "image/png",
    ),
  );
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the PNG."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Copies the roadmap as a PNG. Call it straight from the click: WebKit only lets the page
 * write to the clipboard during the click, so the image goes in as a promise of itself.
 */
export async function copyImage(image: RoadmapImage): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write)
    throw new Error("The clipboard does not take images here. Save the image instead.");
  const png = renderSvg(image).then(svgToPng);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** Asks where to save, then writes the PNG or SVG there. The path, or null if cancelled. */
export async function saveImageAs(
  image: RoadmapImage,
  format: ImageFormat,
  today: string,
): Promise<string | null> {
  const chosen = await save({
    title: "Save the roadmap image",
    defaultPath: imageFileName(image.title, today, format),
    filters: [{ name: format === "png" ? "PNG image" : "SVG image", extensions: [format] }],
  });
  if (!chosen) return null;
  const path = withExtension(chosen, format);
  const rendered = await renderSvg(image);
  const data = format === "svg" ? rendered.svg : await base64Of(await svgToPng(rendered));
  await unwrap(commands.saveImage(path, data));
  return path;
}
