import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildMorphModel, fetchMorphModels, morph, type MorphModel } from "../src/sync/providers/morph.js";

function context(entries: Record<string, ExistingModel>) {
  return { existing: (id: string) => entries[id], authored: (id: string) => entries[id] };
}

function morphModel(overrides: Partial<MorphModel> = {}): MorphModel {
  return {
    id: "morph-dsv4flash",
    name: "Morph: DeepSeek V4 Flash 0731",
    input_modalities: [{
      type: "text",
      supported_inputs: { max_context_length: { value: 1_048_576 } },
      pricing: [
        { type: "prompt", cost_usd: "0.000000141953125" },
        { type: "cached_prompt", cost_usd: "0.0000000359375" },
        { type: "cache_write", cost_usd: "0" },
      ],
    }],
    output_modalities: [{
      type: "text",
      max_length: { value: 1_048_576 },
      pricing: [{ type: "completion", cost_usd: "0.000000399625" }],
    }],
    is_ready: true,
    ...overrides,
  };
}

// A full definition rather than a base_model overlay, so these assert the
// mapping itself instead of how factorBaseModel diffs against a lab file.
function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    name: "DeepSeek V4 Flash 0731",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["none", "low", "high", "xhigh", "max"] }],
    tool_call: true,
    structured_output: true,
    open_weights: true,
    cost: { input: 0.1, output: 0.3, cache_read: 0.02 },
    limit: { context: 1_000_000, output: 384_000 },
    modalities: { input: ["text"], output: ["text"] },
    ...overrides,
  } as ExistingModel;
}

test("takes exact list prices and limits from the feed, keeping authored reasoning", () => {
  expect(buildMorphModel(morphModel(), authored())).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["none", "low", "high", "xhigh", "max"] }],
    cost: { input: 0.141953125, output: 0.399625, cache_read: 0.0359375 },
    limit: { context: 1_048_576, output: 1_048_576 },
  });
});

test("drops the cache price when the feed lists no cached SKU", () => {
  const model = morphModel({
    id: "morph-v3-fast",
    input_modalities: [{
      type: "text",
      supported_inputs: { max_context_length: { value: 262_144 } },
      pricing: [{ type: "prompt", cost_usd: "0.0000008" }],
    }],
    output_modalities: [{
      type: "text",
      max_length: { value: 131_072 },
      pricing: [{ type: "completion", cost_usd: "0.0000012" }],
    }],
  });
  const built = buildMorphModel(model, authored({ cost: { input: 0.8, output: 1.2 } }));
  expect(built.cost).toMatchObject({ input: 0.8, output: 1.2, cache_read: undefined });
});

test("fails on a feed entry without a text price", () => {
  const model = morphModel({ output_modalities: [{ type: "text", max_length: { value: 1 } }] });
  expect(() => buildMorphModel(model, authored())).toThrow("missing a text price or limit");
});

test("skips OpenRouter aliases and unready entries without reporting them missing", () => {
  expect(morph.sourceID(morphModel({ id: "morph-dsv4flash-0731" }))).toBeUndefined();
  expect(morph.sourceID(morphModel({ is_ready: false }))).toBeUndefined();
  expect(morph.sourceID(morphModel({ id: "morph-new" }))).toBe("morph-new");
  expect(morph.translateModel(morphModel({ id: "morph-new" }), context({}))).toBeUndefined();
});

test("reads the list-price feed, not the OpenRouter feed", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    return Response.json({ data: [morphModel()] });
  }) as unknown as typeof fetch;
  const response = await fetchMorphModels(fetcher);
  expect(urls).toEqual(["https://www.morphllm.com/api/models/json?prices=list"]);
  expect(response.data.map((model) => model.id)).toEqual(["morph-dsv4flash"]);
});

test("keeps the hand-authored MIME list that the v1 view would collapse", () => {
  const modalities = { input: ["text", "image/jpeg", "image/png"], output: ["text"] };
  const translated = morph.translateModel(morphModel(), {
    ...context({ "morph-dsv4flash": authored() }),
    v2: () => ({ schema: 2, base_model: "deepseek/deepseek-v4-flash-0731", modalities }),
  });
  expect(translated?.v2Set).toEqual({ modalities });
});
