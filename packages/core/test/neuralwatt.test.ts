import { expect, test } from "bun:test";

import { AuthoredModel } from "../src/schema.js";
import { buildNeuralwattModel, neuralwatt, type NeuralwattModel } from "../src/sync/providers/neuralwatt.js";

function sourceModel(id: string, metadata: Record<string, unknown> = {}): NeuralwattModel {
  return {
    id,
    max_model_len: 1_048_560,
    metadata: {
      display_name: "GLM 5.2",
      description: "upstream blurb",
      huggingface_id: null,
      pricing: { input_per_million: 1.45, output_per_million: 4.5, cached_input_per_million: 0.145 },
      capabilities: { tools: true, json_mode: false, vision: false, reasoning: true },
      reasoning: { supported_efforts: ["max", "high", "none"] },
      limits: { max_context_length: 1_048_560, max_output_tokens: null },
      deprecated: false,
      ...metadata,
    },
  };
}

function context(existing?: Record<string, unknown>, authored = existing) {
  return { existing: () => existing, authored: () => authored } as Parameters<
    typeof neuralwatt.translateModel
  >[1];
}

test("applies the flex discount the API omits, without float noise", () => {
  const model = buildNeuralwattModel(sourceModel("glm-5.2-flex"), undefined, undefined);

  expect(model.cost).toEqual({ input: 0.9425, output: 2.925, cache_read: 0.09425 });
});

test("keeps standard pricing on standard model IDs", () => {
  const model = buildNeuralwattModel(sourceModel("glm-5.2"), undefined, undefined);

  expect(model.cost).toEqual({ input: 1.45, output: 4.5, cache_read: 0.145 });
});

test("syncs the effort ladder and keeps authored budget bounds", () => {
  const authored = { reasoning_options: [{ type: "budget_tokens" as const, max: 32_000 }] };

  const model = buildNeuralwattModel(sourceModel("glm-5.2"), undefined, authored);

  // formatToml sorts effort values, so the API's order is kept as-is.
  expect(model.reasoning_options).toEqual([
    { type: "effort", values: ["max", "high", "none"] },
    { type: "budget_tokens", max: 32_000 },
  ]);
});

test("declares the budget control the API never describes", () => {
  const model = buildNeuralwattModel(sourceModel("glm-5.2"), undefined, undefined);

  expect(model.reasoning_options).toEqual([
    { type: "effort", values: ["max", "high", "none"] },
    { type: "budget_tokens" },
  ]);
});

test("omits the budget control on the models that reject it", () => {
  const flash = buildNeuralwattModel(sourceModel("deepseek-v4-flash"), undefined, undefined);
  const flex = buildNeuralwattModel(sourceModel("deepseek-v4-flash-flex"), undefined, undefined);
  // Gemma only links to canonical metadata through its repacked repo name.
  const gemma = buildNeuralwattModel(
    sourceModel("gemma-4-31b", { huggingface_id: "nvidia/Gemma-4-31B-IT-NVFP4" }),
    undefined,
    undefined,
  );

  for (const model of [flash, flex, gemma]) {
    expect(model.reasoning_options).toEqual([{ type: "effort", values: ["max", "high", "none"] }]);
  }
});

test("gives a budget-only model its single control", () => {
  const source = sourceModel("kimi-k2.7-code", { reasoning: { supported_efforts: [] } });

  const model = buildNeuralwattModel(source, undefined, undefined);

  expect(model.reasoning_options).toEqual([{ type: "budget_tokens" }]);
});

test("keeps the authored ladder when the API sends no reasoning block", () => {
  const source = sourceModel("glm-5.2", { reasoning: undefined });
  const authored = {
    reasoning_options: [{ type: "effort" as const, values: ["none" as const, "high" as const] }],
  };

  const model = buildNeuralwattModel(source, undefined, authored);

  expect(model.reasoning_options).toEqual([
    { type: "effort", values: ["none", "high"] },
    { type: "budget_tokens" },
  ]);
});

test("prefers authored catalog metadata over the API blurb and missing dates", () => {
  const existing = {
    description: "authored blurb",
    release_date: "2026-06-17",
    last_updated: "2026-06-17",
    limit: { context: 1_048_560, output: 1_048_560 },
  };

  const model = buildNeuralwattModel(sourceModel("glm-5.2"), existing, undefined);

  expect(model.description).toBe("authored blurb");
  expect(model.release_date).toBe("2026-06-17");
  // The API reports no output cap for models that can fill the context.
  expect(model.limit?.output).toBe(1_048_560);
});

