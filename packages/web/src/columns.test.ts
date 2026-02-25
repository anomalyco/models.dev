import { describe, expect, it } from "bun:test";
import {
  ALL_COLUMN_IDS,
  DEFAULT_COLUMN_IDS,
  parseUrlState,
} from "./url-state.js";

describe("DEFAULT_COLUMN_IDS", () => {
  it("has exactly 9 items", () => {
    expect(DEFAULT_COLUMN_IDS).toHaveLength(9);
  });

  it("contains the expected default columns", () => {
    expect(DEFAULT_COLUMN_IDS).toContain("provider");
    expect(DEFAULT_COLUMN_IDS).toContain("model");
    expect(DEFAULT_COLUMN_IDS).toContain("family");
    expect(DEFAULT_COLUMN_IDS).toContain("model-id");
    expect(DEFAULT_COLUMN_IDS).toContain("tool-call");
    expect(DEFAULT_COLUMN_IDS).toContain("reasoning");
    expect(DEFAULT_COLUMN_IDS).toContain("input-cost");
    expect(DEFAULT_COLUMN_IDS).toContain("output-cost");
    expect(DEFAULT_COLUMN_IDS).toContain("context-limit");
  });

  it("does NOT contain non-default columns", () => {
    expect(DEFAULT_COLUMN_IDS).not.toContain("provider-id");
    expect(DEFAULT_COLUMN_IDS).not.toContain("cache-read-cost");
    expect(DEFAULT_COLUMN_IDS).not.toContain("audio-input-cost");
    expect(DEFAULT_COLUMN_IDS).not.toContain("audio-output-cost");
    expect(DEFAULT_COLUMN_IDS).not.toContain("input-limit");
    expect(DEFAULT_COLUMN_IDS).not.toContain("output-limit");
    expect(DEFAULT_COLUMN_IDS).not.toContain("knowledge");
    expect(DEFAULT_COLUMN_IDS).not.toContain("release-date");
    expect(DEFAULT_COLUMN_IDS).not.toContain("last-updated");
  });

  it("all entries are valid column IDs (present in ALL_COLUMN_IDS)", () => {
    const allIds = [...ALL_COLUMN_IDS] as string[];
    for (const id of DEFAULT_COLUMN_IDS) {
      expect(allIds).toContain(id);
    }
  });
});

describe("column visibility via parseUrlState", () => {
  it("cols=provider,model returns exactly those 2 columns", () => {
    const state = parseUrlState(new URLSearchParams("cols=provider,model"));
    expect(state.cols).toEqual(["provider", "model"]);
    expect(state.cols).toHaveLength(2);
  });

  it("invalid column IDs in cols param are filtered out", () => {
    const state = parseUrlState(
      new URLSearchParams("cols=provider,not-a-real-column,model"),
    );
    expect(state.cols).toEqual(["provider", "model"]);
  });

  it("cols param with all invalid IDs falls back to defaults", () => {
    const state = parseUrlState(
      new URLSearchParams("cols=fake-col,another-fake"),
    );
    expect(state.cols).toEqual([...DEFAULT_COLUMN_IDS]);
  });

  it("no cols param returns DEFAULT_COLUMN_IDS", () => {
    const state = parseUrlState(new URLSearchParams(""));
    expect(state.cols).toEqual([...DEFAULT_COLUMN_IDS]);
  });
});
