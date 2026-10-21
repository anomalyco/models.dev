import { expect, test } from "bun:test";

import { formatToml } from "../src/sync/index.js";
import { buildOvhcloudModel, type OvhcloudModel } from "../src/sync/providers/ovhcloud.js";

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
  { label: "explicit zero rates", pricing: { prompt: "0", completion: "0" } },
])("OVHcloud serializes zero costs for $label", ({ pricing }) => {
  const result = buildOvhcloudModel(model(pricing), undefined);
  const content = formatToml({ id: "example-model", ...result });

  expect(Bun.TOML.parse(content).cost).toEqual({ input: 0, output: 0 });
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

test.each([
  { pricing: { prompt: "0.00000047" }, expected: { input: 0.47, output: 0 } },
  { pricing: { completion: "0.00000319" }, expected: { input: 0, output: 3.19 } },
])("OVHcloud preserves a supplied rate when the other is missing: %j", ({ pricing, expected }) => {
  const result = buildOvhcloudModel(model(pricing), undefined);
  const content = formatToml({ id: "example-model", ...result });

  expect(Bun.TOML.parse(content).cost).toEqual(expected);
});

test("OVHcloud replaces prior costs with zeros when pricing is absent", () => {
  const result = buildOvhcloudModel(model(), { cost: { input: 0.47, output: 3.19 } });
  const content = formatToml({ id: "example-model", ...result });

  expect(Bun.TOML.parse(content).cost).toEqual({ input: 0, output: 0 });
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
