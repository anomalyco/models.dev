import { expect, test } from "bun:test";

import {
  buildBasetenModel,
  type BasetenModel,
} from "../src/sync/providers/baseten.js";

function basetenModel(overrides: Partial<BasetenModel> = {}): BasetenModel {
  return {
    id: "deepseek-ai/DeepSeek-V4-Flash-0731",
    name: "DeepSeek V4 Flash 0731",
    context_length: 1_048_576,
    max_completion_tokens: 1_048_576,
    input_modalities: ["text"],
    output_modalities: ["text"],
    pricing: { prompt: "0.00000013", completion: "0.00000026" },
    supported_features: ["reasoning", "tools", "structured_outputs"],
    supported_sampling_parameters: ["temperature"],
    ...overrides,
  };
}

test("preserves an explicitly authored Baseten output limit", () => {
  const built = buildBasetenModel(
    basetenModel(),
    undefined,
    "deepseek/deepseek-v4-flash-0731",
    { limit: { context: 1_048_576, output: 384_000 } },
  );

  expect(built).toMatchObject({
    base_model: "deepseek/deepseek-v4-flash-0731",
    limit: { context: 1_048_576, output: 384_000 },
  });
});

test("uses Baseten's catalog output limit without an authored override", () => {
  const built = buildBasetenModel(
    basetenModel({ max_completion_tokens: 262_144 }),
    undefined,
    "deepseek/deepseek-v4-pro-0813",
  );

  expect(built).toMatchObject({
    base_model: "deepseek/deepseek-v4-pro-0813",
    limit: { context: 1_048_576, output: 262_144 },
  });
});
