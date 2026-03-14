import { describe, expect, it } from "bun:test";

/**
 * Pure filter logic extracted from index.ts for unit testing.
 * These functions replicate the row-visibility logic without any DOM dependency.
 */

interface MockRow {
  reasoning: boolean;
  tool_call: boolean;
  structured_output: boolean | undefined;
  open_weights: boolean;
  context: number;
  input_cost: number | undefined;
  status: string;
  text: string; // concatenated cell text for search
}

interface ActiveFilters {
  reasoning: string;
  tool_call: string;
  structured_output: string;
  open_weights: string;
  min_context: string;
  max_input_cost: string;
  status: string;
}

function isRowVisible(row: MockRow, filters: ActiveFilters, search: string): boolean {
  // Text search
  if (search.trim()) {
    const terms = search.toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
    const rowText = row.text.toLowerCase();
    if (!terms.some(term => rowText.includes(term))) return false;
  }

  // Boolean filters
  for (const key of ["reasoning", "tool_call", "structured_output", "open_weights"] as const) {
    const filterVal = filters[key];
    if (!filterVal) continue;
    const rowVal = row[key];
    if (rowVal === undefined) return false;
    if (String(rowVal) !== filterVal) return false;
  }

  // Min context
  if (filters.min_context) {
    if (row.context < parseInt(filters.min_context, 10)) return false;
  }

  // Max input cost
  if (filters.max_input_cost) {
    if (row.input_cost === undefined) return false;
    if (row.input_cost > parseFloat(filters.max_input_cost)) return false;
  }

  // Status
  if (filters.status === "active") {
    if (row.status === "deprecated") return false;
  } else if (filters.status === "deprecated") {
    if (row.status !== "deprecated") return false;
  }

  return true;
}

const defaultFilters: ActiveFilters = {
  reasoning: "",
  tool_call: "",
  structured_output: "",
  open_weights: "",
  min_context: "",
  max_input_cost: "",
  status: "active",
};

const gpt4o: MockRow = {
  reasoning: false,
  tool_call: true,
  structured_output: true,
  open_weights: false,
  context: 128000,
  input_cost: 2.5,
  status: "active",
  text: "openai gpt-4o GPT-4o gpt",
};

const o3mini: MockRow = {
  reasoning: true,
  tool_call: true,
  structured_output: true,
  open_weights: false,
  context: 200000,
  input_cost: 1.1,
  status: "active",
  text: "openai o3-mini o3-mini o-mini",
};

const llama: MockRow = {
  reasoning: false,
  tool_call: true,
  structured_output: false,
  open_weights: true,
  context: 128000,
  input_cost: 0.0,
  status: "active",
  text: "meta llama-3.1-8b Llama 3.1 8B llama",
};

const deprecated: MockRow = {
  reasoning: false,
  tool_call: false,
  structured_output: false,
  open_weights: false,
  context: 16385,
  input_cost: 0.5,
  status: "deprecated",
  text: "openai gpt-3.5-turbo GPT-3.5 gpt",
};

const noSO: MockRow = {
  reasoning: false,
  tool_call: true,
  structured_output: undefined, // not set
  open_weights: false,
  context: 32000,
  input_cost: 1.0,
  status: "active",
  text: "some-provider some-model",
};

describe("Filter: default (active status only)", () => {
  it("shows active models by default", () => {
    expect(isRowVisible(gpt4o, defaultFilters, "")).toBe(true);
    expect(isRowVisible(o3mini, defaultFilters, "")).toBe(true);
  });

  it("hides deprecated models by default", () => {
    expect(isRowVisible(deprecated, defaultFilters, "")).toBe(false);
  });
});

describe("Filter: status=all shows deprecated", () => {
  const allFilters: ActiveFilters = { ...defaultFilters, status: "" };

  it("shows deprecated models when status is all", () => {
    expect(isRowVisible(deprecated, allFilters, "")).toBe(true);
  });

  it("still shows active models when status is all", () => {
    expect(isRowVisible(gpt4o, allFilters, "")).toBe(true);
  });
});

describe("Filter: status=deprecated shows only deprecated", () => {
  const depFilters: ActiveFilters = { ...defaultFilters, status: "deprecated" };

  it("shows deprecated models", () => {
    expect(isRowVisible(deprecated, depFilters, "")).toBe(true);
  });

  it("hides active models", () => {
    expect(isRowVisible(gpt4o, depFilters, "")).toBe(false);
  });
});

