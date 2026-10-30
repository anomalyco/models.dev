import { expect, test } from "bun:test";

import {
  abacus,
  AbacusModel,
  buildAbacusModel,
  resolveAbacusBaseModel,
} from "../src/sync/providers/abacus.js";

function abacusModel(overrides: Partial<AbacusModel> = {}): AbacusModel {
  return {
    id: "gpt-6-sol",
    model_type: "text_generation",
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    input_token_rate: "0.000004",
    output_token_rate: "0.00002",
    cached_input_token_rate: "0.0000004",
    context_length: 1_000_000,
    max_completion_tokens: 128_000,
    tools: true,
    thinking: true,
    ...overrides,
  };
}

test("builds a factored model from RouteLLM rates and limits", () => {
  const built = buildAbacusModel(abacusModel());
  expect(built).toBeDefined();
  expect(built?.model).toMatchObject({
    base_model: "openai/gpt-6-sol",
    base_model_omit: ["limit.input"],
    reasoning_options: [],
    cost: { input: 4, output: 20, cache_read: 0.4 },
    limit: { context: 1_000_000 },
    modalities: { input: ["text", "image"] },
  });
  // reasoning, tool_call and the 128k output limit are the lab's own values.
  expect(built?.model).not.toHaveProperty("reasoning");
  expect(built?.model).not.toHaveProperty("tool_call");
  expect(built?.model).not.toHaveProperty("limit.output");
});

test("narrows input modalities to the kinds RouteLLM accepts, keeping the lab MIME list", () => {
  const built = buildAbacusModel(abacusModel());
  expect(built?.v2Set).toEqual({
    "modalities.input": ["text", "image/jpeg", "image/png", "image/gif", "image/webp"],
    "modalities.output": ["text"],
  });
});

test("does not write a modality override when RouteLLM accepts every lab kind", () => {
  const built = buildAbacusModel(
    abacusModel({ id: "zai-org/GLM-5.3", input_modalities: ["text"], thinking: undefined }),
  );
  expect(built?.v2Set).toBeUndefined();
});

test("reasoning follows thinking and preserves authored controls", () => {
  const authored = {
    base_model: "anthropic/claude-opus-5-5",
    reasoning: true,
    reasoning_options: [],
  } as any;
  const built = buildAbacusModel(
    abacusModel({ id: "claude-opus-5-5", thinking: undefined }),
    authored,
  );
  expect(built?.model).toMatchObject({
    base_model: "anthropic/claude-opus-5-5",
    reasoning_options: [],
  });
  // A lab reasoner keeps its inherited `reasoning = true` without an override.
  expect(built?.model).not.toHaveProperty("reasoning");
});

test("a non-thinking feed row never clears an authored reasoner", () => {
  const authored = { base_model: "zhipuai/glm-5.2", reasoning: true, reasoning_options: [] } as any;
  const built = buildAbacusModel(
    abacusModel({ id: "zai-org/GLM-5.2", thinking: undefined, tools: undefined }),
    authored,
  );
  expect(built?.model).toMatchObject({ reasoning_options: [] });
  expect(built?.model).not.toHaveProperty("reasoning");
});

test("resolves lab entries from vendor-prefixed and bare RouteLLM ids", () => {
  expect(resolveAbacusBaseModel("Qwen/Qwen3.8-27B")).toBe("alibaba/qwen3.8-27b");
  expect(resolveAbacusBaseModel("zai-org/GLM-5.3")).toBe("zhipuai/glm-5.3");
  expect(resolveAbacusBaseModel("MiniMaxAI/MiniMax-M3.1-Flash")).toBe("minimax/MiniMax-M3.1-Flash");
  expect(resolveAbacusBaseModel("claude-opus-5-5-fast")).toBe("anthropic/claude-opus-5-5");
  expect(resolveAbacusBaseModel("muse-spark-1.3-contributor")).toBe("meta/muse-spark-1.3");
});

