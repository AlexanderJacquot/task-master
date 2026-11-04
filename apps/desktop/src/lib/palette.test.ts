import { describe, expect, it } from "vitest";
import { type PaletteItem, rankItems, score } from "./palette";

const item = (key: string, group: PaletteItem["group"], label: string, keywords?: string) => ({
  key,
  group,
  label,
  keywords,
});

describe("palette", () => {
  it("matches word starts, keywords and inner text of 3+ letters", () => {
    expect(score(item("a", "Actions", "Plan my day", "today pick"), "plan")).not.toBeNull();
    expect(score(item("a", "Actions", "Plan my day", "today pick"), "pick")).not.toBeNull();
    expect(score(item("p", "Projects", "Homelab"), "lab")).not.toBeNull();
    expect(score(item("p", "Projects", "Homelab"), "la")).toBeNull();
    expect(score(item("p", "Projects", "Perso / Admin"), "per adm")).not.toBeNull();
    expect(score(item("p", "Projects", "Perso / Admin"), "per xyz")).toBeNull();
  });

  it("ranks exact and prefix matches first, keeps group order and limits", () => {
    const items = [
      item("t1", "Tasks", "Home insurance"),
      item("p1", "Projects", "Old homelab"),
      item("p2", "Projects", "Home"),
      item("v1", "Views", "Homework"),
    ];
    const ranked = rankItems(items, "home", { searchHits: new Set(["t1"]) });
    expect(ranked.map((r) => r.key)).toEqual(["v1", "p2", "p1", "t1"]);
    expect(rankItems(items, "", { limitPerGroup: 1 }).map((r) => r.key)).toEqual([
      "v1",
      "p1",
      "t1",
    ]);
  });

  it("keeps full-text hits even when the title does not match", () => {
    const items = [item("t1", "Tasks", "Renew passport")];
    expect(rankItems(items, "photo booth", { searchHits: new Set(["t1"]) })).toHaveLength(1);
    expect(rankItems(items, "photo booth")).toHaveLength(0);
  });
});
