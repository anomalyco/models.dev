import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildBedrockModel, matchModels, normalize, offerPrices, parseUsageType, type BedrockModel } from "../src/sync/providers/amazon-bedrock.js";

test("Bedrock reads token kind, TTL, long context, route and tier from a usage type", () => {
  expect(parseUsageType("USE1-MP:USE1_cache_write_tokens_1h_long_ctx_global_standard-Units")).toEqual({
    kind: "cache_write", ttl: "1h", longContext: true, global: true, tier: "standard",
  });
  expect(parseUsageType("USE1-MP:USE1_input_tokens_ultrafast-Units")).toEqual({
    kind: "input", longContext: false, global: false, tier: "ultrafast",
  });
  expect(parseUsageType("USE1-ProvisionedThroughput")).toBeUndefined();
});

const offer = {
  products: Object.fromEntries([
    ["A", "input_tokens_standard"], ["B", "input_tokens_global_standard"], ["C", "output_tokens_standard"],
    ["D", "output_tokens_global_standard"], ["E", "cache_read_tokens_standard"], ["F", "input_tokens_ultrafast"],
    ["G", "input_tokens_long_ctx_standard"], ["H", "output_tokens_long_ctx_standard"],
  ].map(([sku, usage]) => [sku, { sku, attributes: { model: "OpenAI GPT-6.1 Sol", usagetype: `USE1-MP:USE1_${usage}-Units` } }])),
  terms: { OnDemand: Object.fromEntries(Object.entries({ A: 2.2, B: 2, C: 11, D: 10, E: 0.11, F: 13.2, G: 4.4, H: 16.5 })
    .map(([sku, usd]) => [sku, { t: { priceDimensions: { d: { unit: "1M tokens", pricePerUnit: { USD: String(usd) } } } } }])) },
};

test("Bedrock matches an AWS model name to the local files of its lab model", () => {
  const files = [{ id: "openai.gpt-6.1-sol", name: "gpt-6.1 sol" }, { id: "global.openai.gpt-6.1-sol", name: "gpt-6.1 sol" }];
  expect(matchModels(offerPrices(offer), files).map((model) => [model.id, model.global])).toEqual([
    ["openai.gpt-6.1-sol", false],
    ["global.openai.gpt-6.1-sol", true],
  ]);
});

test("Bedrock updates standard-tier prices for the file's route and keeps the rest", () => {
  const rows = offerPrices(offer).get("OpenAI GPT-6.1 Sol")!;
  const authored = {
    base_model: "openai/gpt-6.1-sol",
    cost: { input: 1, output: 1, cache_read: 1, tiers: [{ tier: { type: "context", size: 272_000 }, input: 1, output: 1 }] },
  } as unknown as ExistingModel;
  const regional = buildBedrockModel({ id: "openai.gpt-6.1-sol", name: "", global: false, prices: rows } as BedrockModel, authored) as unknown as ExistingModel;
  expect(regional.cost).toEqual({
    input: 2.2, output: 11, cache_read: 0.11,
    tiers: [{ tier: { type: "context", size: 272_000 }, input: 4.4, output: 16.5 }],
  });
  const global = buildBedrockModel({ id: "global.openai.gpt-6.1-sol", name: "", global: true, prices: rows } as BedrockModel, authored) as unknown as ExistingModel;
  expect(global.cost?.input).toBe(2);
  expect(global.cost?.output).toBe(10);
});

test("Bedrock reads Amazon-sold usage types, with the model ID when they carry one", () => {
  expect(parseUsageType("USE1-moonshotai.kimi-k3-mantle-cache-write-tokens-30m-global-standard")).toEqual({
    usageID: "moonshotai.kimi-k3", mantle: true, kind: "cache_write", ttl: "30m", longContext: false, global: true, tier: "standard",
  });
  expect(parseUsageType("USE1-Llama3-3-70B-input-tokens")).toEqual({
    mantle: false, kind: "input", longContext: false, global: false, tier: "standard",
  });
  expect(parseUsageType("USE1-NovaPro-cache-read-input-token-count")).toMatchObject({ kind: "cache_read", tier: "standard" });
  expect(parseUsageType("USE1-NovaPro-input-tokens-custom-model")).toBeUndefined();
  expect(parseUsageType("USE1-NovaPro-input-video-token-count-flex")).toBeUndefined();
});

test("Bedrock prefers rows that name the file's model ID over a name match", () => {
  const prices = new Map([["Kimi K3", [
    { usageID: "moonshotai.kimi-k3", mantle: true, kind: "input" as const, longContext: false, global: false, tier: "standard", usd: 3.3 },
  ]]]);
  expect(matchModels(prices, [{ id: "moonshotai.kimi-k3", name: "something else" }]).map((model) => model.id)).toEqual(["moonshotai.kimi-k3"]);
  expect(matchModels(prices, [{ id: "moonshot.kimi-k3-v1:0", name: "kimi k3" }])).toEqual([]);
});

test("Bedrock reads the older marketplace TokenCount usage types", () => {
  expect(parseUsageType("USE1-MP:USE1_CacheWrite1hInputTokenCount_Global-Units")).toEqual({
    kind: "cache_write", ttl: "1h", longContext: false, global: true, tier: "standard",
  });
  expect(parseUsageType("USE1-MP:USE1_InputTokenCount-Units")).toMatchObject({ kind: "input", global: false });
  expect(parseUsageType("USE1-MP:USE1_outputTokenCount_Global-Units")).toMatchObject({ kind: "output", global: true });
  expect(parseUsageType("USE1-MP:USE1_InputTokenCount_Global_Batch-Units")).toBeUndefined();
  expect(parseUsageType("USE1-MP:USE1_InputTokenCount_LatencyOptimized-Units")).toBeUndefined();
});

test("Bedrock compares AWS and lab names without punctuation, instruct, .0 or vendor prefixes", () => {
  expect(normalize("Qwen3 Coder 30B A3B")).toBe(normalize("qwen3-coder 30b-a3b instruct"));
  expect(normalize("Nova 2.0 Lite")).toBe(normalize("Nova 2 Lite"));
  expect(normalize("R1")).toBe(normalize("DeepSeek-R1"));
  expect(normalize("Pixtral Large 25.02")).toBe(normalize("Pixtral Large (25.02)"));
  expect(normalize("Llama 3.3 70B")).toBe(normalize("llama-3.3-70b-instruct"));
});
