import { describe, expect, it } from "bun:test";
import {
  ALL_COLUMN_IDS,
  DEFAULT_COLUMN_IDS,
  parseUrlState,
  serializeUrlState,
} from "./url-state";

describe("parseUrlState", () => {
  it("returns empty defaults when no params", () => {
    const state = parseUrlState(new URLSearchParams(""));
    expect(state.search).toBe("");
    expect(state.sort).toBeNull();
    expect(state.order).toBe("asc");
    expect(state.cols).toEqual([...DEFAULT_COLUMN_IDS]);
  });

  it("parses search param", () => {
    const state = parseUrlState(new URLSearchParams("search=gpt"));
    expect(state.search).toBe("gpt");
  });

  it("parses sort and order", () => {
    const state = parseUrlState(
      new URLSearchParams("sort=input-cost&order=desc"),
    );
    expect(state.sort).toBe("input-cost");
    expect(state.order).toBe("desc");
  });

  it("parses cols param as array", () => {
    const state = parseUrlState(
      new URLSearchParams("cols=provider,model,input-cost"),
    );
    expect(state.cols).toEqual(["provider", "model", "input-cost"]);
  });

  it("explicit cols= in URL overrides defaults", () => {
    const state = parseUrlState(
      new URLSearchParams("cols=provider,model,reasoning-cost,weights"),
    );
    expect(state.cols).toEqual([
      "provider",
      "model",
      "reasoning-cost",
      "weights",
    ]);
    // Should NOT equal the defaults
    expect(state.cols).not.toEqual(DEFAULT_COLUMN_IDS);
  });
});

describe("serializeUrlState", () => {
  it("omits cols when matching defaults", () => {
    const params = serializeUrlState({
      search: "",
      sort: null,
      order: "asc",
      cols: [...DEFAULT_COLUMN_IDS],
    });
    expect(params.get("cols")).toBeNull();
  });

  it("includes cols when all columns visible (not default)", () => {
    const params = serializeUrlState({
      search: "",
      sort: null,
      order: "asc",
      cols: [...ALL_COLUMN_IDS],
    });
    expect(params.get("cols")).toBe(ALL_COLUMN_IDS.join(","));
  });

  it("includes cols when not all visible", () => {
    const params = serializeUrlState({
      search: "",
      sort: null,
      order: "asc",
      cols: ["provider", "model"],
    });
    expect(params.get("cols")).toBe("provider,model");
  });

  it("omits search when empty", () => {
    const params = serializeUrlState({
      search: "",
      sort: null,
      order: "asc",
      cols: [...DEFAULT_COLUMN_IDS],
    });
    expect(params.get("search")).toBeNull();
  });
});
