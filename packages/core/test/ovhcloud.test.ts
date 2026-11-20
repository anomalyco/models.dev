import { expect, test } from "bun:test";

import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import { buildOvhcloudModel, ovhcloud, type OvhcloudModel } from "../src/sync/providers/ovhcloud.js";

function model(pricing?: OvhcloudModel["pricing"]): OvhcloudModel {
  return {
    id: "example-model",
    name: "Example Model",
    created: Date.parse("2026-09-02T00:00:00Z") / 1_000,
    context_length: 262_144,
    pricing,
  };
}

test.each([
  { label: "absent pricing", pricing: undefined },
  { label: "empty pricing", pricing: {} },
  { label: "blank rates", pricing: { prompt: "", completion: "" } },
  { label: "whitespace rates", pricing: { prompt: " ", completion: "\t" } },
])("OVHcloud writes no cost for $label", ({ pricing }) => {
  expect(buildOvhcloudModel(model(pricing), undefined).cost).toBeUndefined();
});

test("OVHcloud keeps an explicit zero rate as free", () => {
  expect(buildOvhcloudModel(model({ prompt: "0", completion: "0" }), undefined).cost).toEqual({ input: 0, output: 0 });
});

test("OVHcloud converts paid and cache rates to per-million costs", () => {
  const result = buildOvhcloudModel(model({
    prompt: "0.00000047",
    completion: "0.00000319",
    input_cache_reads: "0.00000009",
    input_cache_writes: "0.00000012",
  }), undefined);
  expect(result.cost).toEqual({ input: 0.47, output: 3.19, cache_read: 0.09, cache_write: 0.12 });
});

test("OVHcloud keeps authored costs when the catalog has no prices", () => {
  const result = buildOvhcloudModel(model(), { cost: { input: 0.47, output: 3.19 } });
  expect(result.cost).toEqual({ input: 0.47, output: 3.19 });
});

test("OVHcloud skips new models that have no published price", () => {
  const context = { existing: () => undefined, authored: () => undefined, v2: () => undefined };
  expect(ovhcloud.translateModel({ ...model({ prompt: "", completion: "" }), id: "gemma-4-26b-a4b" }, context)).toBeUndefined();
});

test("OVHcloud skips new reasoning models until their controls are authored", () => {
  const context = { existing: () => undefined, authored: () => undefined, v2: () => undefined };
  const priced = { prompt: "0.00000047", completion: "0.00000319" };
  expect(() => ovhcloud.translateModel({ ...model(priced), supported_features: ["reasoning"] }, context)).toThrow(MissingReasoningOptionsError);
  // A row that drops the flag still skips when the lab reasons.
  expect(() => ovhcloud.translateModel({ ...model(priced), id: "Qwen3.6-27B", hugging_face_id: "Qwen/Qwen3.6-27B" }, context)).toThrow(MissingReasoningOptionsError);
});

test("OVHcloud links new non-reasoning models to the lab file", () => {
  const context = { existing: () => undefined, authored: () => undefined, v2: () => undefined };
  const result = ovhcloud.translateModel({
    ...model({ prompt: "0.00000074", completion: "0.00000074" }),
    id: "Meta-Llama-3_3-70B-Instruct",
    hugging_face_id: "meta-llama/Llama-3.3-70B-Instruct",
    name: "Meta-Llama-3_3-70B-Instruct",
    context_length: 131_072,
    supported_features: ["tools"],
  }, context);
  expect(result).toMatchObject({ model: { base_model: "meta/llama-3.3-70b-instruct", cost: { input: 0.74, output: 0.74 } } });
  expect(result?.model).not.toHaveProperty("release_date");
  expect(result?.model).not.toHaveProperty("open_weights");
});

test("OVHcloud factors a base_model file and leaves model facts to the lab", () => {
  const result = buildOvhcloudModel(
    {
      ...model({ prompt: "0.00000047", completion: "0.00000319" }),
      id: "Qwen3.8-27B",
      name: "Qwen3.8-27B",
      hugging_face_id: "Qwen/Qwen3.8-27B",
      input_modalities: ["text", "image"],
      supported_features: ["reasoning", "tools", "structured_outputs"],
      supported_sampling_parameters: ["temperature"],
    },
    {
      base_model: "alibaba/qwen3.8-27b",
      family: "qwen",
      open_weights: true,
      release_date: "2026-08-14",
      last_updated: "2026-08-14",
      reasoning_options: [{ type: "effort", values: ["none", "minimal", "low", "medium", "high"] }],
    },
  );

  expect(result).toMatchObject({
    base_model: "alibaba/qwen3.8-27b",
    name: "Qwen3.8-27B",
    structured_output: true,
    cost: { input: 0.47, output: 3.19 },
    modalities: { input: ["text", "image"] },
  });
  for (const key of ["family", "open_weights", "release_date", "last_updated", "knowledge", "tool_call", "temperature"]) {
    expect(result).not.toHaveProperty(key);
  }
});
