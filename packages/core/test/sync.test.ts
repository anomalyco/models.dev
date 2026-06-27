import { expect, test } from "bun:test";

import { formatToml } from "../src/sync/index.js";
import { buildDeepInfraModel, type DeepInfraModel } from "../src/sync/providers/deepinfra.js";

function deepInfraModel(model_name: string, tags: string[]): DeepInfraModel {
  return {
    model_name,
    type: "text-generation",
    tags,
    pricing: {
      cents_per_input_token: 0.00001,
      cents_per_output_token: 0.00002,
    },
    max_tokens: 262_144,
  };
}

test("formats interleaved as a root field before reasoning option tables", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    interleaved: true,
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(Bun.TOML.parse(content)).toMatchObject({
    interleaved: true,
    reasoning_options: [{ type: "toggle" }],
  });
});

test("formats empty reasoning options outside the interleaved table", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [],
    tool_call: true,
    interleaved: { field: "reasoning_content" },
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(Bun.TOML.parse(content)).toMatchObject({
    interleaved: { field: "reasoning_content" },
    reasoning_options: [],
  });
});

test("DeepInfra preserves live modalities for new base models", () => {
  const model = buildDeepInfraModel(
    deepInfraModel("Qwen/Qwen3.5-9B", ["multimodal", "input-video"]),
    undefined,
    "alibaba/qwen3.5-9b",
  );

  expect(model).toMatchObject({
    attachment: true,
    modalities: { input: ["text", "image", "video"] },
  });
});

test("DeepInfra excludes incorrectly tagged Gemma 4 audio input", () => {
  const model = buildDeepInfraModel(
    deepInfraModel("google/gemma-4-31B-it", ["multimodal", "input-audio", "input-video"]),
    { modalities: { input: ["text", "image", "audio", "video"] } },
    "google/gemma-4-31b-it",
  );

  expect(model).toMatchObject({
    modalities: { input: ["text", "image", "video"] },
  });
});