test("skips an unknown ID rather than inventing a standalone definition", () => {
  expect(neuralwatt.translateModel(sourceModel("glm-6"), context())).toBeUndefined();
  expect(neuralwatt.sourceID(sourceModel("glm-6"))).toBe("glm-6");
  expect(neuralwatt.skippedNotice(["glm-6"]).join(" ")).toContain("glm-6");
});

test("keeps writing a pre-existing standalone definition", () => {
  const existing = {
    name: "GLM 5.2",
    description: "authored blurb",
    release_date: "2026-06-17",
    last_updated: "2026-06-17",
  };

  const translated = neuralwatt.translateModel(sourceModel("glm-6"), context(existing));

  expect(AuthoredModel.safeParse({ id: "glm-6", ...translated?.model }).success).toBe(true);
  expect(translated?.model.release_date).toBe("2026-06-17");
});

test("factors onto canonical metadata once the serving tier is stripped", () => {
  const model = buildNeuralwattModel(sourceModel("kimi-k3-flex"), undefined, undefined);

  expect(model).toMatchObject({ base_model: "moonshotai/kimi-k3" });
  // The canonical blurb and dates are inherited rather than invented.
  expect(model.description).toBeUndefined();
  expect(model.release_date).toBeUndefined();
  expect(model.last_updated).toBeUndefined();
});

test("factors onto a canonical ID whose MoE suffix the served ID drops", () => {
  const model = buildNeuralwattModel(sourceModel("qwen3.6-35b-fast"), undefined, undefined);

  expect(model).toMatchObject({ base_model: "alibaba/qwen3.6-35b-a3b" });
});

test("prefers a resolved base over a stale authored pointer", () => {
  const authored = { base_model: "moonshotai/kimi-k2.6" };

  const model = buildNeuralwattModel(sourceModel("kimi-k3"), undefined, authored);

  expect(model).toMatchObject({ base_model: "moonshotai/kimi-k3" });
});

test("carries no reasoning options onto a non-reasoning variant", () => {
  const source = sourceModel("kimi-k3-fast", {
    capabilities: { tools: true, json_mode: true, vision: true, reasoning: false },
    reasoning: { supported_efforts: ["none"] },
  });

  const model = buildNeuralwattModel(source, undefined, undefined);

  expect(model.reasoning).toBe(false);
  expect(model.reasoning_options).toBeUndefined();
  // No reasoning means no reasoning trace to interleave.
  expect(model.interleaved).toBeUndefined();
});

test("documents the budget control in a header the runner re-attaches", () => {
  const budget = neuralwatt.translateModel(sourceModel("glm-5.2"), context());
  const none = neuralwatt.translateModel(sourceModel("deepseek-v4-flash"), context());

  expect(budget?.header).toBe("# Budget: thinking_token_budget (integer reasoning tokens)\n");
  expect(none?.header).toBeUndefined();
});

test("keeps the authored cost when upstream pricing is still tbd", () => {
  const source = sourceModel("glm-5.2", {
    pricing: { input_per_million: null, output_per_million: null, pricing_tbd: true },
  });
  const existing = { cost: { input: 1.45, output: 4.5 } };

  const model = buildNeuralwattModel(source, existing, undefined);

  expect(model.cost).toEqual({ input: 1.45, output: 4.5 });
});

test("never publishes a free rate from a partial pricing payload", () => {
  const source = sourceModel("glm-5.2", {
    pricing: { input_per_million: 1.45, output_per_million: null },
  });
  const existing = { cost: { input: 1.45, output: 4.5 } };

  expect(buildNeuralwattModel(source, existing, undefined).cost).toEqual({ input: 1.45, output: 4.5 });
  // A new model with no usable price is skipped rather than priced at zero.
  expect(neuralwatt.translateModel(source, context())).toBeUndefined();
});

test("marks deprecated models", () => {
  const model = buildNeuralwattModel(sourceModel("glm-5.2", { deprecated: true }), undefined, undefined);

  expect(model.status).toBe("deprecated");
});

test("clears a deprecated status the API no longer reports", () => {
  const model = buildNeuralwattModel(sourceModel("glm-5.2"), { status: "deprecated" }, undefined);
  const beta = buildNeuralwattModel(sourceModel("glm-5.2"), { status: "beta" }, undefined);

  expect(model.status).toBeUndefined();
  expect(beta.status).toBe("beta");
});
