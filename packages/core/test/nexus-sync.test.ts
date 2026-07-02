import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { formatToml } from "../src/sync/index.js";
import { buildNexusModel, type NexusModel } from "../src/sync/providers/nexus.js";

function nexusModel(model: Partial<NexusModel> & Pick<NexusModel, "id">): NexusModel {
  return {
    features: [],
    endpoints: ["chat/completions"],
    ...model,
  };
}

test("nexus router capabilities come only from advertised features", () => {
  const model = buildNexusModel(
    nexusModel({
      id: "nexus/auto",
      kind: "router",
      display_name: "Auto Router",
      features: ["routing"],
    }),
    undefined,
    "2026-01-01",
  );
  const toml = Bun.TOML.parse(formatToml({ id: "nexus/auto", ...model }));

  expect(toml.reasoning).toBe(false);
  expect(toml.tool_call).toBe(false);
  expect(toml.structured_output).toBe(false);
  expect(toml).not.toHaveProperty("reasoning_options");
});

test("nexus reasoning models use only audited supported controls", () => {
  const model = buildNexusModel(
    nexusModel({
      id: "private/custom-reasoning",
      display_name: "Custom Reasoning",
      features: ["reasoning", "function-calling", "structured-outputs"],
      context_size: 128_000,
      max_output_tokens: 32_000,
    }),
    {
      reasoning_options: [
        { type: "toggle" },
        { type: "effort", values: ["low", "medium", "high"] },
      ],
    } as ExistingModel,
    "2026-01-01",
  );

  expect(model).toMatchObject({
    reasoning: true,
    reasoning_options: [],
    tool_call: true,
    structured_output: true,
  });
});

test("nexus usd prices are copied exactly from the source", () => {
  const model = buildNexusModel(
    nexusModel({
      id: "private/exact-price",
      display_name: "Exact Price",
      context_size: 128_000,
      max_output_tokens: 32_000,
      input_price_per_1m_tokens_usd: 0.123456789,
      output_price_per_1m_tokens_usd: 9.87654321,
      cache_read_price_per_1m_tokens_usd: 0.000000123,
    }),
    undefined,
    "2026-01-01",
  );

  expect(model.cost).toEqual({
    input: 0.123456789,
    output: 9.87654321,
    cache_read: 0.000000123,
  });
});
