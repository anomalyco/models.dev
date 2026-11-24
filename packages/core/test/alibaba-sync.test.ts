import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, type ExistingModel } from "../src/sync/index.js";
import {
  alibaba,
  buildAlibabaModel,
  explicitCacheV2Set,
  flatPrice,
  limitNotices,
  offPeakFactor,
  readPrice,
  translateAlibabaModel,
  declaresImplicitCache,
  type AlibabaModel,
  type AlibabaPrice,
} from "../src/sync/providers/alibaba.js";

const row = (type: string, price: string, time_band: string | null = "standard") => ({ type, price, price_unit: "Per 1M tokens", time_band });

test("Alibaba reads a flat standard price and skips tiers and time bands", () => {
  expect(flatPrice({ model: "qwen4-max", prices: [{ range_name: "Default", prices: [row("input_token", "1.5"), row("output_token", "4.5")] }] } as AlibabaModel))
    .toEqual({ input: 1.5, output: 4.5, bands: [] });
  expect(flatPrice({ model: "x", prices: [{ range_name: "a", prices: [] }, { range_name: "b", prices: [] }] } as AlibabaModel)).toBeUndefined();
  expect(flatPrice({ model: "x", prices: [{ range_name: "Default", prices: [row("input_token", "1", "peak"), row("output_token", "2", "peak")] }] } as AlibabaModel)).toBeUndefined();
});

test("Alibaba keeps a file price that rounds to the listed one", () => {
  const authored = { base_model: "alibaba/x", cost: { input: 0.0625, output: 1, cache_read: 0.01 } } as unknown as ExistingModel;
  const built = buildAlibabaModel({ input: 0.063, output: 2, bands: [] }, authored) as unknown as ExistingModel;
  expect(built.cost).toEqual({ input: 0.0625, output: 2, cache_read: 0.01 });
  // A whole-number listed price is exact to three decimals too, so 2.5 doesn't pass for 3.
  expect((buildAlibabaModel({ input: 3, output: 2, bands: [] }, authored) as unknown as ExistingModel).cost?.input).toBe(3);
});

test("Alibaba updates context bands only where the file has one at the same threshold", () => {
  const model = { model: "qwen3.6-plus", prices: [
    { range_name: "Input<=256k", prices: [row("input_token", "0.5"), row("output_token", "3")] },
    { range_name: "256k<Input<=1m", prices: [row("input_token", "2"), row("output_token", "6")] },
  ] } as AlibabaModel;
  const price = flatPrice(model)!;
  expect(price.bands).toEqual([{ above: 256_000, input: 2, output: 6 }]);
  const banded = { cost: { input: 1, output: 1, tiers: [{ tier: { type: "context", size: 256_000 }, input: 1, output: 1 }] } } as unknown as ExistingModel;
  expect((buildAlibabaModel(price, banded) as unknown as ExistingModel).cost?.tiers?.[0]).toMatchObject({ input: 2, output: 6 });
  expect(buildAlibabaModel(price, { cost: { input: 1, output: 1 } } as unknown as ExistingModel)).toBeUndefined();
});

test("Alibaba reads implicit and explicit cache rows per band", () => {
  const model = { model: "qwen-plus", prices: [
    { range_name: "Input<=256k", prices: [row("input_token", "0.4"), row("output_token", "1.2"), row("input_token_cache", "0.08"), row("input_token_cache_read", "0.04"), row("input_token_cache_creation_5m", "0.5"), row("input_token_batch", "0.2")] },
    { range_name: "256k<Input<=1m", prices: [row("input_token", "1.2"), row("output_token", "3.6"), row("input_token_cache", "0.24"), row("input_token_cache_creation_5m", "1.5")] },
  ] } as AlibabaModel;
  expect(flatPrice(model)).toEqual({
    input: 0.4, output: 1.2, cacheRead: 0.08, explicitRead: 0.04, explicitWrite: { "5m": 0.5 },
    bands: [{ above: 256_000, input: 1.2, output: 3.6, cacheRead: 0.24, explicitWrite: { "5m": 1.5 } }],
  });
  const authored = { cost: { input: 0.4, output: 1.2, tiers: [{ tier: { type: "context", size: 256_000 }, input: 1.2, output: 3.6, cache_read: 0.2 }] } } as unknown as ExistingModel;
  const built = buildAlibabaModel(flatPrice(model)!, authored) as unknown as ExistingModel;
  expect(built.cost?.cache_read).toBe(0.08);
  expect(built.cost?.tiers?.[0]?.cache_read).toBe(0.24);
});

