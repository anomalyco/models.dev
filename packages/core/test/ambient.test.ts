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
  // A row that drops the flag still skips when the lab reasons.
  expect(() => ambient.translateModel(ambientModel({ supported_features: ["tools"] }), context)).toThrow(MissingReasoningOptionsError);
  // Models whose lab doesn't reason are still created.
  const llama = ambientModel({
    id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", hugging_face_id: "meta-llama/Llama-3.3-70B-Instruct",
    context_length: 131_072, max_output_length: 131_072, supported_features: ["tools"],
    openrouter: { slug: "meta-llama/llama-3.3-70b-instruct" },
  });
  expect(ambient.translateModel(llama, context)).toMatchObject({ id: "meta-llama/llama-3.3-70b-instruct" });
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
    description: "October 17 update of DeepSeek V4.1 Flash with improved reasoning, coding, agentic tasks, and visual understanding",
    reasoning: true,
    reasoning_options: efforts,
  };
  expect(buildAmbientModel(ambientModel(), linked, { ...linked, description: undefined })).not.toHaveProperty("description");
  // A restated lab description is dropped; one that differs stays.
  expect(buildAmbientModel(ambientModel(), linked, linked)).not.toHaveProperty("description");
  expect(buildAmbientModel(ambientModel(), linked, { ...linked, description: "Ambient wording" })).toMatchObject({ description: "Ambient wording" });
});

test("Ambient doesn't restate an output limit equal to the lab's or write an empty limit", () => {
  const authored = { base_model: "deepseek/deepseek-v4.1-flash-1017", reasoning_options: efforts } as ExistingModel;
  const built = buildAmbientModel(ambientModel(), authored, authored) as { limit?: Record<string, number> };
  expect(built.limit?.output).toBeUndefined();
  if (built.limit !== undefined) expect(Object.keys(built.limit).length).toBeGreaterThan(0);
});
