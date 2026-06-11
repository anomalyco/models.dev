import { expect, test } from "bun:test";
import path from "node:path";

import { generate } from "../src/index.js";

test("DeepInfra models expose only verified reasoning controls", async () => {
  const root = path.join(import.meta.dirname, "..", "..", "..");
  const deepinfra = (await generate(path.join(root, "providers"))).deepinfra;

  expect(deepinfra).toBeDefined();

  const toggle = [
    "XiaomiMiMo/MiMo-V2.5-Pro",
    "XiaomiMiMo/MiMo-V2.5",
    "deepseek-ai/DeepSeek-V3.2",
    "google/gemma-4-26B-A4B-it",
    "google/gemma-4-31B-it",
    "moonshotai/Kimi-K2.6",
    "zai-org/GLM-4.6",
    "zai-org/GLM-4.7",
    "zai-org/GLM-5.1",
    "zai-org/GLM-5",
  ];
  const standardEffort = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
  const r1 = ["deepseek-ai/DeepSeek-R1-0528"];
  const v4 = [
    "deepseek-ai/DeepSeek-V4-Flash",
    "deepseek-ai/DeepSeek-V4-Pro",
  ];
  const nonReasoning = [
    "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
    "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
    "meta-llama/Llama-4-Scout-17B-16E-Instruct",
  ];
  const unresolved = [
    "MiniMaxAI/MiniMax-M2.5",
    "Qwen/Qwen3.5-35B-A3B",
    "Qwen/Qwen3.5-397B-A17B",
    "Qwen/Qwen3.6-35B-A3B",
    "moonshotai/Kimi-K2.5",
    "zai-org/GLM-4.7-Flash",
  ];

  expect(Object.keys(deepinfra?.models ?? {}).sort()).toEqual(
    [
      ...toggle,
      ...standardEffort,
      ...r1,
      ...v4,
      ...nonReasoning,
      ...unresolved,
    ].sort(),
  );

  for (const id of toggle) {
    expect(deepinfra?.models[id]?.reasoning).toBe(true);
    expect(deepinfra?.models[id]?.reasoning_options).toEqual([{ type: "toggle" }]);
  }
  for (const id of standardEffort) {
    expect(deepinfra?.models[id]?.reasoning).toBe(true);
    expect(deepinfra?.models[id]?.reasoning_options).toEqual([
      { type: "effort", values: ["low", "medium", "high"] },
    ]);
  }
  for (const id of r1) {
    expect(deepinfra?.models[id]?.reasoning).toBe(true);
    expect(deepinfra?.models[id]?.reasoning_options).toEqual([
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high"] },
    ]);
  }
  for (const id of v4) {
    expect(deepinfra?.models[id]?.reasoning).toBe(true);
    expect(deepinfra?.models[id]?.reasoning_options).toEqual([
      { type: "toggle" },
      { type: "effort", values: ["high"] },
    ]);
  }
  for (const id of nonReasoning) {
    expect(deepinfra?.models[id]?.reasoning).toBe(false);
    expect(deepinfra?.models[id]?.reasoning_options).toBeUndefined();
  }
  for (const id of unresolved) {
    expect(deepinfra?.models[id]?.reasoning).toBe(true);
    expect(deepinfra?.models[id]?.reasoning_options).toBeUndefined();
  }
});
