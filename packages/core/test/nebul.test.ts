import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  NebulEntry,
  NebulResponse,
  nebul,
} from "../src/sync/providers/nebul.js";

function nebulEntry(model_name?: string, model_info: Record<string, unknown> = {}): NebulEntry {
  return NebulEntry.parse({
    model_name: model_name ?? "zai-org/GLM-5.3",
    model_info: {
      description: "test",
      huggingface_id: "zai-org/GLM-5.3",
      input_cost_per_1m_tokens: 1.47,
      output_cost_per_1m_tokens: 4.62,
      cache_read_input_cost_per_1m_tokens: 0.35,
      max_input_tokens: 1_000_000,
      mode: "chat",
      model_type: "llm",
      reasoning_efforts: ["low", "high", "max"],
      ...model_info,
    },
  });
}

function existingWith(reasoning_options: ExistingModel["reasoning_options"]): ExistingModel {
  return { reasoning_options } as ExistingModel;
}

const context = (existing: ExistingModel | undefined) => ({ existing: () => existing });

test("syncs Nebul's factored overrides against resolved lab metadata", () => {
  const translated = nebul.translateModel(nebulEntry("zai-org/GLM-5.3", { max_input_tokens: 1_048_576 }), context(undefined));
  expect(translated).toMatchObject({
    id: "zai-org/GLM-5.3",
    model: {
      base_model: "zhipuai/glm-5.3",
      cost: { input: 1.47, output: 4.62, cache_read: 0.35 },
      limit: { context: 1_048_576 },
      reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    },
  });
});

test("preserves authored reasoning controls when the host exposes no efforts", () => {
  const authored = [{ type: "toggle" as const }];
  const translated = nebul.translateModel(nebulEntry("zai-org/GLM-5.3", { reasoning_efforts: [] }), context(existingWith(authored)));
  expect(translated?.model.reasoning_options).toEqual(authored);
});

test("replaces authored options with the advertised effort entry when efforts are advertised", () => {
  const authored = [
    { type: "toggle" as const },
    { type: "budget_tokens" as const },
    { type: "effort" as const, values: ["low"] },
  ];
  const translated = nebul.translateModel(nebulEntry("zai-org/GLM-5.3"), context(existingWith(authored)));
  expect(translated?.model.reasoning_options).toEqual([{ type: "effort", values: ["low", "high", "max"] }]);
});

test("carries authored interleaved through sync", () => {
  const inline = nebul.translateModel(nebulEntry("zai-org/GLM-5.3"), context({ interleaved: true } as ExistingModel));
  expect(inline?.model.interleaved).toBe(true);

  const named = nebul.translateModel(
    nebulEntry("deepseek-ai/DeepSeek-V4.1-Flash"),
    context({ interleaved: { field: "reasoning_content" } } as ExistingModel),
  );
  expect(named?.model.interleaved).toEqual({ field: "reasoning_content" });
});

test("keeps authored effort sets when the host advertises none", () => {
  const authored = [{ type: "effort" as const, values: ["low", "high", "max"] }];
  const translated = nebul.translateModel(
    nebulEntry("moonshotai/Kimi-K3", { reasoning_efforts: [] }),
    context(existingWith(authored)),
  );
  expect(translated?.model.reasoning_options).toEqual(authored);
});

test("fails closed when a reasoner advertises no efforts and none are authored", () => {
  const entry = nebulEntry("zai-org/GLM-5.3", { reasoning_efforts: [] });
  expect(() => nebul.translateModel(entry, context(undefined))).toThrow(MissingReasoningOptionsError);
  expect(() =>
    nebul.translateModel(entry, context({ base_model: "zhipuai/glm-5.3" } as ExistingModel)),
  ).toThrow(MissingReasoningOptionsError);
});

