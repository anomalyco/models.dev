import { describe, expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import {
  buildNearAIModel,
  nearai,
  type NearAIModel,
  resolveNearAIBaseModel,
} from "../src/sync/providers/nearai.js";

describe("NEAR AI sync", () => {
  test("parses the public Cloud API model response", () => {
    // Given: a representative Cloud API response row with extra fields.
    const response = { data: [nearModel({ id: "openai/privacy-filter" })] };

    // When: the sync provider parses the response.
    const models = nearai.parseModels(response);

    // Then: the typed source model is accepted without leaking raw shape.
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("openai/privacy-filter");
  });

  test("factors known NEAR model ids to canonical base models", () => {
    // Given: NEAR-specific model ids that differ from canonical metadata ids.
    const ids = [
      "Qwen/Qwen3.6-27B-FP8",
      "deepseek-ai/DeepSeek-V4-Flash",
      "z-ai/glm-5.2",
    ];

    // When: each id is resolved for provider TOML inheritance.
    const resolved = ids.map((id) => resolveNearAIBaseModel(id, undefined));

    // Then: the sync uses existing model metadata instead of provider-only namespaces.
    expect(resolved).toEqual([
      "alibaba/qwen3.6-27b",
      "deepseek/deepseek-v4-flash",
      "zhipuai/glm-5.2",
    ]);
  });

  test("preserves curated reasoning controls for existing models", () => {
    // Given: an existing curated Anthropic route with documented controls.
    const existing = existingModel({
      base_model: "anthropic/claude-opus-4-7",
      reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    });

    // When: Cloud API reports the model as reasoning-capable.
    const model = buildNearAIModel(
      nearModel({
        id: "anthropic/claude-opus-4-7",
        name: "Claude Opus 4.7",
        owned_by: "anthropic",
        supported_features: ["reasoning", "tools", "structured_outputs"],
      }),
      existing,
    );

    // Then: the curated controls survive instead of being inferred from generic capabilities.
    expect(model).toHaveProperty("reasoning_options", existing.reasoning_options);
  });

  test("rejects source rows with zero cache pricing", () => {
    // Given: a Cloud API response that reports cache reads as free.
    const response = {
      data: [
        nearModel({
          id: "anthropic/claude-opus-4-6",
          pricing: {
            input: 5,
            output: 25,
            prompt: "0.000005",
            completion: "0.000025",
            input_cache_read: "0",
          },
        }),
      ],
    };

    // When/Then: the provider fails before bogus cache pricing can reach TOML.
    expect(() => nearai.parseModels(response)).toThrow("non-positive input_cache_read values");
  });

  test("sets explicit reasoning controls for new self-hosted and proxied models", () => {
    // Given: one self-hosted NEAR model and one proxied model with reasoning behavior.
    const selfHosted = nearModel({ id: "Qwen/Qwen3.6-27B-FP8", supported_features: ["reasoning", "tools"] });
    const proxied = nearModel({
      id: "moonshotai/kimi-k2.6",
      owned_by: "attested 3p",
      supported_features: ["reasoning", "tools"],
    });

    // When: each new model is translated with no existing TOML.
    const selfHostedModel = buildNearAIModel(selfHosted, undefined);
    const proxiedModel = buildNearAIModel(proxied, undefined);

    // Then: self-hosted routes expose a toggle and proxied routes declare no provider control.
    expect(selfHostedModel).toHaveProperty("reasoning_options", [{ type: "toggle" }]);
    expect(proxiedModel).toHaveProperty("reasoning_options", []);
  });

  test("preserves existing timestamps and normalizes unsupported modalities", () => {
    // Given: an existing embedding route and a source row using Cloud API's embedding modality.
    const existing = existingModel({
      release_date: "2026-01-01",
      last_updated: "2026-01-02",
      modalities: { input: ["text"], output: ["text"] },
    });

    // When: the model is translated.
    const model = buildNearAIModel(
      nearModel({
        id: "Qwen/Qwen3-Embedding-0.6B",
        output_modalities: ["embedding"],
      }),
      existing,
    );

    // Then: curated dates survive and output remains schema-compatible.
    expect(model).toHaveProperty("release_date", "2026-01-01");
    expect(model).toHaveProperty("last_updated", "2026-01-02");
    expect(model).toHaveProperty("modalities", { input: ["text", "image"], output: ["text"] });
  });

  test("uses source creation date for new full models", () => {
    // Given: a new provider-local model without canonical base metadata.
    const source = nearModel({
      id: "openai/privacy-filter",
      created: 1_747_526_400,
      name: "Privacy Filter",
      supported_features: [],
    });

    // When: the sync translates it without existing TOML.
    const model = buildNearAIModel(source, undefined);

    // Then: both generated timestamps come from the API row.
    expect(model).toHaveProperty("release_date", "2025-05-18");
    expect(model).toHaveProperty("last_updated", "2025-05-18");
  });

  test("rejects source rows that lack an output token limit", () => {
    // Given: a new Cloud API row without max_output_length or top_provider max tokens.
    const source = nearModel({
      id: "deepseek/deepseek-v3.2",
      max_output_length: null,
      top_provider: { context_length: 128_000, is_moderated: false },
    });

    // When/Then: the provider fails instead of skipping or inventing a limit.
    expect(() => nearai.translateModel(source, { existing: () => undefined })).toThrow("output token limit");
  });
});

function nearModel(overrides: Partial<NearAIModel>): NearAIModel {
  return {
    id: "Qwen/Qwen3.6-27B-FP8",
    object: "model",
    created: 1_765_843_200,
    owned_by: "nearai",
    name: "Qwen 3.6 27B FP8",
    pricing: {
      input: 0.325,
      output: 3.25,
      prompt: "0.000000325",
      completion: "0.00000325",
      image: "0",
      request: "0",
      input_cache_read: "0.00000016",
    },
    context_length: 262_144,
    max_output_length: 8_192,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    supported_sampling_parameters: ["temperature", "top_p"],
    supported_features: ["tools", "structured_outputs", "reasoning"],
    is_ready: true,
    top_provider: {
      context_length: 262_144,
      max_completion_tokens: 8_192,
      is_moderated: false,
    },
    ...overrides,
  };
}

function existingModel(overrides: Partial<ExistingModel>): ExistingModel {
  return {
    name: "Existing Model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    tool_call: true,
    open_weights: false,
    limit: { context: 262_144, output: 8_192 },
    modalities: { input: ["text"], output: ["text"] },
    ...overrides,
  };
}
