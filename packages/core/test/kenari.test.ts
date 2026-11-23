import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { isRetired, kenari, resolveReasoningOptions, unitCosts, type KenariCatalogModel, type KenariPricingLine } from "../src/sync/providers/kenari.js";

const RATE = 17_500;

const line = (overrides: Partial<KenariPricingLine>): KenariPricingLine => ({
  billable: "input_audio",
  endpoint: "audio_transcription",
  micro_idr: 175_000,
  unit: "second",
  variant: null,
  ...overrides,
});

const catalog = (overrides: Partial<KenariCatalogModel> = {}): KenariCatalogModel => ({
  id: "whisper-large-v3-turbo",
  owned_by: "openai",
  endpoints: ["audio_transcription"],
  pricing: { currency: "IDR", unit: "micro_idr_per_1m_tokens", free: false, input: 0, output: 0 },
  ...overrides,
});

const translate = (model: KenariCatalogModel, lines: KenariPricingLine[] | undefined, authored?: ExistingModel) =>
  kenari.translateModel({ model, rate: RATE, lines }, {
    existing: () => authored,
    authored: () => authored,
  } as never);

test("maps per-unit pricing lines to USD", () => {
  expect(unitCosts([line({})], RATE)).toEqual({ "cost.audio.input": { unit: "second", price: 0.00001 } });
  expect(unitCosts([line({ billable: "output_image", endpoint: "images", micro_idr: 125_000_000, unit: "image" })], RATE))
    .toEqual({ "cost.image.output": { unit: "image", price: 0.00714286 } });
  expect(unitCosts([line({ billable: "output_video", endpoint: "videos", micro_idr: 300_000_000, unit: "second" })], RATE))
    .toEqual({ "cost.video.output": { unit: "second", price: 0.01714286 } });
  expect(unitCosts([line({ billable: "output_audio", endpoint: "audio_speech", micro_idr: 75_000_000, unit: "1k_chars" })], RATE))
    .toEqual({ "cost.text.input": { unit: "character", price: 4.28571429 } });
});

test("leaves out lines with no CostV2 unit or several variants", () => {
  expect(unitCosts([line({ billable: "output_audio", endpoint: "music", micro_idr: 1_500_000_000, unit: "song" })], RATE)).toEqual({});
  expect(unitCosts([
    line({ billable: "output_video", endpoint: "videos", unit: "second", variant: "360p" }),
    line({ billable: "output_video", endpoint: "videos", unit: "second", variant: "720p" }),
  ], RATE)).toEqual({});
  expect(unitCosts([line({ billable: "input", endpoint: "chat", unit: "token_1m" })], RATE)).toEqual({});
});

test("does not write $0 token prices for a model billed per unit", () => {
  const result = translate(catalog(), [line({})]);
  expect(result?.model).not.toHaveProperty("cost");
  const set = result?.v2Set?.["cost.audio.input"] as (current: unknown) => unknown;
  expect(set({ unit: "second", price: 1 })).toEqual({ unit: "second", price: 0.00001 });
  expect(set(undefined)).toEqual({ unit: "second", price: 0.00001 });
});

test("a paid 0/0 model with no pricing lines in the feed gets no token cost either", () => {
  const result = translate(catalog(), undefined);
  expect(result?.model).not.toHaveProperty("cost");
  expect(result).not.toHaveProperty("v2Set");
});

test("keeps the authored API table", () => {
  const authored = {
    base_model: "openai/whisper-large-v3-turbo",
    provider: { npm: "@ai-sdk/openai" },
  } as ExistingModel;
  const result = translate(catalog(), [line({})], authored);
  expect(result?.model).toMatchObject({ provider: { npm: "@ai-sdk/openai" } });
});

test("still writes token prices for chat models as before", () => {
  const chat = translate(
    catalog({ id: "claude-sonnet-5", owned_by: "anthropic", endpoints: ["chat"], pricing: { currency: "IDR", unit: "micro_idr_per_1m_tokens", free: false, input: 17_500_000_000, output: 87_500_000_000 } }),
    [line({ billable: "input", endpoint: "chat", unit: "token_1m", micro_idr: 17_500_000_000 })],
  );
  expect(chat?.model).toMatchObject({ cost: { input: 1, output: 5 } });
});

test("reads sunset_at as an ISO date or Unix seconds", () => {
  expect(isRetired(null)).toBe(false);
  expect(isRetired("2020-01-01T00:00:00Z")).toBe(true);
  expect(isRetired(1_577_836_800)).toBe(true);
  expect(isRetired(4_102_444_800)).toBe(false);
});

test("a reasoner with no effort levels but reasoning_toggle on gets a toggle", () => {
  // Inkling 2 Mini Uncensored: the lab entry states no controls and the feed lists no levels, only reasoning_toggle.
  expect(resolveReasoningOptions("inkling-2-mini-uncensored", "thinkingmachines/inkling-2-mini", null, true, true)).toEqual([{ type: "toggle" }]);
  expect(() => resolveReasoningOptions("inkling-2-mini-uncensored", "thinkingmachines/inkling-2-mini", null, true, false)).toThrow();
});

test("reasoning_toggle joins effort levels unless they already include none", () => {
  const levels = (values: string[]) => resolveReasoningOptions("example-model", "example/none", values, true, true);
  expect(levels(["low", "medium", "high"])).toEqual([{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high"] }]);
  expect(levels(["none", "low", "high"])).toEqual([{ type: "effort", values: ["none", "low", "high"] }]);
});
