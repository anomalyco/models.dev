import { expect, test } from "bun:test";

import type { ExistingModel, SyncedModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import { buildInferenceModel, inference, labModelID, type InferenceModel } from "../src/sync/providers/inference.js";

type CompleteModel = Parameters<typeof buildInferenceModel>[0];

function inferenceModel(overrides: Partial<InferenceModel> = {}): CompleteModel {
  return {
    id: "glm-5.3",
    object: "model",
    context_length: 1_048_576,
    max_completion_tokens: 943_718,
    reasoning_efforts: ["low", "high", "max"],
    pricing: { prompt: "0.000000900000", completion: "0.000003000000", input_cache_read: "0.000000150000" },
    ...overrides,
  } as CompleteModel;
}

function context(entries: Record<string, ExistingModel>) {
  return { existing: (id: string) => entries[id], authored: (id: string) => entries[id] };
}

const base = (id: string) => ({ base_model: id }) as ExistingModel;

test("maps unprefixed and namespaced IDs to lab entries", () => {
  expect(labModelID("claude-opus-4-6")).toBe("anthropic/claude-opus-4-6");
  expect(labModelID("qwen3.7-plus")).toBe("alibaba/qwen3.7-plus");
  expect(labModelID("z-ai/glm-5.3-fast")).toBe("zhipuai/glm-5.3-fast");
  expect(labModelID("moonshotai/kimi-k3")).toBe("moonshotai/kimi-k3");
});

test("converts per-token prices and maps reasoning_efforts to one effort option", () => {
  expect(buildInferenceModel(inferenceModel(), base("zhipuai/glm-5.3"))).toMatchObject({
    cost: { input: 0.9, output: 3, cache_read: 0.15 },
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  });
});

test("caps the output limit at the context window", () => {
  const built = buildInferenceModel(
    inferenceModel({ context_length: 65_536 }),
    base("zhipuai/glm-5.3"),
  );

  expect(built).toMatchObject({ limit: { context: 65_536, output: 65_536 } });
});

test("refuses a reasoning model the endpoint lists no efforts for", () => {
  expect(() =>
    buildInferenceModel(inferenceModel({ id: "deepseek-v3.2", reasoning_efforts: undefined }), base("deepseek/deepseek-v3.2"))
  ).toThrow(MissingReasoningOptionsError);
});

test("never raises the output limit above the lab entry", () => {
  const built = buildInferenceModel(
    inferenceModel({ id: "kimi-k3", context_length: 1_048_576, max_completion_tokens: 1_048_576 }),
    base("moonshotai/kimi-k3"),
  );

  // Equal to the lab figure, so the overlay inherits it instead of restating it.
  expect(built).not.toHaveProperty("limit");
});

test("takes input modalities from the endpoint and drops unknown values", () => {
  const built = buildInferenceModel(
    inferenceModel({ input_modalities: ["text", "image", "file"] }),
    base("zhipuai/glm-5.3"),
  );

  expect(built).toMatchObject({ modalities: { input: ["text", "image"] } });
});

test("does not publish a cache price that is no discount", () => {
  const built = buildInferenceModel(
    inferenceModel({ pricing: { prompt: "0.00000005", completion: "0.0000002", input_cache_read: "0.00000005" } }),
    base("zhipuai/glm-5.3"),
  );

  expect(built).not.toHaveProperty("cost.cache_read");
});

test("ignores effort levels the schema cannot describe", () => {
  const built = buildInferenceModel(
    inferenceModel({ reasoning_efforts: ["low", "turbo", "high"] }),
    base("zhipuai/glm-5.3"),
  );

  expect(built).toMatchObject({ reasoning_options: [{ type: "effort", values: ["low", "high"] }] });
});

test("keeps a hand-authored name override on an existing overlay", () => {
  const built = buildInferenceModel(inferenceModel(), {
    base_model: "zhipuai/glm-5.3",
    name: "GLM 5.3 (Inference)",
  } as ExistingModel);

  expect(built).toMatchObject({ base_model: "zhipuai/glm-5.3", name: "GLM 5.3 (Inference)" });
});

test("skips a model with no lab entry and republishes an unpriced one unchanged", () => {
  expect(inference.translateModel(inferenceModel({ id: "no-such-model-xyz" }), context({}))).toBeUndefined();

  const authored = { base_model: "zhipuai/glm-5.3", cost: { input: 1, output: 2 } } as ExistingModel;
  expect(
    inference.translateModel(inferenceModel({ pricing: undefined }), context({ "glm-5.3": authored })),
  ).toEqual({ id: "glm-5.3", model: authored as SyncedModel });
});

test("drops cost fields the endpoint no longer publishes", () => {
  const built = buildInferenceModel(
    inferenceModel({ pricing: { prompt: "0.0000009", completion: "0.000003" } }),
    { base_model: "zhipuai/glm-5.3", cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.5 } } as ExistingModel,
  );

  expect(built).toMatchObject({ cost: { input: 0.9, output: 3 } });
  expect(built).not.toHaveProperty("cost.cache_read");
  expect(built).not.toHaveProperty("cost.cache_write");
});
