import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const indexHtml = readFileSync(
  join(import.meta.dir, "..", "index.html"),
  "utf-8",
);

const indexCss = readFileSync(
  join(import.meta.dir, "..", "src", "index.css"),
  "utf-8",
);

describe("Viewport meta", () => {
  it("does not include user-scalable=no (WCAG 1.4.4 violation)", () => {
    expect(indexHtml).not.toContain("user-scalable=no");
  });

  it("includes width=device-width", () => {
    expect(indexHtml).toContain("width=device-width");
  });

  it("includes initial-scale=1", () => {
    expect(indexHtml).toContain("initial-scale=1");
  });
});

describe("CSS: search bar always accessible on mobile", () => {
  it("does not hide search-container at 45rem", () => {
    // The new CSS should hide GitHub but NOT search-container at 45rem
    const mediaBlock45 = indexCss.match(/@media \(max-width: 45rem\)[\s\S]*?(?=@media|\}$)/g)?.[0] ?? "";
    // search-container should NOT appear in display: none rules
    const hiddenElements = mediaBlock45.match(/display:\s*none/g) ?? [];
    // Check that search-container isn't in the 45rem hide block
    expect(mediaBlock45).not.toMatch(/\.search-container[\s\S]{0,50}display:\s*none/);
  });

  it("hides GitHub link at 45rem breakpoint", () => {
    expect(indexCss).toContain(".github");
    // At 45rem, .github should be hidden
    const media45 = indexCss.indexOf("@media (max-width: 45rem)");
    const nextMedia = indexCss.indexOf("@media", media45 + 1);
    const block = indexCss.substring(media45, nextMedia === -1 ? undefined : nextMedia);
    expect(block).toContain(".github");
    expect(block).toContain("display: none");
  });
});

describe("CSS: horizontal scroll wrapper", () => {
  it("has .table-scroll-wrapper with overflow-x: auto", () => {
    expect(indexCss).toContain(".table-scroll-wrapper");
    const wrapperIdx = indexCss.indexOf(".table-scroll-wrapper");
    const wrapperBlock = indexCss.substring(wrapperIdx, indexCss.indexOf("}", wrapperIdx) + 1);
    expect(wrapperBlock).toContain("overflow-x: auto");
  });

  it("has scroll shadow indicator", () => {
    expect(indexCss).toContain("radial-gradient");
    expect(indexCss).toContain("background-attachment: local, local, scroll, scroll");
  });
});
