import { expect, test } from "bun:test";

import { buildModularModel, isPublic, modular, ModularModel } from "../src/sync/providers/modular.js";

const model = ModularModel.parse({
  model_id: "deepseek-ai/DeepSeek-V4.1-Flash",
  gateway_model_id: "deepseek/deepseek-v4.1-flash",
  shared_endpoint: true,
  billing_type: "token",
  context_window: "1M",
  pricing: { cached_input: "0.00000002", input: "0.00000017", output: "0.0000012" },
});

const existing = {
  base_model: "deepseek/deepseek-v4.1-flash",
  cost: { input: 0.1, output: 1, cache_read: 0.01 },
  limit: { context: 1_048_576, output: 393_216 },
};

const context = {
  existing: (id: string) => (id === model.gateway_model_id ? existing : undefined),
  authored: (id: string) => (id === model.gateway_model_id ? existing : undefined),
};

test("converts per-token catalog prices to per-1M prices without float noise", () => {
  const built = buildModularModel(model, { cost: existing.cost, limit: existing.limit }) as Record<string, any>;
  expect(built.cost).toEqual({ input: 0.17, output: 1.2, cache_read: 0.02 });
  expect(built.limit).toEqual(existing.limit);
});

test("keeps measured limits instead of the catalog's rounded context window", () => {
  const built = buildModularModel(model, { cost: existing.cost, limit: { context: 1_000_000, output: 8192 } }) as Record<string, any>;
  expect(built.limit).toEqual({ context: 1_000_000, output: 8192 });
});

test("updates an existing model under its served ID", () => {
  expect(modular.translateModel(model, context)?.id).toBe("deepseek/deepseek-v4.1-flash");
});

test("skips a public model with no local file", () => {
  expect(modular.translateModel({ ...model, gateway_model_id: "new/model" }, context)).toBeUndefined();
});

test("treats unpriced, dedicated, and unrouted rows as not public", () => {
  expect(isPublic(model)).toBe(true);
  expect(isPublic({ ...model, pricing: { cached_input: "0", input: "0", output: "0" } })).toBe(false);
  expect(isPublic({ ...model, shared_endpoint: false })).toBe(false);
  expect(isPublic({ ...model, gateway_model_id: "" })).toBe(false);
  expect(isPublic({ ...model, billing_type: "megapixels" })).toBe(false);
  expect(modular.translateModel({ ...model, shared_endpoint: false }, context)).toBeUndefined();
  expect(modular.sourceID({ ...model, gateway_model_id: "" })).toBeUndefined();
});

test("rejects a catalog with no public models", () => {
  expect(() => modular.parseModels({ models: [] })).toThrow("no public models");
  expect(() => modular.parseModels({ models: [{ ...model, shared_endpoint: false }] })).toThrow("no public models");
});

test("never deletes or opens issues for models missing from the public set", () => {
  expect(modular.deleteMissing).toBe(false);
  expect(modular.skipCreates).toBe(true);
  expect(modular.trackMissingModels).toBe(false);
});
