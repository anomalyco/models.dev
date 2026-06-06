import { expect, test } from "bun:test";

import { preserveBaseModel } from "../src/sync/index.js";
import { resolveCloudflareBaseModel } from "../src/sync/providers/cloudflare-workers-ai.js";
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

test("OpenRouter-derived syncs preserve existing base model links", () => {
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
    supported_parameters: ["reasoning", "tools", "temperature", "structured_outputs"],
  };

  const synced = preserveBaseModel(buildOpenRouterModel(model, undefined), {
    base_model: "nvidia/nemotron-3-super-120b-a12b",
    base_model_omit: ["limit.input"],
  });

  expect("base_model" in synced ? synced.base_model : undefined)
    .toBe("nvidia/nemotron-3-super-120b-a12b");
  expect("base_model_omit" in synced ? synced.base_model_omit : undefined)
    .toEqual(["limit.input"]);
});

test("newly detected base models do not replace existing links", () => {
  const model: OpenRouterModel = {
    id: "z-ai/glm-5.1",
    name: "Z.AI: GLM-5.1",
    created: 1_777_680_000,
    hugging_face_id: null,
    knowledge_cutoff: null,
    context_length: 200_000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.0000014", completion: "0.0000044" },
    top_provider: { context_length: 200_000, max_completion_tokens: 131_072 },
    supported_parameters: ["tools"],
  };
  const synced = buildOpenRouterModel(model, {
    base_model: "zhipuai/glm-5",
  });

  expect("base_model" in synced ? synced.base_model : undefined).toBe("zhipuai/glm-5");
});

test("undefined translated links preserve existing base model fields", () => {
  const synced = preserveBaseModel({
    base_model: undefined,
  } as never, {
    base_model: "nvidia/nemotron-3-super-120b-a12b",
    base_model_omit: ["limit.input"],
  });

  expect("base_model" in synced ? synced.base_model : undefined)
    .toBe("nvidia/nemotron-3-super-120b-a12b");
  expect("base_model_omit" in synced ? synced.base_model_omit : undefined)
    .toEqual(["limit.input"]);
});

test("new Cloudflare models discover a unique metadata base model", () => {
  const model: OpenRouterModel = {
    id: "@cf/nvidia/nemotron-3-120b-a12b",
    name: "Nemotron 3 Super 120B",
    created: 1_773_187_200,
    hugging_face_id: null,
    knowledge_cutoff: null,
    context_length: 256_000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.0000005", completion: "0.0000015" },
    top_provider: { context_length: 256_000, max_completion_tokens: 256_000 },
    supported_parameters: ["reasoning"],
  };

  expect(resolveCloudflareBaseModel(model)).toBe("nvidia/nemotron-3-super-120b-a12b");
  const synced = buildOpenRouterModel(model, undefined, resolveCloudflareBaseModel(model));
  expect("base_model" in synced ? synced.base_model : undefined)
    .toBe("nvidia/nemotron-3-super-120b-a12b");
});