test("an id with no lab entry is reported as missing instead of invented", () => {
  const model = abacusModel({ id: "abacusai/Smaug-Flash" });
  expect(buildAbacusModel(model)).toBeUndefined();
  expect(abacus.translateModel(model, {
    existing: () => undefined,
    authored: () => undefined,
  })).toBeUndefined();
  expect(abacus.missingModelID?.(model)).toBe("abacusai/Smaug-Flash");
});

test("transcription SKUs are intentional skips, not missing models", () => {
  const model = abacusModel({ id: "gpt-4o-transcribe", input_modalities: ["text"], thinking: undefined });
  expect(abacus.translateModel(model, {
    existing: () => undefined,
    authored: () => undefined,
  })).toBeUndefined();
  expect(abacus.missingModelID?.(model)).toBeUndefined();
  expect(abacus.sourceID?.(model)).toBeUndefined();
});

test("lab media models stay out of scope even when RouteLLM calls them text_generation", () => {
  const model = abacusModel({
    id: "gemini-nano-banana-2.1",
    input_modalities: ["text", "image"],
    output_modalities: ["text", "image"],
    thinking: undefined,
  });
  expect(buildAbacusModel(model)).toBeUndefined();
  expect(abacus.missingModelID?.(model)).toBeUndefined();
  expect(abacus.sourceID?.(model)).toBeUndefined();
});

test("an existing authored base_model always wins", () => {
  const authored = { base_model: "anthropic/claude-opus-4-6" } as any;
  const built = buildAbacusModel(
    abacusModel({ id: "claude-opus-4-6", thinking: true }),
    authored,
  );
  expect(built?.model).toMatchObject({ base_model: "anthropic/claude-opus-4-6" });
});

test("a create inherits lab name and description instead of feed copy", () => {
  const built = buildAbacusModel(abacusModel({
    display_name: "GPT-6 Sol (Abacus)",
    description: "Feed copy that is not a host delta",
  }));
  expect(built?.model).not.toHaveProperty("name");
  expect(built?.model).not.toHaveProperty("description");

  const curated = buildAbacusModel(
    abacusModel({ display_name: "GPT-6 Sol (Abacus)" }),
    { name: "GPT-6 Sol (Curated)", description: "Curated host description" } as any,
  );
  expect(curated?.model).toMatchObject({
    name: "GPT-6 Sol (Curated)",
    description: "Curated host description",
  });
});

test("curated tier labels keep same-base variants distinguishable", () => {
  const fast = buildAbacusModel(abacusModel({ id: "claude-opus-5-5-fast", thinking: undefined }));
  expect(fast?.model).toMatchObject({ name: "Claude Opus 5.5 Fast" });

  const contributor = buildAbacusModel(abacusModel({ id: "muse-spark-1.3-contributor", thinking: undefined }));
  expect(contributor?.model).toMatchObject({ name: "Muse Spark 1.3 Contributor" });
  expect(String(contributor?.model.description)).toContain("train future Meta models");
});

test("a curated deprecated status survives a feed hit", () => {
  const authored = { base_model: "zhipuai/glm-5.2", status: "deprecated" } as any;
  const built = buildAbacusModel(
    abacusModel({ id: "zai-org/GLM-5.2", thinking: true }),
    authored,
  );
  expect(built?.model).toMatchObject({ status: "deprecated" });
});

test("a feed limit above the lab cap is not overridden", () => {
  const built = buildAbacusModel(abacusModel({
    id: "Qwen/Qwen3.8-27B",
    context_length: 262_144,
    max_completion_tokens: 131_072,
  }));
  expect(built?.model).not.toHaveProperty("limit.output");
});

test("a feed limit below the lab cap still overrides", () => {
  const built = buildAbacusModel(abacusModel({
    id: "qwen3.8-max",
    context_length: 262_144,
    max_completion_tokens: 131_072,
  }));
  expect(built?.model).toMatchObject({ limit: { context: 262_144 } });
});
