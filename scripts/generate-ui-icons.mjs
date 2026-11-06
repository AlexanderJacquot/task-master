// Canonical geometry is shared with the React components; exports cannot drift.
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../apps/desktop/src/assets/icons/", import.meta.url);
const paths = JSON.parse(await readFile(new URL("paths.json", root), "utf8"));
for (const [name, d] of Object.entries(paths)) {
  await writeFile(
    new URL(`${name}.svg`, root),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><title>${name}</title><path d="${d}"/></svg>\n`,
  );
}

const brand = new URL("../apps/desktop/src/assets/brand/", import.meta.url);
const logo = await readFile(new URL("app-icon.svg", brand), "utf8");
const logoBody = logo.slice(logo.indexOf(">") + 1, logo.lastIndexOf("</svg>"));
const logoMark = logoBody.replace(/<rect[^>]+\/>/g, "").replace(/<path d="M75 119[^>]+\/>/, "");
await writeFile(
  new URL("logo-mark.svg", brand),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" fill="none">${logoMark}</svg>\n`,
);
const labels = {
  add: "Add",
  inbox: "Inbox",
  projects: "Projects",
  "due-date": "Due date",
  settings: "Settings",
  search: "Search",
  delete: "Delete",
  agents: "Agents",
  calendar: "Calendar",
  "all-tasks": "All tasks",
  archive: "Archive",
  unarchive: "Unarchive",
  priority: "Priority",
  bookmark: "Saved view",
  edit: "Edit",
  metrics: "Metrics",
  lineage: "Lineage",
  send: "Send",
  estimate: "Estimate",
  done: "Done",
  crown: "Crown",
  shield: "Shield",
};
// Icons per row in the proof sheet; each theme panel grows with the icon count.
const perRow = 8;
const cell = 112;
const rowH = 150;
const iconRows = Math.ceil(Object.keys(paths).length / perRow);
const panelH = 50 + iconRows * rowH;
const themes = [
  { y: 112, bg: "#F5E8D0", ink: "#39291D", muted: "#6E5A44", label: "PARCHMENT / INK" },
  {
    y: 112 + panelH + 16,
    bg: "#1F1A16",
    ink: "#F5DCA8",
    muted: "#C4AB80",
    label: "DARK / AGED GOLD",
  },
];
const logoY = 112 + 2 * (panelH + 16);
const height = logoY + 300;
let proof = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}"><title>Task Master asset library</title><rect width="1000" height="${height}" fill="#F9F2E3"/><g font-family="Georgia,serif"><text x="40" y="48" fill="#39291D" font-size="30">Task Master · Asset Library</text><text x="40" y="79" fill="#6E5A44" font-size="15">${Object.keys(paths).length} original path icons · 24 × 24 grid · 1.75 rounded strokes · currentColor</text>`;
for (const theme of themes) {
  proof += `<rect x="24" y="${theme.y}" width="952" height="${panelH}" rx="16" fill="${theme.bg}"/><text x="44" y="${theme.y + 30}" fill="${theme.muted}" font-size="12" letter-spacing="2">${theme.label}</text>`;
  for (const [index, [name, d]] of Object.entries(paths).entries()) {
    const x = 108 + (index % perRow) * cell;
    const y = theme.y + Math.floor(index / perRow) * rowH;
    proof += `<text x="${x}" y="${y + 65}" fill="${theme.ink}" text-anchor="middle" font-size="15">${labels[name] ?? name}</text>`;
    for (const [row, size] of [16, 24, 32].entries()) {
      proof += `<svg x="${x - size / 2}" y="${y + 82 + row * 38}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${theme.ink}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><title>${name}</title><path d="${d}"/></svg>`;
    }
  }
}
proof += `<text x="40" y="${logoY}" fill="#6E5A44" font-size="12" letter-spacing="2">APPLICATION LOGO / SCROLL, CHECKLIST &amp; ROYAL SEAL</text>`;
proof += `<svg x="34" y="${logoY + 18}" width="224" height="224" viewBox="0 0 512 512" fill="none">${logoBody}</svg>`;
proof += `<svg x="278" y="${logoY + 62}" width="148" height="148" viewBox="0 0 512 512" fill="none">${logoMark.replaceAll('id="', 'id="mark-').replaceAll("url(#", "url(#mark-")}</svg>`;
for (const [i, size] of [64, 32, 16].entries()) {
  const prefix = `small${size}-`;
  proof += `<svg x="${500 + i * 140}" y="${logoY + 98}" width="${size}" height="${size}" viewBox="0 0 512 512" fill="none">${logoBody.replaceAll('id="', `id="${prefix}`).replaceAll("url(#", `url(#${prefix}`)}</svg><text x="${500 + i * 140}" y="${logoY + 192}" fill="#6E5A44" font-size="14">${size} px</text>`;
}
proof += `<text x="40" y="${logoY + 271}" fill="#6E5A44" font-size="13">UI rows: 16 / 24 / 32 px. Logo exports: SVG, PNG, ICO, ICNS. Native icons generated with Tauri.</text></g></svg>`;
await writeFile(new URL("../preview.svg", root), proof);