test("Alibaba patches only the explicit cache keys the file has", () => {
  const price: AlibabaPrice = { input: 1.5, output: 4.5, explicitRead: 0.075, explicitWrite: { "5m": 1.875, "1h": 3 }, bands: [{ above: 256_000, input: 2, output: 6, explicitRead: 0.2, explicitWrite: { "5m": 2.5 } }] };
  const set = explicitCacheV2Set(price);
  const explicit = set["cost.text.input.cache.explicit"] as (value: unknown) => unknown;
  expect(explicit({ read: 0.1, write: { "5m": 2, "1h": 4 } })).toEqual({ read: 0.075, write: { "5m": 1.875, "1h": 3 } });
  expect(explicit({ write: 2 })).toEqual({ write: 1.875 });
  expect(explicit(undefined)).toBeUndefined();
  const overrides = set["cost.text.input.overrides"] as (value: unknown) => unknown;
  expect(overrides([{ when: { context: { gt: 256_000 } }, price: 2, cache: { read: 0.4, explicit: { write: 3 } } }, { when: { context: { gt: 32_000 } }, price: 1 }]))
    .toEqual([{ when: { context: { gt: 256_000 } }, price: 2, cache: { read: 0.4, explicit: { write: 2.5 } } }, { when: { context: { gt: 32_000 } }, price: 1 }]);
  expect(overrides(undefined)).toBeUndefined();
});

test("Alibaba prices peak/off-peak models only when the file has the off-peak multiplier", () => {
  const model = { model: "deepseek-v4.1-flash", prices: [{ range_name: "Default", prices: [
    row("input_token", "0.15", "offpeak"), row("input_token", "0.3", "peak"),
    row("output_token", "0.6", "offpeak"), row("output_token", "1.2", "peak"),
    row("input_token_cache", "0.003", "offpeak"), row("input_token_cache", "0.006", "peak"),
  ] }] } as AlibabaModel;
  expect(readPrice(model)).toEqual({ skip: "peak/off-peak prices without an off-peak multiplier in the file" });
  expect(readPrice(model, 0.5)).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.006, bands: [] });
  expect(readPrice(model, 0.4)).toMatchObject({ skip: expect.stringContaining("off-peak input_token 0.15") });
  expect(offPeakFactor({ cost: { multipliers: [{ when: { utc_hours: { gte: "14:00" } }, factor: { text: 0.5 } }] } })).toBe(0.5);
  expect(offPeakFactor({ cost: { multipliers: [{ when: { utc_hours: { gte: "14:00" } }, factor: 0.5 }] } })).toBe(0.5);
  expect(offPeakFactor({ cost: { multipliers: [{ when: { service_tier: { equals: "fast" } }, factor: 2 }] } })).toBeUndefined();
});

test("Alibaba marks a model with an offline date deprecated", () => {
  const model = {
    model: "qwen3.5-plus",
    prices: [{ range_name: "Default", prices: [row("input_token", "0.4"), row("output_token", "2.4")] }],
    inference_offline_info: { offline_time: "2027-01-19 10:00:00" },
  } as AlibabaModel;
  const authored = { cost: { input: 0.4, output: 2.4 } } as unknown as ExistingModel;
  const context = { authored: () => authored, existing: () => authored };
  const translated = translateAlibabaModel(model, context)!;
  expect(translated.model).toMatchObject({ status: "deprecated", cost: { input: 0.4, output: 2.4 } });
  expect(translated.notices).toEqual(["Alibaba qwen3.5-plus: catalog offline_time 2027-01-19 10:00:00; marked deprecated"]);
  // Already deprecated: no notice, and a model without a readable price still gets the status.
  const deprecated = { ...authored, status: "deprecated" } as unknown as ExistingModel;
  expect(translateAlibabaModel(model, { authored: () => deprecated, existing: () => deprecated })?.notices).toBeUndefined();
  const video = { model: "wan2.6-i2v", prices: [], inference_offline_info: { offline_time: "2027-01-19 10:00:00" } } as unknown as AlibabaModel;
  expect(translateAlibabaModel(video, context)?.model).toMatchObject({ status: "deprecated" });
  expect(translateAlibabaModel({ ...video, inference_offline_info: null } as AlibabaModel, context)).toBeUndefined();
});