describe("Filter: reasoning=true", () => {
  const reasoningFilters: ActiveFilters = { ...defaultFilters, reasoning: "true" };

  it("shows reasoning models", () => {
    expect(isRowVisible(o3mini, reasoningFilters, "")).toBe(true);
  });

  it("hides non-reasoning models", () => {
    expect(isRowVisible(gpt4o, reasoningFilters, "")).toBe(false);
    expect(isRowVisible(llama, reasoningFilters, "")).toBe(false);
  });
});

describe("Filter: open_weights=true", () => {
  const openFilters: ActiveFilters = { ...defaultFilters, open_weights: "true" };

  it("shows open-weight models", () => {
    expect(isRowVisible(llama, openFilters, "")).toBe(true);
  });

  it("hides closed models", () => {
    expect(isRowVisible(gpt4o, openFilters, "")).toBe(false);
  });
});

describe("Filter: min_context", () => {
  const largeContextFilters: ActiveFilters = { ...defaultFilters, min_context: "200000" };

  it("shows models with context >= min", () => {
    expect(isRowVisible(o3mini, largeContextFilters, "")).toBe(true); // 200K >= 200K
  });

  it("hides models with context < min", () => {
    expect(isRowVisible(gpt4o, largeContextFilters, "")).toBe(false); // 128K < 200K
    expect(isRowVisible(llama, largeContextFilters, "")).toBe(false); // 128K < 200K
  });
});

describe("Filter: max_input_cost", () => {
  const cheapFilters: ActiveFilters = { ...defaultFilters, max_input_cost: "1.5" };

  it("shows models with cost <= max", () => {
    expect(isRowVisible(o3mini, cheapFilters, "")).toBe(true); // $1.1 <= $1.5
    expect(isRowVisible(llama, cheapFilters, "")).toBe(true);  // $0.0 <= $1.5
  });

  it("hides models with cost > max", () => {
    expect(isRowVisible(gpt4o, cheapFilters, "")).toBe(false); // $2.5 > $1.5
  });

  it("hides models without pricing data", () => {
    const noCostRow: MockRow = { ...gpt4o, input_cost: undefined };
    expect(isRowVisible(noCostRow, cheapFilters, "")).toBe(false);
  });
});

describe("Filter: structured_output", () => {
  const soFilters: ActiveFilters = { ...defaultFilters, structured_output: "true" };

  it("shows models with structured_output=true", () => {
    expect(isRowVisible(gpt4o, soFilters, "")).toBe(true);
  });

  it("hides models without structured_output", () => {
    expect(isRowVisible(noSO, soFilters, "")).toBe(false); // undefined = not set
  });

  it("hides models with structured_output=false", () => {
    expect(isRowVisible(llama, soFilters, "")).toBe(false);
  });
});

describe("Filter: text search", () => {
  it("shows models matching search term", () => {
    expect(isRowVisible(gpt4o, defaultFilters, "gpt")).toBe(true);
    expect(isRowVisible(llama, defaultFilters, "llama")).toBe(true);
  });

  it("hides models not matching search term", () => {
    expect(isRowVisible(gpt4o, defaultFilters, "llama")).toBe(false);
    expect(isRowVisible(llama, defaultFilters, "gpt")).toBe(false);
  });

  it("supports comma-separated multi-term (OR logic)", () => {
    expect(isRowVisible(gpt4o, defaultFilters, "gpt,llama")).toBe(true);
    expect(isRowVisible(llama, defaultFilters, "gpt,llama")).toBe(true);
    expect(isRowVisible(o3mini, defaultFilters, "gpt,llama")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isRowVisible(gpt4o, defaultFilters, "GPT")).toBe(true);
    expect(isRowVisible(gpt4o, defaultFilters, "OpenAI")).toBe(true);
  });
});

describe("Filter: combined filters", () => {
  it("AND logic: reasoning+min_context", () => {
    const combined: ActiveFilters = { ...defaultFilters, reasoning: "true", min_context: "150000" };
    expect(isRowVisible(o3mini, combined, "")).toBe(true); // reasoning=true, 200K >= 150K
    expect(isRowVisible(gpt4o, combined, "")).toBe(false); // reasoning=false
    expect(isRowVisible(llama, combined, "")).toBe(false); // reasoning=false
  });

  it("AND logic: search+status filter", () => {
    const allStatus: ActiveFilters = { ...defaultFilters, status: "" };
    // deprecated gpt-3.5 matches "gpt" search and status=all
    expect(isRowVisible(deprecated, allStatus, "gpt")).toBe(true);
    // deprecated gpt-3.5 doesn't match "llama" search
    expect(isRowVisible(deprecated, allStatus, "llama")).toBe(false);
  });
});
