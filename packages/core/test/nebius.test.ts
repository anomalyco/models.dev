import { expect, test } from "bun:test";
import path from "node:path";

import { generate } from "../src/index.js";

const modelIDs = [
  "MiniMaxAI/MiniMax-M2.5",
  "MiniMaxAI/MiniMax-M2.5-fast",
  "NousResearch/Hermes-4-405B",
  "NousResearch/Hermes-4-70B",
  "PrimeIntellect/INTELLECT-3",
  "Qwen/Qwen2.5-VL-72B-Instruct",
  "Qwen/Qwen3-235B-A22B-Instruct-2507",
  "Qwen/Qwen3-235B-A22B-Thinking-2507-fast",
  "Qwen/Qwen3-30B-A3B-Instruct-2507",
  "Qwen/Qwen3-32B",
  "Qwen/Qwen3-Embedding-8B",
  "Qwen/Qwen3-Next-80B-A3B-Thinking",
  "Qwen/Qwen3-Next-80B-A3B-Thinking-fast",
  "Qwen/Qwen3.5-397B-A17B",
  "Qwen/Qwen3.5-397B-A17B-fast",
  "deepseek-ai/DeepSeek-V3.2",
  "deepseek-ai/DeepSeek-V3.2-fast",
  "deepseek-ai/DeepSeek-V4-Pro",
  "google/gemma-3-27b-it",
  "meta-llama/Llama-3.3-70B-Instruct",
  "moonshotai/Kimi-K2.5",
  "moonshotai/Kimi-K2.5-fast",
  "nvidia/Llama-3_1-Nemotron-Ultra-253B-v1",
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  "nvidia/Nemotron-3-Nano-Omni",
  "nvidia/nemotron-3-super-120b-a12b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-120b-fast",
  "zai-org/GLM-5",
].sort();

const unresolvedReasoning = [
  "MiniMaxAI/MiniMax-M2.5",
  "MiniMaxAI/MiniMax-M2.5-fast",
  "NousResearch/Hermes-4-405B",
  "NousResearch/Hermes-4-70B",
  "Qwen/Qwen3-235B-A22B-Thinking-2507-fast",
  "Qwen/Qwen3-Next-80B-A3B-Thinking",
  "Qwen/Qwen3-Next-80B-A3B-Thinking-fast",
  "deepseek-ai/DeepSeek-V3.2",
  "deepseek-ai/DeepSeek-V3.2-fast",
  "deepseek-ai/DeepSeek-V4-Pro",
  "moonshotai/Kimi-K2.5",
  "moonshotai/Kimi-K2.5-fast",
  "nvidia/Nemotron-3-Nano-Omni",
  "nvidia/nemotron-3-super-120b-a12b",
].sort();

const deprecated = [
  "MiniMaxAI/MiniMax-M2.5-fast",
  "PrimeIntellect/INTELLECT-3",
  "Qwen/Qwen3-235B-A22B-Thinking-2507-fast",
  "Qwen/Qwen3-Next-80B-A3B-Thinking-fast",
  "Qwen/Qwen3.5-397B-A17B-fast",
  "deepseek-ai/DeepSeek-V3.2",
  "deepseek-ai/DeepSeek-V3.2-fast",
  "moonshotai/Kimi-K2.5",
  "moonshotai/Kimi-K2.5-fast",
  "openai/gpt-oss-120b-fast",
  "zai-org/GLM-5",
].sort();

test("generated Nebius provider matches the reviewed model matrix", async () => {
  const root = path.join(import.meta.dirname, "..", "..", "..");
  const providers = await generate(path.join(root, "providers"));
  const models = providers.nebius?.models;
  expect(models).toBeDefined();
  if (models === undefined) throw new Error("Nebius provider was not generated");

  expect(Object.keys(models).sort()).toEqual(modelIDs);
  expect(models).not.toHaveProperty("meta-llama/Meta-Llama-3.1-8B-Instruct");
  expect(models).not.toHaveProperty("google/gemma-2-2b-it");

  const verifiedControls = Object.fromEntries(
    Object.entries(models)
      .filter(([, model]) => model.reasoning_options !== undefined)
      .map(([id, model]) => [id, model.reasoning_options]),
  );
  expect(verifiedControls).toEqual({
    "Qwen/Qwen3.5-397B-A17B": [{ type: "toggle" }],
    "Qwen/Qwen3.5-397B-A17B-fast": [{ type: "toggle" }],
    "openai/gpt-oss-120b": [
      { type: "effort", values: ["low", "medium", "high"] },
    ],
    "openai/gpt-oss-120b-fast": [
      { type: "effort", values: ["low", "medium", "high"] },
    ],
    "zai-org/GLM-5": [{ type: "toggle" }],
  });

  expect(
    Object.entries(models)
      .filter(([, model]) => model.reasoning && model.reasoning_options === undefined)
      .map(([id]) => id)
      .sort(),
  ).toEqual(unresolvedReasoning);
  expect(
    Object.entries(models)
      .filter(([, model]) => model.reasoning_options?.length === 0)
      .map(([id]) => id),
  ).toEqual([]);
  expect(
    Object.entries(models)
      .filter(([, model]) => !model.reasoning && model.reasoning_options !== undefined)
      .map(([id]) => id),
  ).toEqual([]);
  expect(
    Object.entries(models)
      .filter(([, model]) => model.status === "deprecated")
      .map(([id]) => id)
      .sort(),
  ).toEqual(deprecated);

  expect(models["openai/gpt-oss-120b-fast"]?.reasoning_options).toEqual(
    models["openai/gpt-oss-120b"]?.reasoning_options,
  );
  expect(models["Qwen/Qwen3.5-397B-A17B-fast"]?.reasoning_options).toEqual(
    models["Qwen/Qwen3.5-397B-A17B"]?.reasoning_options,
  );
  expect(models["deepseek-ai/DeepSeek-V4-Pro"]).toMatchObject({
    id: "deepseek-ai/DeepSeek-V4-Pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
  });
  expect(models["deepseek-ai/DeepSeek-V4-Pro"]).not.toHaveProperty("base_model");
  expect(models["deepseek-ai/DeepSeek-V4-Pro"]?.reasoning_options).toBeUndefined();
});
