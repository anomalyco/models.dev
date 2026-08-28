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

test("applies the flex discount the API omits, without float noise", () => {
  const model = buildNeuralwattModel(sourceModel("glm-5.2-flex"), undefined, undefined, "2026-08-28");

  expect(model.cost).toEqual({ input: 0.9425, output: 2.925, cache_read: 0.09425 });
});

test("keeps standard pricing on standard model IDs", () => {
  const model = buildNeuralwattModel(sourceModel("glm-5.2"), undefined, undefined, "2026-08-28");

  expect(model.cost).toEqual({ input: 1.45, output: 4.5, cache_read: 0.145 });
});

test("syncs the effort ladder but keeps authored budget controls", () => {
  const authored = { reasoning_options: [{ type: "budget_tokens" as const }] };

  const model = buildNeuralwattModel(sourceModel("glm-5.2"), undefined, authored, "2026-08-28");

  // formatToml sorts effort values, so the API's order is kept as-is.
  expect(model.reasoning_options).toEqual([
    { type: "effort", values: ["max", "high", "none"] },
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

  const model = buildNeuralwattModel(sourceModel("glm-5.2"), existing, undefined, "2026-08-28");

  expect(model.description).toBe("authored blurb");
  expect(model.release_date).toBe("2026-06-17");
  // The API reports no output cap for models that can fill the context.
  expect(model.limit?.output).toBe(1_048_560);
});

test("creates a complete model for an ID the catalog has never seen", () => {
  const model = buildNeuralwattModel(sourceModel("glm-6"), undefined, undefined, "2026-08-28");

  expect(AuthoredModel.safeParse({ id: "glm-6", ...model }).success).toBe(true);
  expect(model.name).toBe("GLM 5.2");
  expect(model.description).not.toBe("upstream blurb");
  expect(model.open_weights).toBe(true);
  expect(model.interleaved).toBe(true);
  expect(model.release_date).toBe("2026-08-28");
});

test("factors onto canonical metadata once the serving tier is stripped", () => {
  const model = buildNeuralwattModel(sourceModel("kimi-k3-flex"), undefined, undefined, "2026-08-28");

  expect(model).toMatchObject({ base_model: "moonshotai/kimi-k3" });
  // The canonical blurb and dates are inherited rather than invented.
  expect(model.description).toBeUndefined();
  expect(model.release_date).toBeUndefined();
  expect(model.last_updated).toBeUndefined();
});

test("factors onto a canonical ID whose MoE suffix the served ID drops", () => {
  const model = buildNeuralwattModel(sourceModel("qwen3.6-35b-fast"), undefined, undefined, "2026-08-28");

  expect(model).toMatchObject({ base_model: "alibaba/qwen3.6-35b-a3b" });
});

test("prefers a resolved base over a stale authored pointer", () => {
  const authored = { base_model: "moonshotai/kimi-k2.6" };

  const model = buildNeuralwattModel(sourceModel("kimi-k3"), undefined, authored, "2026-08-28");

  expect(model).toMatchObject({ base_model: "moonshotai/kimi-k3" });
});

test("documents the budget control in a header the runner re-attaches", () => {
  const authored = { reasoning_options: [{ type: "budget_tokens" as const }] };
  const context = { existing: () => undefined, authored: () => authored };

  const budget = neuralwatt.translateModel(sourceModel("glm-5.2"), context);
  const none = neuralwatt.translateModel(sourceModel("glm-5.2"), {
    existing: () => undefined,
    authored: () => undefined,
  });

  expect(budget?.header).toBe("# Budget: thinking_token_budget (integer reasoning tokens)\n");
  expect(none?.header).toBeUndefined();
});

test("keeps the authored cost when upstream pricing is still tbd", () => {
  const source = sourceModel("glm-5.2", {
    pricing: { input_per_million: null, output_per_million: null, pricing_tbd: true },
  });
  const existing = { cost: { input: 1.45, output: 4.5 } };

  const model = buildNeuralwattModel(source, existing, undefined, "2026-08-28");

  expect(model.cost).toEqual({ input: 1.45, output: 4.5 });
});

test("marks deprecated models", () => {
  const model = buildNeuralwattModel(
    sourceModel("glm-5.2", { deprecated: true }),
    undefined,
    undefined,
    "2026-08-28",
  );

  expect(model.status).toBe("deprecated");
});

test("clears a deprecated status the API no longer reports", () => {
  const model = buildNeuralwattModel(sourceModel("glm-5.2"), { status: "deprecated" }, undefined, "2026-08-28");
  const beta = buildNeuralwattModel(sourceModel("glm-5.2"), { status: "beta" }, undefined, "2026-08-28");

  expect(model.status).toBeUndefined();
  expect(beta.status).toBe("beta");
});
