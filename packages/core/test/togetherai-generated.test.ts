import { expect, test } from "bun:test";
import path from "node:path";

import { generate } from "../src/index.js";

const expected = {
  "LiquidAI/LFM2-24B-A2B": ["active", false, undefined],
  "MiniMaxAI/MiniMax-M2.5": ["deprecated", true, undefined],
  "MiniMaxAI/MiniMax-M2.7": ["active", true, []],
  "Qwen/Qwen2.5-7B-Instruct-Turbo": ["active", false, undefined],
  "Qwen/Qwen3-235B-A22B-Instruct-2507-tput": ["active", false, undefined],
  "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": ["deprecated", false, undefined],
  "Qwen/Qwen3-Coder-Next-FP8": ["deprecated", false, undefined],
  "Qwen/Qwen3.5-397B-A17B": ["active", true, [{ type: "toggle" }]],
  "Qwen/Qwen3.5-9B": ["active", true, [{ type: "toggle" }]],
  "Qwen/Qwen3.6-Plus": ["active", true, [{ type: "toggle" }]],
  "Qwen/Qwen3.7-Max": ["active", false, undefined],
  "deepcogito/cogito-v2-1-671b": ["active", true, [{ type: "toggle" }]],
  "deepseek-ai/DeepSeek-R1": ["deprecated", true, []],
  "deepseek-ai/DeepSeek-V3": ["deprecated", false, undefined],
  "deepseek-ai/DeepSeek-V3-1": ["deprecated", true, [{ type: "toggle" }]],
  "deepseek-ai/DeepSeek-V4-Pro": [
    "active",
    true,
    [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
  ],
  "essentialai/Rnj-1-Instruct": ["active", false, undefined],
  "google/gemma-3n-E4B-it": ["active", false, undefined],
  "google/gemma-4-31B-it": ["active", true, undefined],
  "meta-llama/Llama-3.3-70B-Instruct-Turbo": ["active", false, undefined],
  "meta-llama/Meta-Llama-3-8B-Instruct-Lite": ["active", false, undefined],
  "moonshotai/Kimi-K2.5": ["deprecated", true, [{ type: "toggle" }]],
  "moonshotai/Kimi-K2.6": ["active", true, [{ type: "toggle" }]],
  "nvidia/nemotron-3-ultra-550b-a55b": ["active", true, [{ type: "toggle" }]],
  "openai/gpt-oss-120b": [
    "active",
    true,
    [{ type: "effort", values: ["low", "medium", "high"] }],
  ],
  "openai/gpt-oss-20b": [
    "active",
    true,
    [{ type: "effort", values: ["low", "medium", "high"] }],
  ],
  "pearl-ai/gemma-4-31b-it": ["active", true, undefined],
  "zai-org/GLM-5": ["active", true, [{ type: "toggle" }]],
  "zai-org/GLM-5.1": ["active", true, [{ type: "toggle" }]],
} as const;

test("generated Together matrix is exhaustive and resolved", async () => {
  const root = path.join(import.meta.dirname, "..", "..", "..");
  const providers = await generate(path.join(root, "providers"));
  const models = providers.togetherai?.models;

  expect(models).toBeDefined();
  expect(Object.keys(models ?? {}).sort()).toEqual(Object.keys(expected).sort());

  const active: string[] = [];
  const deprecated: string[] = [];
  const unresolved: string[] = [];
  const fixed: string[] = [];

  for (const [id, [lifecycle, reasoning, reasoningOptions]] of Object.entries(expected)) {
    const model = models?.[id];
    expect(model, id).toBeDefined();
    expect(model?.status ?? "active", `${id} lifecycle`).toBe(lifecycle);
    expect(model?.reasoning, `${id} reasoning`).toBe(reasoning);
    expect(model?.reasoning_options, `${id} controls`).toEqual(reasoningOptions);

    const encoded = JSON.stringify(model);
    expect(encoded, `${id} resolved metadata`).not.toContain("base_model");

    (lifecycle === "deprecated" ? deprecated : active).push(id);
    if (reasoning && reasoningOptions === undefined) unresolved.push(id);
    if (reasoningOptions?.length === 0) fixed.push(id);
    if (!reasoning) expect(model?.reasoning_options, `${id} non-reasoning controls`).toBeUndefined();
  }

  expect(active).toHaveLength(22);
  expect(deprecated).toHaveLength(7);
  expect(unresolved.sort()).toEqual([
    "MiniMaxAI/MiniMax-M2.5",
    "google/gemma-4-31B-it",
    "pearl-ai/gemma-4-31b-it",
  ]);
  expect(fixed.sort()).toEqual([
    "MiniMaxAI/MiniMax-M2.7",
    "deepseek-ai/DeepSeek-R1",
  ]);

  expect(models?.["deepseek-ai/DeepSeek-V4-Pro"]?.cost).toMatchObject({
    input: 1.74,
    output: 3.48,
    cache_read: 0.2,
  });
  expect(models?.["google/gemma-4-31B-it"]).toMatchObject({
    reasoning: true,
    structured_output: true,
    cost: { input: 0.39, output: 0.97 },
  });
});
