import { expect, test } from "bun:test";

import {
  buildNebiusModel,
  fetchNebiusModels,
  nebius,
  type NebiusModel,
} from "../src/sync/providers/nebius.js";

function flavor(overrides: Partial<NebiusModel> = {}): NebiusModel {
  return {
    model_id: "zai-org/GLM-5.3",
    input_price_per_million_tokens: 1.4,
    output_price_per_million_tokens: 4.4,
    max_model_len: 1_024_000,
    ...overrides,
  };
}

test("parses the public Token Factory catalog, flattening flavors", () => {
  const catalog = [{
    type: "text2text",
    name: "GLM-5.3",
    status: "active",
    flavors: [flavor(), flavor({ model_id: "zai-org/GLM-5.3-Flash" })],
  }];

  expect(nebius.parseModels(catalog)).toEqual([
    flavor(),
    flavor({ model_id: "zai-org/GLM-5.3-Flash" }),
  ]);
});

test("fetches the public Token Factory models_info endpoint without authentication", async () => {
  let request: RequestInfo | URL | undefined;
  const fetcher: typeof fetch = async (input) => {
    request = input;
    return Response.json([{ flavors: [flavor()] }]);
  };

  await expect(fetchNebiusModels(fetcher)).resolves.toEqual([{ flavors: [flavor()] }]);
  expect(String(request)).toBe("https://tokenfactory.nebius.com/api/public/models_info");
});

test("fails the sync when the catalog request is not OK", async () => {
  const fetcher: typeof fetch = async () => new Response("unavailable", { status: 503 });

  await expect(fetchNebiusModels(fetcher)).rejects.toThrow("Nebius models request failed: 503");
});

test("tracks remote-only Token Factory models without creating or deleting TOMLs", () => {
  expect(nebius.skipCreates).toBe(true);
  expect(nebius.deleteMissing).toBe(false);
  expect(nebius.sourceID?.(flavor())).toBe("zai-org/GLM-5.3");
  expect(nebius.sourceID?.(flavor({ max_model_len: undefined }))).toBeUndefined();
  expect(nebius.sourceID?.(flavor({ input_price_per_million_tokens: undefined }))).toBeUndefined();
});

test("skips remote models that have no local TOML", () => {
  expect(nebius.translateModel(flavor(), {
    existing: () => undefined,
    authored: () => undefined,
  })).toBeUndefined();
});

test("leaves authored files untouched when the catalog entry lacks pricing", () => {
  const authored = { base_model: "zhipuai/glm-5.3" };
  const existing = { ...authored, cost: { input: 1.4, output: 4.4 } };

  expect(nebius.translateModel(flavor({ max_model_len: undefined }), {
    existing: () => existing,
    authored: () => authored,
  })).toEqual({ id: "zai-org/GLM-5.3", model: authored });
});

test("updates catalog pricing and the served window on factored models", () => {
  const existing = {
    base_model: "zhipuai/glm-5.3",
    reasoning_options: [{ type: "effort" as const, values: ["low", "high", "max"] }],
    interleaved: { field: "reasoning_content" as const },
    cost: { input: 1.4, output: 4.4, cache_read: 1.4 },
    limit: { context: 1_024_000, output: 1_024_000 },
  };

  expect(buildNebiusModel(flavor({
    input_price_per_million_tokens: 2,
    output_price_per_million_tokens: 8,
    max_model_len: 2_048_000,
  }), existing)).toEqual({
    base_model: "zhipuai/glm-5.3",
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    interleaved: { field: "reasoning_content" },
    cost: { input: 2, output: 8, cache_read: 1.4 },
    limit: { context: 2_048_000, output: 1_024_000 },
  });
});

test("updates catalog pricing and the served window on inline models", () => {
  const existing = {
    name: "Hermes-4-405B",
    description: "Reasoning model for deliberate analysis, multi-step problem solving, and tool use",
    attachment: false,
    reasoning: true,
    reasoning_options: [],
    tool_call: true,
    open_weights: true,
    cost: { input: 1, output: 3, reasoning: 3, cache_read: 0.1, cache_write: 1.25 },
    limit: { context: 131_072, input: 120_000, output: 8_192 },
    modalities: { input: ["text"], output: ["text"] },
  };

  expect(buildNebiusModel(flavor({
    model_id: "NousResearch/Hermes-4-405B",
    input_price_per_million_tokens: 1.2,
    output_price_per_million_tokens: 3.6,
    max_model_len: 262_144,
  }), existing)).toEqual({
    ...existing,
    cost: { input: 1.2, output: 3.6, reasoning: 3, cache_read: 0.1, cache_write: 1.25 },
    limit: { context: 262_144, input: 120_000, output: 8_192 },
  });
});
