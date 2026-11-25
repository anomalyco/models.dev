import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildDeepSeekModel, deepseekEntries, parseDeepSeekPricing } from "../src/sync/providers/deepseek.js";

const table = (pro: [string, string]) => [
  "| MODEL | MODEL | MODEL | deepseek-flash(1) | deepseek-v4-pro |",
  "| --- | --- | --- | --- | --- |",
  "| PRICING(2) | 1M INPUT TOKENS / (CACHE HIT) | OFF-PEAK | $0.003 | $0.022 |",
  "| PRICING(2) | 1M INPUT TOKENS / (CACHE HIT) | PEAK | $0.006 | $0.044 |",
  "| PRICING(2) | 1M INPUT TOKENS / (CACHE MISS) | OFF-PEAK | $0.15 | " + pro[0] + " |",
  "| PRICING(2) | 1M INPUT TOKENS / (CACHE MISS) | PEAK | $0.3 | " + pro[1] + " |",
  "| PRICING(2) | 1M OUTPUT TOKENS | OFF-PEAK | $0.6 | $1.98 |",
  "| PRICING(2) | 1M OUTPUT TOKENS | PEAK | $1.2 | $3.96 |",
  "",
  "(1) Use `deepseek-flash` as the model name. The legacy names `deepseek-v4-flash` and `deepseek-chat` are still accepted, billed at this price.",
].join("\n");

test("DeepSeek reads off-peak prices and legacy names from the pricing table", () => {
  const { prices, aliases } = parseDeepSeekPricing(table(["$0.66", "$1.32"]));
  expect(prices.get("deepseek-v4-pro")).toEqual({ input: 0.66, output: 1.98, cacheRead: 0.022 });
  expect(aliases.get("deepseek-v4-flash")).toBe("deepseek-flash");
});

test("DeepSeek refuses a peak price that isn't twice off-peak", () => {
  expect(() => parseDeepSeekPricing(table(["$0.66", "$1.50"]))).toThrow();
});

test("DeepSeek legacy names take their target's prices and limits, and only prices and limits change", () => {
  const entries = deepseekEntries([{ id: "deepseek-flash", context_window: 1_048_576, max_output_tokens: 393_216 }], table(["$0.66", "$1.32"]));
  const alias = entries.find((entry) => entry.id === "deepseek-v4-flash")!;
  expect(alias.price).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003 });
  const authored = { base_model: "deepseek/x", cost: { input: 1, output: 1, reasoning: 1 }, limit: { context: 1, output: 1 } } as unknown as ExistingModel;
  const built = buildDeepSeekModel(alias, authored) as unknown as ExistingModel;
  expect(built.cost).toEqual({ input: 0.15, output: 0.6, cache_read: 0.003, reasoning: 0.6 });
  expect(built.limit).toEqual({ context: 1_048_576, output: 393_216 });
});
