import { expect, test } from "bun:test";

import { cloudflareWorkersAi } from "../src/sync/providers/cloudflare-workers-ai.js";

test("preserves OpenRouter pricing overrides as context tiers", () => {
  const [source] = cloudflareWorkersAi.parseModels({
    result: {
      data: [{
        id: "workers-ai/@cf/test/context-priced",
        name: "Context Priced",
        created: 1_782_777_600,
        hugging_face_id: null,
        knowledge_cutoff: null,
        context_length: 256_000,
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        pricing: {
          prompt: "0.000001",
          completion: "0.000002",
          overrides: [{
            min_prompt_tokens: 128_000,
            prompt: "0.000003",
            completion: "0.000004",
          }],
        },
        top_provider: {
          context_length: 256_000,
          max_completion_tokens: 8_192,
        },
        supported_parameters: [],
      }],
    },
  });

  expect(source?.pricing.overrides).toEqual([{
    min_prompt_tokens: 128_000,
    prompt: "0.000003",
    completion: "0.000004",
  }]);

  const translated = cloudflareWorkersAi.translateModel(source!, {
    existing: () => undefined,
    authored: () => undefined,
  });
  expect(translated.model.cost).toEqual({
    input: 1,
    output: 2,
    tiers: [{
      tier: { type: "context", size: 128_000 },
      input: 3,
      output: 4,
    }],
  });
});

function searchRow(id: string, context: number) {
  return {
    id: `workers-ai/${id}`,
    name: "Served Window",
    created: 1_782_777_600,
    hugging_face_id: null,
    knowledge_cutoff: null,
    context_length: context,
    architecture: {
      input_modalities: ["text"],
      output_modalities: ["text"],
    },
    pricing: { prompt: "0.000001", completion: "0.000002" },
    top_provider: {
      context_length: context,
      max_completion_tokens: context,
    },
    supported_parameters: [],
  };
}

function translatedContext(id: string, context: number) {
  const [source] = cloudflareWorkersAi.parseModels({ result: { data: [searchRow(id, context)] } });
  return cloudflareWorkersAi.translateModel(source!, {
    existing: () => undefined,
    authored: () => undefined,
  }).model.limit?.context;
}

test("pins the served context window when search reports a larger one", () => {
  expect(translatedContext("@cf/zai-org/glm-5.3", 1_310_720)).toBe(1_048_576);
  expect(translatedContext("@cf/zai-org/glm-5.3-flash", 1_310_720)).toBe(1_048_576);
  expect(translatedContext("@cf/deepseek-ai/deepseek-v4-flash-0731", 1_310_720)).toBe(1_048_576);
});

test("never raises a context window or pins other models", () => {
  expect(translatedContext("@cf/zai-org/glm-5.3", 262_144)).toBe(262_144);
  expect(translatedContext("@cf/test/unpinned", 1_310_720)).toBe(1_310_720);
});
