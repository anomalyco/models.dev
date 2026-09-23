import { expect, test } from "bun:test";

import {
  buildParasailModel,
  parasail,
  type ParasailEndpoint,
  resolveParasailBaseModel,
} from "../src/sync/providers/parasail.js";

function endpoint(overrides: Partial<ParasailEndpoint> = {}): ParasailEndpoint {
  return {
    externalAlias: "parasail-deepseek-v41-flash",
    modelName: "deepseek-ai/DeepSeek-V4.1-Flash",
    contextLength: 1_048_576,
    maxCompletionTokens: null,
    inputCost: 0.3,
    outputCost: 1.2,
    cachedCost: 0.006,
    tags: ["parasail:or-feature:tools", "parasail:or-feature:reasoning"],
    engineTask: null,
    ...overrides,
  };
}

test("maps Hugging Face names, including quantized re-uploads, to lab entries", () => {
  expect(resolveParasailBaseModel("deepseek-ai/DeepSeek-V4.1-Flash")).toBe("deepseek/deepseek-v4.1-flash");
  expect(resolveParasailBaseModel("moonshotai/Kimi-K3")).toBe("moonshotai/kimi-k3");
  expect(resolveParasailBaseModel("Qwen/Qwen3.5-397B-A17B-FP8")).toBe("alibaba/qwen3.5-397b-a17b");
  expect(resolveParasailBaseModel("nvidia/GLM-5.2-NVFP4")).toBe("zhipuai/glm-5.2");
  expect(resolveParasailBaseModel("MiniMaxAI/MiniMax-M3-MXFP8")).toBe("minimax/MiniMax-M3");
  expect(resolveParasailBaseModel("RedHatAI/gemma-4-31B-it-FP8-Dynamic")).toBe("google/gemma-4-31b-it");
  expect(resolveParasailBaseModel("RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic")).toBe("meta/llama-3.3-70b-instruct");
  expect(resolveParasailBaseModel("meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8")).toBe("meta/llama-4-maverick-17b-instruct");
  expect(resolveParasailBaseModel("openai/gpt-oss-120b")).toBe("openai/gpt-oss-120b");
  expect(resolveParasailBaseModel("TheDrummer/Cydonia-24B-v4.1")).toBeUndefined();
  expect(resolveParasailBaseModel(null)).toBeUndefined();
});

test("factors a verified reasoning endpoint onto its lab entry with provider-side overrides only", () => {
  const built = buildParasailModel(endpoint(), undefined);

  expect(built).toMatchObject({
    base_model: "deepseek/deepseek-v4.1-flash",
    reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
    interleaved: { field: "reasoning_content" },
    cost: { input: 0.3, output: 1.2, cache_read: 0.006 },
    limit: { context: 1_048_576 },
  });
  // Inherited lab facts are not restated.
  expect(built).not.toHaveProperty("name");
  expect(built).not.toHaveProperty("modalities");
  expect(built).not.toHaveProperty("reasoning");
});

test("names a -fast alias after its lab entry", () => {
  const built = buildParasailModel(
    endpoint({
      externalAlias: "parasail-gpt-oss-120b-fast",
      modelName: "openai/gpt-oss-120b",
      contextLength: 131_072,
      inputCost: 0.15,
      outputCost: 0.6,
      cachedCost: null,
    }),
    undefined,
  );

  expect(built).toMatchObject({
    base_model: "openai/gpt-oss-120b",
    name: "GPT OSS 120B (Fast)",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
  });
  expect(built).not.toHaveProperty("interleaved");
});

test("refuses to invent controls for an unverified reasoning endpoint", () => {
  expect(() =>
    buildParasailModel(
      endpoint({ externalAlias: "parasail-kimi-k28", modelName: "moonshotai/Kimi-K2.8-Preview" }),
      undefined,
    ),
  ).toThrow(/have not been verified/);
});

test("preserves authored reasoning options, output limits, and base_model on resync", () => {
  const built = buildParasailModel(
    endpoint({ contextLength: 524_288, inputCost: 0.25, outputCost: 1.0 }),
    {
      base_model: "deepseek/deepseek-v4.1-flash",
      reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      limit: { context: 1_048_576, output: 65_536 },
      cost: { input: 0.3, output: 1.2 },
    },
    "deepseek/deepseek-v4.1-flash",
    { limit: { context: 1_048_576, output: 65_536 } },
  );

  expect(built).toMatchObject({
    base_model: "deepseek/deepseek-v4.1-flash",
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    cost: { input: 0.25, output: 1.0 },
    limit: { context: 524_288, output: 65_536 },
  });
});

test("refuses an empty or non-chat-only feed instead of deleting the catalog", () => {
  expect(() => parasail.parseModels([])).toThrow(/empty feed/);
  expect(() =>
    parasail.parseModels([endpoint({ externalAlias: "parasail-bge-m3", modelName: "BAAI/bge-m3", outputCost: null })]),
  ).toThrow(/no public chat endpoints/);
});

test("skips non-chat and private endpoints", () => {
  const parsed = parasail.parseModels([
    endpoint(),
    endpoint({ externalAlias: "parasail-bge-m3", modelName: "BAAI/bge-m3", outputCost: null }),
    endpoint({ externalAlias: "parasail-resemble-tts-en", modelName: "tts-1", tags: ["TTS"], outputCost: null }),
    endpoint({ externalAlias: "daim2xqktvqo-qwen38-flash-next-fp8", modelName: "Qwen/Qwen3.8-Flash-Next-FP8" }),
  ]);

  expect(parsed.map((model) => model.externalAlias)).toEqual(["parasail-deepseek-v41-flash"]);
});

test("skips endpoints without a lab entry instead of authoring inline definitions", () => {
  const translated = parasail.translateModel(
    endpoint({ externalAlias: "parasail-cydonia-24-v41", modelName: "TheDrummer/Cydonia-24B-v4.1" }),
    { existing: () => undefined, authored: () => undefined },
  );

  expect(translated).toBeUndefined();
});
