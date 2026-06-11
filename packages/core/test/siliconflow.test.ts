import { expect, test } from "bun:test";

import { generateCatalog } from "../src/index.js";

test("SiliconFlow catalogs expose only verified reasoning controls", async () => {
  const { providers } = await generateCatalog(process.cwd());
  const global = providers.siliconflow!.models;
  const china = providers["siliconflow-cn"]!.models;

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

  for (const id of [
    "Qwen/Qwen3.5-4B",
    "Qwen/Qwen3.5-9B",
    "Qwen/Qwen3.5-27B",
    "Qwen/Qwen3.5-35B-A3B",
    "Qwen/Qwen3.5-122B-A10B",
    "Qwen/Qwen3.5-397B-A17B",
    "Pro/zai-org/GLM-4.7",
    "Pro/zai-org/GLM-5",
  ]) {
    expect(china[id]).toMatchObject({
      reasoning: true,
      reasoning_options: [{ type: "toggle" }],
    });
  }

  for (const model of Object.values(china)) {
    expect(model.reasoning_options ?? []).not.toContainEqual(
      expect.objectContaining({ type: "budget_tokens" }),
    );
  }

  for (const id of [
    "Qwen/Qwen3-VL-32B-Thinking",
    "Qwen/Qwen3-VL-235B-A22B-Thinking",
    "Qwen/Qwen3-VL-30B-A3B-Thinking",
  ]) {
    expect(global[id]?.reasoning_options).toEqual([]);
  }

  expect(global["zai-org/GLM-5V-Turbo"]?.reasoning_options).toEqual([
    { type: "toggle" },
  ]);
  expect(global["tencent/Hy3-preview"]?.reasoning_options).toEqual([
    { type: "budget_tokens", min: 128, max: 32_768 },
  ]);

  for (const model of [...Object.values(global), ...Object.values(china)]) {
    if (model.reasoning) expect(model.reasoning_options).toBeDefined();
    else expect(model.reasoning_options).toBeUndefined();
  }
});