test("keeps existing entries when the source pricing or context is temporarily null", () => {
  const existing = {
    base_model: "zhipuai/glm-5.3",
    cost: { input: 1.47, output: 4.62 },
    limit: { context: 1_048_576 },
  } as ExistingModel;
  const translated = nebul.translateModel(
    nebulEntry("zai-org/GLM-5.3", { input_cost_per_1m_tokens: null, output_cost_per_1m_tokens: null, max_input_tokens: null }),
    context(existing),
  );
  expect(translated).toMatchObject({
    id: "zai-org/GLM-5.3",
    model: { base_model: "zhipuai/glm-5.3", cost: { input: 1.47, output: 4.62 }, limit: { context: 1_048_576 } },
  });
});

test("keeps existing entries when the served alias no longer resolves to lab metadata", () => {
  const existing = {
    base_model: "zhipuai/glm-5.3",
    cost: { input: 1.47, output: 4.62 },
    limit: { context: 1_048_576 },
  } as ExistingModel;
  const translated = nebul.translateModel(nebulEntry("someorg/Unknown-Model", { huggingface_id: null }), context(existing));
  expect(translated?.model.base_model).toBe("zhipuai/glm-5.3");
});

test("resolves base models across org renames and quantization suffixes", () => {
  const cases: [string, string | null, string][] = [
    ["Qwen/Qwen3.8-27B-FP8", "Qwen/Qwen3.8-27B-FP8", "alibaba/qwen3.8-27b"],
    ["nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16", "nvidia/nemotron-3-nano-30b-a3b"],
    ["mistralai/Mistral-Large-3-675B-Instruct-2512", "mistralai/Mistral-Large-3-675B-Instruct-2512", "mistral/mistral-large-2512"],
    ["mistralai/Mistral-Medium-3.5-128B", "mistralai/Mistral-Medium-3.5-128B", "mistral/mistral-medium-2604"],
  ];
  for (const [model_name, huggingface_id, expected] of cases) {
    const entry = nebulEntry(model_name, { huggingface_id });
    expect(nebul.translateModel(entry, context(undefined))?.model.base_model).toBe(expected);
  }
});

test("skips the ping model, serving artifacts, and deprecated entries silently", () => {
  for (const model_name of ["Nebul/Ping", "zai-org/GLM-5.1-FP8", "zai-org/GLM-5.2-FP8", "Nebul-OCR/Some-OCR", "Qwen/Qwen3Guard-Something"]) {
    const entry = nebulEntry(model_name, {});
    expect(nebul.translateModel(entry, context(undefined))).toBeUndefined();
    expect(nebul.sourceID(entry)).toBeUndefined();
  }
});

test("skips embeddings and rerankers while reporting unresolvable chat models", () => {
  const embedding = nebulEntry("BAAI/bge-m3", { model_type: "embedding" });
  expect(nebul.translateModel(embedding, context(undefined))).toBeUndefined();
  expect(nebul.sourceID(embedding)).toBeUndefined();

  const chat = nebulEntry("mistralai/Mistral-Large-3-675B-Instruct-2512", { huggingface_id: null });
  expect(nebul.translateModel(chat, context(undefined))).toBeDefined();
  expect(nebul.sourceID(chat)).toBe("mistralai/Mistral-Large-3-675B-Instruct-2512");
});

test("skips chat models whose pricing or context is absent instead of crashing", () => {
  const unpriced = nebulEntry("zai-org/GLM-5.3", { input_cost_per_1m_tokens: null, output_cost_per_1m_tokens: null, max_input_tokens: null });
  expect(nebul.translateModel(unpriced, context(undefined))).toBeUndefined();
  expect(nebul.sourceID(unpriced)).toBe("zai-org/GLM-5.3");
});

test("parses nullable serving artifacts and unknown-host metadata from /model/info", () => {
  const parsed = NebulResponse.parse({
    data: [
      { model_name: "Some/Embedding", model_info: { mode: null, model_type: "embedding" } },
      { model_name: "Some/Chat", model_info: { mode: "chat", model_type: "llm", unknown_host_field: true } },
    ],
  });
  expect(parsed.data).toHaveLength(2);
});

test("rejects unknown reasoning effort values from the host", () => {
  expect(() =>
    NebulResponse.parse({
      data: [{ model_name: "Some/Chat", model_info: { mode: "chat", model_type: "llm", reasoning_efforts: ["ultra"] } }],
    }),
  ).toThrow();
});
