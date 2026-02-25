import { describe, expect, it, beforeAll } from "bun:test";
import { SEARCH_FIELD_NAMES, buildSearchIndex, searchRows } from "./search.js";
import type { Row } from "./data.js";

// ---------------------------------------------------------------------------
// Mock rows
// ---------------------------------------------------------------------------

const anthropicSonnet: Row = {
  providerId: "anthropic",
  providerName: "Anthropic",
  modelId: "claude-3-5-sonnet-20241022",
  name: "Claude 3.5 Sonnet",
  family: "claude-sonnet",
  reasoning: false,
  tool_call: true,
  attachment: true,
  open_weights: false,
  modalities: { input: ["text", "image"], output: ["text"] },
  cost: { input: 3.0, output: 15.0 },
  limit: { context: 200_000, output: 8_192 },
  release_date: "2024-10-22",
  last_updated: "2024-10-22",
};

const anthropicHaiku: Row = {
  providerId: "anthropic",
  providerName: "Anthropic",
  modelId: "claude-3-5-haiku-20241022",
  name: "Claude 3.5 Haiku",
  family: "claude-haiku",
  reasoning: false,
  tool_call: true,
  attachment: true,
  open_weights: false,
  modalities: { input: ["text", "image"], output: ["text"] },
  cost: { input: 0.8, output: 4.0 },
  limit: { context: 200_000, output: 8_192 },
  release_date: "2024-11-04",
  last_updated: "2024-11-04",
};

const openaiGpt4o: Row = {
  providerId: "openai",
  providerName: "OpenAI",
  modelId: "gpt-4o",
  name: "GPT-4o",
  family: "gpt-4o",
  reasoning: false,
  tool_call: true,
  attachment: true,
  open_weights: false,
  modalities: { input: ["text", "image"], output: ["text"] },
  cost: { input: 2.5, output: 10.0 },
  limit: { context: 128_000, output: 16_384 },
  release_date: "2024-05-13",
  last_updated: "2024-05-13",
};

const googleGemini: Row = {
  providerId: "google",
  providerName: "Google",
  modelId: "gemini-1.5-pro",
  name: "Gemini 1.5 Pro",
  family: "gemini-1.5",
  reasoning: false,
  tool_call: true,
  attachment: true,
  open_weights: false,
  modalities: { input: ["text", "image", "audio"], output: ["text"] },
  cost: { input: 1.25, output: 5.0 },
  limit: { context: 1_000_000, output: 8_192 },
  release_date: "2024-02-15",
  last_updated: "2024-02-15",
};

const MOCK_ROWS: Row[] = [anthropicSonnet, anthropicHaiku, openaiGpt4o, googleGemini];

// ---------------------------------------------------------------------------
// SEARCH_FIELD_NAMES
// ---------------------------------------------------------------------------

describe("SEARCH_FIELD_NAMES", () => {
  it("contains exactly the expected text fields", () => {
    expect(SEARCH_FIELD_NAMES).toEqual([
      "providerName",
      "name",
      "modelId",
      "providerId",
      "family",
    ]);
  });

  it("does NOT contain cost fields", () => {
    expect(SEARCH_FIELD_NAMES).not.toContain("cost");
    expect(SEARCH_FIELD_NAMES).not.toContain("input");
    expect(SEARCH_FIELD_NAMES).not.toContain("output");
  });

  it("does NOT contain boolean capability fields", () => {
    expect(SEARCH_FIELD_NAMES).not.toContain("reasoning");
    expect(SEARCH_FIELD_NAMES).not.toContain("tool_call");
    expect(SEARCH_FIELD_NAMES).not.toContain("attachment");
    expect(SEARCH_FIELD_NAMES).not.toContain("open_weights");
  });

  it("does NOT contain limit fields", () => {
    expect(SEARCH_FIELD_NAMES).not.toContain("limit");
    expect(SEARCH_FIELD_NAMES).not.toContain("context");
  });
});

// ---------------------------------------------------------------------------
// searchRows
// ---------------------------------------------------------------------------

describe("searchRows", () => {
  beforeAll(() => {
    buildSearchIndex(MOCK_ROWS);
  });

  it("returns null for empty query (show all)", () => {
    expect(searchRows("", MOCK_ROWS)).toBeNull();
  });

  it("returns null for whitespace-only query", () => {
    expect(searchRows("   ", MOCK_ROWS)).toBeNull();
  });

  it("exact match: 'claude' finds Claude models", () => {
    const results = searchRows("claude", MOCK_ROWS);
    expect(results).not.toBeNull();
    expect(results!.length).toBeGreaterThanOrEqual(1);
    expect(results!.every((r) => r.name.toLowerCase().includes("claude"))).toBe(true);
  });

  it("fuzzy match: 'claud' (typo) still finds Claude models", () => {
    const results = searchRows("claud", MOCK_ROWS);
    expect(results).not.toBeNull();
    expect(results!.length).toBeGreaterThanOrEqual(1);
    expect(results!.some((r) => r.name.toLowerCase().includes("claude"))).toBe(true);
  });

  it("prefix match: 'gem' finds Gemini models", () => {
    const results = searchRows("gem", MOCK_ROWS);
    expect(results).not.toBeNull();
    expect(results!.length).toBeGreaterThanOrEqual(1);
    expect(results!.some((r) => r.name.toLowerCase().includes("gemini"))).toBe(true);
  });

  it("provider search: 'anthropic' finds Anthropic models", () => {
    const results = searchRows("anthropic", MOCK_ROWS);
    expect(results).not.toBeNull();
    expect(results!.length).toBeGreaterThanOrEqual(1);
    expect(results!.every((r) => r.providerId === "anthropic")).toBe(true);
  });

  it("family search: 'gpt' finds GPT family models", () => {
    const results = searchRows("gpt", MOCK_ROWS);
    expect(results).not.toBeNull();
    expect(results!.length).toBeGreaterThanOrEqual(1);
    expect(results!.some((r) => r.family?.includes("gpt"))).toBe(true);
  });

  it("cost value NOT matched: '$15.00' returns empty array (cost not indexed)", () => {
    // Dollar-sign prefix can't appear in any indexed text field (providerName, name, modelId, providerId, family)
    const results = searchRows("$15.00", MOCK_ROWS);
    expect(results).not.toBeNull();
    expect(results!).toHaveLength(0);
  });

  it("boolean value NOT matched: 'true' returns empty array", () => {
    // 'true' does not appear in any indexed text field
    const results = searchRows("true", MOCK_ROWS);
    expect(results).not.toBeNull();
    expect(results!).toHaveLength(0);
  });

  it("comma-separated OR: 'claude, gpt' finds both Claude and GPT models", () => {
    const results = searchRows("claude, gpt", MOCK_ROWS);
    expect(results).not.toBeNull();
    const names = results!.map((r) => r.name);
    expect(names.some((n) => n.toLowerCase().includes("claude"))).toBe(true);
    expect(names.some((n) => n.toLowerCase().includes("gpt"))).toBe(true);
  });

  it("comma-separated OR: 'anthropic, google' finds models from both providers", () => {
    const results = searchRows("anthropic, google", MOCK_ROWS);
    expect(results).not.toBeNull();
    const providerIds = results!.map((r) => r.providerId);
    expect(providerIds).toContain("anthropic");
    expect(providerIds).toContain("google");
  });
});