test("Alibaba reports catalog limits that differ from the file without changing them", () => {
  const model = {
    model: "kimi-k2.7-code",
    prices: [{ range_name: "Default", prices: [row("input_token", "0.95"), row("output_token", "4")] }],
    model_info: { context_window: 262_144, max_input_tokens: 229_376, max_output_tokens: 16_384, reasoning_max_output_tokens: null },
  } as AlibabaModel;
  const resolved = { limit: { context: 262_144, output: 262_144 }, cost: { input: 0.95, output: 4 } } as unknown as ExistingModel;
  expect(limitNotices(model, resolved)).toEqual(["Alibaba kimi-k2.7-code: catalog max_output_tokens 16384, file limit.output 262144"]);
  const translated = translateAlibabaModel(model, { authored: () => resolved, existing: () => resolved })!;
  expect((translated.model as unknown as ExistingModel).limit).toEqual({ context: 262_144, output: 262_144 });
  // Either mode's output cap matches, and media models without limits report nothing.
  const thinking = { ...model, model_info: { context_window: 1_000_000, max_input_tokens: 991_808, max_output_tokens: 131_072, reasoning_max_output_tokens: 262_144 } } as AlibabaModel;
  expect(limitNotices(thinking, { limit: { context: 1_000_000, output: 262_144 } } as unknown as ExistingModel)).toEqual([]);
  expect(limitNotices({ ...model, model_info: { context_window: null, max_output_tokens: null } } as AlibabaModel, resolved)).toEqual([]);
});

test("Alibaba writes the implicit cache read only when the file declares implicit caching", () => {
  const model = { model: "qwen3.6-plus", prices: [{ range_name: "Default", prices: [row("input_token", "0.5"), row("output_token", "3"), row("input_token_cache", "0.12")] }] } as AlibabaModel;
  const authored = { cost: { input: 0.5, output: 3, cache_read: 0.05 } } as unknown as ExistingModel;
  const explicitOnly = { capabilities: { cache: { explicit: { ttl: ["5m"] } } } };
  const implicit = { capabilities: { cache: { implicit: { min_tokens: 1_024 } } } };
  expect(declaresImplicitCache(explicitOnly)).toBe(false);
  expect(declaresImplicitCache(implicit)).toBe(true);
  const skipped = translateAlibabaModel(model, { authored: () => authored, existing: () => authored, v2: () => explicitOnly })!;
  expect((skipped.model as unknown as ExistingModel).cost?.cache_read).toBe(0.05);
  expect(skipped.notices).toEqual(["Alibaba qwen3.6-plus: catalog lists an implicit cache price but the file doesn't declare implicit caching; left unchanged"]);
  const written = translateAlibabaModel(model, { authored: () => authored, existing: () => authored, v2: () => implicit })!;
  expect((written.model as unknown as ExistingModel).cost?.cache_read).toBe(0.12);
  expect(written.notices).toBeUndefined();
});

const explicitFile = `schema = 2
name = "Qwen Test"
description = "Test model"
open_weights = false
release_date = "2026-01-01"

[modalities]
input = ["text"]
output = ["text"]

[capabilities]
tools = { supported = true }
reasoning = { supported = false }
temperature = true
top_p = true
top_k = true
cache = { implicit = { min_tokens = 1_024 }, explicit = { ttl = ["5m", "1h"], max_breakpoints = 4, targets = ["system", "messages"], min_tokens = 1_024 } }

[limit]
context = 1_000_000
output = 65_536

[cost.text.input]
price = 1
cache = { read = 0.2, explicit = { read = 0.1, write = { "5m" = 1.25, "1h" = 2 } } }

[[cost.text.input.overrides]]
when = { context = { gt = 256_000 } }
price = 2
cache = { read = 0.4, explicit = { write = 2.5 } }

[cost.text.output]
price = 4

[[cost.text.output.overrides]]
when = { context = { gt = 256_000 } }
price = 8
`;

test("Alibaba writes drifted explicit cache prices through the sync runner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-alibaba-explicit-"));
  try {
    await Bun.write(path.join(dir, "qwen-test.toml"), explicitFile);
    const catalog = [{ model: "qwen-test", prices: [
      { range_name: "Input<=256k", prices: [row("input_token", "1"), row("output_token", "4"), row("input_token_cache", "0.2"), row("input_token_cache_read", "0.12"), row("input_token_cache_creation_5m", "1.5"), row("input_token_cache_creation_1h", "2.4")] },
      { range_name: "256k<Input<=1m", prices: [row("input_token", "2"), row("output_token", "8"), row("input_token_cache", "0.4"), row("input_token_cache_creation_5m", "3")] },
    ] }];
    const result = await syncProvider({ ...alibaba, modelsDir: dir, async fetchModels() { return catalog; } });
    expect(result.notices.filter((notice) => notice.includes("Could not write"))).toEqual([]);
    expect(result.updated).toBe(1);
    const written = Bun.TOML.parse(await Bun.file(path.join(dir, "qwen-test.toml")).text()) as any;
    expect(written.cost.text.input.cache).toEqual({ read: 0.2, explicit: { read: 0.12, write: { "5m": 1.5, "1h": 2.4 } } });
    expect(written.cost.text.input.overrides[0].cache).toEqual({ read: 0.4, explicit: { write: 3 } });
    const again = await syncProvider({ ...alibaba, modelsDir: dir, async fetchModels() { return catalog; } }, { dryRun: true });
    expect(again.updated).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
