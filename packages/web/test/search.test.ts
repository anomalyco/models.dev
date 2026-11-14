import { expect, test } from "bun:test";
import { rankSearchItems, normalizeSearchText, type SearchIndexItem } from "../src/search";
const item = (title: string, id: string, extra: Partial<SearchIndexItem> = {}): SearchIndexItem =>
  ({ title, id, type: "model", href: "/", logo: "", tokens: [], ...extra });
const fixtures = [
  item("Gemini 2.5 Flash", "google/gemini-2.5-flash"),
  item("Gemini 2.5 Flash-Lite", "google/gemini-2.5-flash-lite", { releaseDate: "2027-01-01" }),
  item("GLM-4.5-Flash", "zhipuai/glm-4.5-flash", { tokens: ["2025-02-05", "Gemini 2.5 Flash"] }),
  item("MiniMax", "minimax", { type: "lab", tokens: ["Gemini 2.5 Flash"] }),
  item("Nano Banana", "google/gemini-2.5-flash-image"),
];
test("decimal versions survive normalization", () => {
  expect(normalizeSearchText("Gemini-2.5-Flash")).toBe("gemini 2.5 flash");
});
test("versions cannot match metadata or a different version", () => {
  const results = rankSearchItems(fixtures, "2.5 flash");
  expect(results.map(r => r.item.id)).not.toContain("zhipuai/glm-4.5-flash");
  expect(results.map(r => r.item.id)).not.toContain("minimax");
  expect(results[0].item.id).toBe("google/gemini-2.5-flash");
});
test("requested variants and canonical IDs rank first", () => {
  expect(rankSearchItems(fixtures, "2.5 flash lite")[0].item.id).toEndWith("flash-lite");
  expect(rankSearchItems(fixtures, "gemini 2.5 flash image")[0].item.id).toEndWith("flash-image");
});
test("unknown numeric versions do not fuzzy match", () => {
  expect(rankSearchItems(fixtures, "gemini 9.9 flash")).toEqual([]);
});
test("bounded typos and transpositions work", () => {
  expect(rankSearchItems(fixtures, "gemni 2.5 flsh")[0].item.id).toEndWith("2.5-flash");
  expect(rankSearchItems([item("Claude Sonnet 4.6", "anthropic/claude-sonnet-4-6")], "cluade sonnet 4.6")).toHaveLength(1);
});
test("spaces in provider names are accepted", () => {
  expect(rankSearchItems([item("OpenRouter", "openrouter", { type: "provider" })], "open router")).toHaveLength(1);
});
