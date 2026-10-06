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
