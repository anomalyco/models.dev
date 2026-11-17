import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import { ambient, buildAmbientModel, type AmbientModel } from "../src/sync/providers/ambient.js";

function ambientModel(overrides: Partial<AmbientModel> = {}): AmbientModel {
  return {
    id: "deepseek/deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash 1017",
    created: 1_794_856_926,
    hugging_face_id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    context_length: 1_048_576,
    max_output_length: 1_048_576,
    input_modalities: ["text"],
    output_modalities: ["text"],
    pricing: { prompt: "0.000000098", completion: "0.000000294", input_cache_read: "0.0000000029" },
    supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
    supported_sampling_parameters: ["temperature", "top_p"],
    openrouter: { slug: "deepseek/deepseek-v4.1-flash-1017" },
    is_ready: true,
    ...overrides,
  };
}

const efforts: ExistingModel["reasoning_options"] = [
  { type: "toggle" },
  { type: "effort", values: ["low", "high", "max"] },
];

test("Ambient skips new reasoning models until their controls are authored", () => {
  const context = { existing: () => undefined, authored: () => undefined, v2: () => undefined };
  expect(() => ambient.translateModel(ambientModel(), context)).toThrow(MissingReasoningOptionsError);
  // Non-reasoning models are still created.
  expect(ambient.translateModel(ambientModel({ supported_features: ["tools"] }), context)).toMatchObject({
    id: "deepseek/deepseek-v4.1-flash-1017",
  });
});

test("Ambient keeps authored reasoning controls on existing files", () => {
  const authored: ExistingModel = { base_model: "deepseek/deepseek-v4.1-flash-1017", reasoning: true, reasoning_options: efforts };
  const result = ambient.translateModel(ambientModel(), { existing: () => authored, authored: () => authored });
  expect(result).toMatchObject({ model: { reasoning_options: efforts } });
});

test("Ambient ignores an output limit that repeats the context window", () => {
  const linked: ExistingModel = { base_model: "deepseek/deepseek-v4.1-flash-1017", reasoning: true, reasoning_options: efforts };
  // The lab's 384,000 output is inherited, not a 1M override.
  expect((buildAmbientModel(ambientModel(), linked, linked) as { limit: { output?: number } }).limit.output).toBeUndefined();
  // An authored output limit stays.
  const authored: ExistingModel = { ...linked, limit: { context: 1_048_576, output: 200_000 } };
  expect(buildAmbientModel(ambientModel(), authored, authored)).toMatchObject({ limit: { output: 200_000 } });
  // A cap below the window is the host's.
  expect(buildAmbientModel(ambientModel({ max_output_length: 65_535 }), linked, linked)).toMatchObject({ limit: { output: 65_535 } });
});

test("Ambient caps an inherited output limit at the served context", () => {
  const linked: ExistingModel = { base_model: "deepseek/deepseek-v4.1-flash-1017", reasoning: true, reasoning_options: efforts };
  expect(buildAmbientModel(ambientModel({ context_length: 200_000, max_output_length: 200_000 }), linked, linked))
    .toMatchObject({ limit: { context: 200_000, output: 200_000 } });
});

test("Ambient linked files never restate the generated description", () => {
  const linked: ExistingModel = {
    base_model: "deepseek/deepseek-v4.1-flash-1017",
    description: "Lab description",
    reasoning: true,
    reasoning_options: efforts,
  };
  // existing is the resolved view (lab description); only an authored one stays.
  expect(buildAmbientModel(ambientModel(), linked, { ...linked, description: undefined })).not.toHaveProperty("description");
  expect(buildAmbientModel(ambientModel(), linked, linked)).toMatchObject({ description: "Lab description" });
});
