import { expect, test } from "bun:test";

import { buildOpenRouterModel, type OpenRouterModel } from "../src/sync/providers/openrouter.js";

test("OpenRouter z-ai models inherit from zhipuai metadata", () => {
  const model: OpenRouterModel = {
    id: "z-ai/glm-5.1",
    name: "Z.AI: GLM-5.1",
    created: 1_777_680_000,
    hugging_face_id: "zai-org/GLM-5.1",
    knowledge_cutoff: null,
    context_length: 200_000,
    architecture: {
      input_modalities: ["text"],
      output_modalities: ["text"],
    },
    pricing: {
      prompt: "0.0000014",
      completion: "0.0000044",
    },
    top_provider: {
      context_length: 200_000,
      max_completion_tokens: 131_072,
    },
    supported_parameters: ["tools", "tool_choice", "temperature", "structured_outputs"],
  };

  const synced = buildOpenRouterModel(model, undefined);

  expect("base_model" in synced ? synced.base_model : undefined).toBe("zhipuai/glm-5.1");
});
