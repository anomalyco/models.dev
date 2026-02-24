import { describe, it, expect } from "bun:test";
import { parseUrlState, serializeUrlState, ALL_COLUMN_IDS } from "./url-state";

describe("parseUrlState", () => {
  it("returns empty defaults when no params", () => {
    const state = parseUrlState(new URLSearchParams(""));
    expect(state.search).toBe("");
    expect(state.sort).toBeNull();
    expect(state.order).toBe("asc");
    expect(state.cols).toEqual([...ALL_COLUMN_IDS]);
  });

  it("parses search param", () => {
    const state = parseUrlState(new URLSearchParams("search=gpt"));
    expect(state.search).toBe("gpt");
  });

  it("parses sort and order", () => {
    const state = parseUrlState(new URLSearchParams("sort=input-cost&order=desc"));
    expect(state.sort).toBe("input-cost");
    expect(state.order).toBe("desc");
  });

  it("parses cols param as array", () => {
    const state = parseUrlState(new URLSearchParams("cols=provider,model,input-cost"));
    expect(state.cols).toEqual(["provider", "model", "input-cost"]);
  });
});

describe("serializeUrlState", () => {
  it("omits cols when all visible", () => {
    const params = serializeUrlState({
      search: "",
      sort: null,
      order: "asc",
      cols: [...ALL_COLUMN_IDS],
    });
    expect(params.get("cols")).toBeNull();
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
      cols: [...ALL_COLUMN_IDS],
    });
    expect(params.get("search")).toBeNull();
  });
});
