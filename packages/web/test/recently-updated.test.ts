import { describe, expect, it } from "bun:test";

// ── Pure date helpers extracted for testing ───────────────────────────────────

function daysSince(dateStr: string, fromDate: Date = new Date()): number {
  const d = new Date(dateStr.length === 7 ? `${dateStr}-01` : dateStr);
  return Math.floor((fromDate.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function isNew(releaseDate: string, fromDate: Date, recentDays = 14): boolean {
  return daysSince(releaseDate, fromDate) <= recentDays;
}

function isRecentlyUpdated(
  releaseDate: string,
  lastUpdated: string,
  fromDate: Date,
  recentDays = 14,
): boolean {
  return !isNew(releaseDate, fromDate, recentDays) && daysSince(lastUpdated, fromDate) <= recentDays;
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TODAY = new Date("2026-03-14");

describe("daysSince", () => {
  it("returns 0 for today", () => {
    expect(daysSince("2026-03-14", TODAY)).toBe(0);
  });

  it("returns 1 for yesterday", () => {
    expect(daysSince("2026-03-13", TODAY)).toBe(1);
  });

  it("returns 14 for exactly 14 days ago", () => {
    expect(daysSince("2026-02-28", TODAY)).toBe(14);
  });

  it("returns 15 for 15 days ago", () => {
    expect(daysSince("2026-02-27", TODAY)).toBe(15);
  });

  it("handles YYYY-MM format (treats as first of month)", () => {
    // "2026-03" = March 1, 2026; from March 14 = 13 days
    expect(daysSince("2026-03", TODAY)).toBe(13);
  });

  it("handles YYYY-MM-DD format", () => {
    expect(daysSince("2026-03-14", TODAY)).toBe(0);
    expect(daysSince("2026-01-01", TODAY)).toBe(72);
  });

  it("returns positive value for past dates", () => {
    expect(daysSince("2024-01-01", TODAY)).toBeGreaterThan(0);
  });
});

describe("isNew detection", () => {
  it("marks model as new if released within 14 days", () => {
    expect(isNew("2026-03-14", TODAY)).toBe(true); // today
    expect(isNew("2026-03-10", TODAY)).toBe(true); // 4 days ago
    expect(isNew("2026-02-28", TODAY)).toBe(true); // exactly 14 days ago
  });

  it("does not mark model as new if released more than 14 days ago", () => {
    expect(isNew("2026-02-27", TODAY)).toBe(false); // 15 days ago
    expect(isNew("2025-01-01", TODAY)).toBe(false); // over a year ago
  });

  it("respects custom recentDays threshold", () => {
    expect(isNew("2026-03-07", TODAY, 7)).toBe(true); // 7 days ago, threshold=7
    expect(isNew("2026-03-06", TODAY, 7)).toBe(false); // 8 days ago, threshold=7
  });
});

describe("isRecentlyUpdated detection", () => {
  it("marks model as updated if last_updated within 14 days but not new", () => {
    // Old model, updated recently
    expect(isRecentlyUpdated("2024-01-01", "2026-03-10", TODAY)).toBe(true);
  });

  it("does not mark new model as updated (isNew takes priority)", () => {
    // Both release_date and last_updated are recent
    expect(isRecentlyUpdated("2026-03-14", "2026-03-14", TODAY)).toBe(false);
  });

  it("does not mark old model as updated if last_updated is also old", () => {
    expect(isRecentlyUpdated("2024-01-01", "2024-06-01", TODAY)).toBe(false);
  });

  it("edge case: 14-day release is new, so updated=false", () => {
    // Released exactly 14 days ago = isNew=true, so isRecentlyUpdated=false
    expect(isRecentlyUpdated("2026-02-28", "2026-02-28", TODAY)).toBe(false);
  });

  it("edge case: 15-day-old release updated 10 days ago = updated", () => {
    expect(isRecentlyUpdated("2026-02-27", "2026-03-04", TODAY)).toBe(true);
  });
});
