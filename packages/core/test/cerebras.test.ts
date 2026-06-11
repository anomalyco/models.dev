import { expect, test } from "bun:test";
import path from "node:path";

import { generate } from "../src/index.js";

test("Cerebras generated model matrix matches the current catalog", async () => {
  const root = path.join(import.meta.dirname, "..", "..", "..");
  const models = (await generate(path.join(root, "providers"))).cerebras?.models;

  expect(Object.keys(models ?? {}).sort()).toEqual(["gpt-oss-120b", "zai-glm-4.7"]);
  expect(models).toEqual({
    "gpt-oss-120b": {
      id: "gpt-oss-120b",
      name: "GPT OSS 120B",
      family: "gpt-oss",
      release_date: "2025-08-05",
      last_updated: "2026-06-10",
      attachment: false,
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      temperature: true,
      tool_call: true,
      open_weights: true,
      structured_output: true,
      cost: { input: 0.35, output: 0.75 },
      limit: { context: 131_072, output: 40_960 },
      modalities: { input: ["text"], output: ["text"] },
    },
    "zai-glm-4.7": {
      id: "zai-glm-4.7",
      name: "Z.AI GLM-4.7",
      release_date: "2026-01-07",
      last_updated: "2026-06-10",
      attachment: false,
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["none"] }],
      temperature: true,
      tool_call: true,
      open_weights: true,
      structured_output: true,
      status: "beta",
      cost: { input: 2.25, output: 2.75, cache_read: 0, cache_write: 0 },
      limit: { context: 131_072, output: 40_960 },
      modalities: { input: ["text"], output: ["text"] },
    },
  });

  expect(
    Object.entries(models ?? {})
      .filter(([, model]) => !model.reasoning && model.reasoning_options !== undefined)
      .map(([id]) => id),
  ).toEqual([]);
  expect(models?.["llama3.1-8b"]).toBeUndefined();
  for (const model of Object.values(models ?? {})) {
    expect(model).not.toHaveProperty("base_model");
    expect(model).not.toHaveProperty("base_model_omit");
  }
});
