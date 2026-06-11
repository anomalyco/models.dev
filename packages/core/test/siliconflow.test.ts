import { expect, test } from "bun:test";

import { generateCatalog } from "../src/index.js";

test("SiliconFlow catalogs expose only positively documented reasoning controls", async () => {
  const { providers } = await generateCatalog(process.cwd());
  const global = providers.siliconflow!.models;
  const china = providers["siliconflow-cn"]!.models;

  expect(Object.keys(global)).toHaveLength(49);
  expect(Object.keys(china)).toHaveLength(46);
  expect(global["zai-org/GLM-4.7"]).toMatchObject({
    name: "zai-org/GLM-4.7",
    reasoning: true,
    cost: { input: 0.42, output: 2.2 },
  });
  expect(global["deepseek-ai/DeepSeek-V4-Flash"]).toBeDefined();
  expect(global["deepseek-ai/DeepSeek-V4-Pro"]).toBeDefined();
  expect(global["deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
  expect(global["deepseek-ai/deepseek-v4-pro"]).toBeUndefined();

  for (const id of [
    "Pro/MiniMaxAI/MiniMax-M2.1",
    "Pro/moonshotai/Kimi-K2-Thinking",
    "Pro/moonshotai/Kimi-K2-Instruct-0905",
    "Kwaipilot/KAT-Dev",
    "PaddlePaddle/PaddleOCR-VL",
    "ascend-tribe/pangu-pro-moe",
  ]) {
    expect(china[id]).toBeUndefined();
  }

  expect(optionIDs(global, "budget_tokens")).toEqual([
    "Qwen/Qwen3-14B",
    "Qwen/Qwen3-235B-A22B-Thinking-2507",
    "Qwen/Qwen3-32B",
    "Qwen/Qwen3-8B",
    "deepseek-ai/DeepSeek-R1",
    "deepseek-ai/DeepSeek-V3.1",
    "deepseek-ai/DeepSeek-V3.1-Terminus",
    "deepseek-ai/DeepSeek-V3.2",
    "deepseek-ai/DeepSeek-V3.2-Exp",
    "deepseek-ai/DeepSeek-V4-Flash",
    "deepseek-ai/DeepSeek-V4-Pro",
    "moonshotai/Kimi-K2.5",
    "moonshotai/Kimi-K2.6",
    "openai/gpt-oss-120b",
    "tencent/Hunyuan-A13B-Instruct",
    "tencent/Hy3-preview",
    "zai-org/GLM-4.7",
    "zai-org/GLM-5",
    "zai-org/GLM-5.1",
  ]);
  for (const id of optionIDs(global, "budget_tokens")) {
    expect(global[id]?.reasoning_options).toContainEqual({
      type: "budget_tokens",
      min: 128,
      max: 32_768,
    });
  }

  expect(optionIDs(global, "toggle")).toEqual([
    "Qwen/Qwen3-14B",
    "Qwen/Qwen3-32B",
    "Qwen/Qwen3-8B",
    "deepseek-ai/DeepSeek-V3.1",
    "deepseek-ai/DeepSeek-V3.1-Terminus",
    "deepseek-ai/DeepSeek-V3.2",
    "deepseek-ai/DeepSeek-V3.2-Exp",
    "tencent/Hunyuan-A13B-Instruct",
    "zai-org/GLM-5V-Turbo",
  ]);
  expect(optionIDs(china, "toggle")).toEqual([
    "Pro/deepseek-ai/DeepSeek-V3.1-Terminus",
    "Pro/deepseek-ai/DeepSeek-V3.2",
    "Pro/zai-org/GLM-4.7",
    "Pro/zai-org/GLM-5",
    "Qwen/Qwen3-14B",
    "Qwen/Qwen3-32B",
    "Qwen/Qwen3-8B",
    "Qwen/Qwen3.5-122B-A10B",
    "Qwen/Qwen3.5-27B",
    "Qwen/Qwen3.5-35B-A3B",
    "Qwen/Qwen3.5-397B-A17B",
    "Qwen/Qwen3.5-4B",
    "Qwen/Qwen3.5-9B",
    "deepseek-ai/DeepSeek-V3.1-Terminus",
    "deepseek-ai/DeepSeek-V3.2",
    "tencent/Hunyuan-A13B-Instruct",
  ]);

  expect(optionIDs(china, "budget_tokens")).toEqual([]);
  expect(optionIDs(global, "effort")).toEqual([]);
  expect(optionIDs(china, "effort")).toEqual([]);
  expect(fixedOptionIDs(global)).toEqual([]);
  expect(fixedOptionIDs(china)).toEqual([]);

  expect(unresolvedReasoningIDs(global)).toEqual([
    "Qwen/Qwen3-VL-235B-A22B-Thinking",
    "Qwen/Qwen3-VL-30B-A3B-Thinking",
    "Qwen/Qwen3-VL-32B-Thinking",
    "stepfun-ai/Step-3.5-Flash",
  ]);
  expect(unresolvedReasoningIDs(china)).toEqual([
    "Pro/deepseek-ai/DeepSeek-R1",
    "Pro/moonshotai/Kimi-K2.5",
    "Pro/moonshotai/Kimi-K2.6",
    "Pro/zai-org/GLM-5.1",
    "Qwen/Qwen3-235B-A22B-Thinking-2507",
    "Qwen/Qwen3-VL-235B-A22B-Thinking",
    "Qwen/Qwen3-VL-30B-A3B-Thinking",
    "Qwen/Qwen3-VL-32B-Thinking",
    "deepseek-ai/DeepSeek-R1",
    "deepseek-ai/DeepSeek-V4-Pro",
    "stepfun-ai/Step-3.5-Flash",
  ]);

  for (const model of [...Object.values(global), ...Object.values(china)]) {
    if (!model.reasoning) expect(model.reasoning_options).toBeUndefined();
  }
});

function optionIDs(
  models: Record<string, { reasoning_options?: Array<{ type: string }> }>,
  type: string,
) {
  return Object.entries(models)
    .filter(([, model]) => model.reasoning_options?.some((option) => option.type === type))
    .map(([id]) => id)
    .sort();
}

function fixedOptionIDs(models: Record<string, { reasoning_options?: unknown[] }>) {
  return Object.entries(models)
    .filter(([, model]) => model.reasoning_options?.length === 0)
    .map(([id]) => id)
    .sort();
}

function unresolvedReasoningIDs(
  models: Record<string, { reasoning: boolean; reasoning_options?: unknown[] }>,
) {
  return Object.entries(models)
    .filter(([, model]) => model.reasoning && model.reasoning_options === undefined)
    .map(([id]) => id)
    .sort();
}
