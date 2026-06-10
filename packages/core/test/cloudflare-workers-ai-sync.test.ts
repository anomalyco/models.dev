import { expect, test } from "bun:test";

import { buildWorkersAiModel } from "../src/sync/providers/cloudflare-workers-ai.js";
import type { OpenRouterModel } from "../src/sync/providers/openrouter.js";

test("Cloudflare Workers AI sync preserves reasoning options", () => {
  const model: OpenRouterModel = {
    id: "@cf/nvidia/nemotron-3-120b-a12b",
    name: "Nemotron 3 Super 120B",
    created: 1_773_187_200,
    hugging_face_id: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16",
    knowledge_cutoff: null,
    context_length: 256_000,
    architecture: {
      input_modalities: ["text"],
      output_modalities: ["text"],
    },
    pricing: {
      prompt: "0.0000005",
      completion: "0.0000015",
    },
    top_provider: {
      context_length: 256_000,
      max_completion_tokens: 256_000,
    },
    supported_parameters: ["reasoning", "tools", "temperature"],
  };

  const synced = buildWorkersAiModel(model, {
    base_model: "nvidia/nemotron-3-super-120b-a12b",
    reasoning_options: [{ type: "toggle" }],
  });

  expect(synced.reasoning_options).toEqual([{ type: "toggle" }]);
});
