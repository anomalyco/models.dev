import { expect, test } from "bun:test";

import { groups, providers, type ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  buildTensorXModel,
  tensorx,
  type TensorXModel,
  type TensorXModelInfo,
} from "../src/sync/providers/tensorx.js";

function info(overrides: Partial<TensorXModelInfo> = {}): TensorXModelInfo {
  return {
    mode: "chat",
    max_input_tokens: 262_144,
    max_output_tokens: 64_000,
    max_tokens: 262_144,
    input_cost_per_token: 1.5e-6,
    output_cost_per_token: 4.5e-6,
    cache_read_input_token_cost: 3.75e-7,
    cache_creation_input_token_cost: null,
    supports_vision: true,
    supports_pdf_input: null,
    supports_audio_input: null,
    supports_audio_output: null,
    supports_reasoning: true,
    supports_function_calling: true,
    supports_response_schema: null,
    supported_openai_params: ["temperature", "tools"],
    ...overrides,
  };
}

function model(id: string, overrides: Partial<TensorXModelInfo> = {}): TensorXModel {
  return { model_name: id, model_info: info(overrides) };
}

const existingGlm: ExistingModel = {
  base_model: "zhipuai/glm-5.3",
  reasoning: true,
  reasoning_options: [{ type: "toggle" }],
  temperature: false,
  structured_output: true,
  cost: { input: 1.75, output: 4.5, cache_read: 0.44 },
  limit: { context: 1_048_576, output: 64_000 },
};

const context = (models: Record<string, ExistingModel>) => ({
  existing: (id: string) => models[id],
  authored: (id: string) => models[id],
});

test("TensorX sync is registered for direct and hourly runs", () => {
  expect(providers.tensorx).toBe(tensorx);
  expect(groups.direct).toContain("tensorx");
});

test("null capability flags keep the authored values", () => {
  const synced = buildTensorXModel(
    model("z-ai/glm-5.3", { supports_reasoning: null, supports_function_calling: null, supports_vision: null }),
    { ...existingGlm, tool_call: true },
    undefined,
  );
  // Reasoning and tool calling equal the lab card, so nothing is restated;
  // authored host values that differ from the lab survive.
  expect(synced).toMatchObject({
    reasoning_options: existingGlm.reasoning_options,
    structured_output: true,
    temperature: false,
  });
  expect("reasoning" in synced).toBe(false); // lab owns it; never restated as false
  expect("tool_call" in synced).toBe(false);
});

test("a null reasoning flag on a new model is withheld like a true one", () => {
  expect(() =>
    buildTensorXModel(model("deepseek/deepseek-v7", { supports_reasoning: null }), undefined, undefined),
  ).toThrow(MissingReasoningOptionsError);
});

test("embeddings never reason, so null reasoning does not withhold them", () => {
  const synced = buildTensorXModel(
    model("qwen/qwen3-embedding-8b", {
      mode: "embedding",
      supports_reasoning: null,
      output_cost_per_token: null,
    }),
    undefined,
    undefined,
  );
  expect("base_model" in synced ? synced.base_model : undefined).toBe("alibaba/qwen3-embedding-8b");
});

test("authored cache prices survive gateway-null cache flags", () => {
  const synced = buildTensorXModel(
    model("z-ai/glm-5.3", { cache_creation_input_token_cost: null, cache_read_input_token_cost: null }),
    { ...existingGlm, cost: { input: 1.75, output: 4.5, cache_read: 0.44, cache_write: 1.1 } },
    undefined,
  );
  expect(synced).toMatchObject({ cost: { cache_read: 0.44, cache_write: 1.1 } });
});

test("parseModels merges per-deployment rows deterministically", () => {
  const merged = tensorx.parseModels({
    data: [
      { model_name: "z-ai/glm-5.3", model_info: info({ max_output_tokens: 64_000, input_cost_per_token: 1e-6 }) },
      { model_name: "z-ai/glm-5.3", model_info: info({ max_output_tokens: 32_768, supports_vision: false, input_cost_per_token: 2e-6 }) },
      { model_name: "z-ai/glm-5.3", model_info: info({ max_output_tokens: 64_000, input_cost_per_token: 1.5e-6 }) },
    ],
  });
  expect(merged).toHaveLength(1);
  expect(merged[0].model_info.max_output_tokens).toBe(32_768);
  // Priced at the highest charging deployment: the catalog must not
  // under-report what a request can cost.
  expect(merged[0].model_info.input_cost_per_token).toBe(2e-6);
  // Deployments disagree on vision: the sync stays conservative (no image
  // support advertised) and reports the conflict via sourceNotices.
  expect(merged[0].model_info.supports_vision).toBe(false);
  expect(tensorx.sourceNotices!()).toEqual(
    expect.arrayContaining([expect.stringMatching(/z-ai\/glm-5\.3.*supports_vision/)]),
  );
});

test("reasoning-control conflicts keep authored controls and keep the notice", () => {
  const merged = tensorx.parseModels({
    data: [
      { model_name: "z-ai/glm-5.3", model_info: info({ supports_reasoning: true }) },
      { model_name: "z-ai/glm-5.3", model_info: info({ supports_reasoning: false }) },
    ],
  })[0];
  const synced = buildTensorXModel(merged, existingGlm, undefined);
  expect(synced).toMatchObject({ reasoning_options: existingGlm.reasoning_options });
  if ("reasoning" in synced) expect(synced.reasoning).not.toBe(false);
  expect(tensorx.sourceNotices!()).toEqual(
    expect.arrayContaining([expect.stringMatching(/supports_reasoning/)]),
  );
});

test("mode conflicts resolve by majority with a deterministic tie-break", () => {
  const merged = tensorx.parseModels({
    data: [
      { model_name: "moonshotai/kimi-k3", model_info: info({ mode: "chat" }) },
      { model_name: "moonshotai/kimi-k3", model_info: info({ mode: "completion" }) },
      { model_name: "moonshotai/kimi-k3", model_info: info({ mode: "chat" }) },
    ],
  });
  expect(merged[0].model_info.mode).toBe("chat");
});

test("parseModels resets conflict notices between calls", () => {
  tensorx.parseModels({
    data: [
      { model_name: "z-ai/glm-5.3", model_info: info({ max_output_tokens: 1 }) },
      { model_name: "z-ai/glm-5.3", model_info: info({ max_output_tokens: 2 }) },
    ],
  });
  expect(tensorx.sourceNotices!()).not.toHaveLength(0);
  tensorx.parseModels({ data: [{ model_name: "z-ai/glm-5.3", model_info: info() }] });
  expect(tensorx.sourceNotices!()).toHaveLength(0);
});

test("parseModels refuses to run on an empty or chat-less list", () => {
  expect(() => tensorx.parseModels({ data: [] })).toThrow("empty model list");
  expect(() =>
    tensorx.parseModels({ data: [{ model_name: "whisper", model_info: info({ mode: "audio_transcription" }) }] }),
  ).toThrow("none in a chat mode");
});

test("base-model sync does not restate lab modalities", () => {
  const synced = buildTensorXModel(model("z-ai/glm-5.3"), existingGlm, undefined);
  expect("modalities" in synced && synced.modalities !== undefined).toBe(false);
  expect(synced).toMatchObject({
    cost: { input: 1.5, output: 4.5, cache_read: 0.375 },
    limit: { context: 262_144, output: 64_000 },
  });
});

test("a new reasoning model without known controls raises MissingReasoningOptionsError", () => {
  expect(() =>
    buildTensorXModel(model("deepseek/deepseek-v7", { supports_reasoning: true }), undefined, undefined),
  ).toThrow(MissingReasoningOptionsError);
});

test("embeddings sync as type embedding with lab-inherited limits", () => {
  const synced = buildTensorXModel(
    model("qwen/qwen3-embedding-8b", {
      mode: "embedding",
      max_input_tokens: 40_960,
      max_output_tokens: null,
      output_cost_per_token: null,
      supports_reasoning: false,
      supports_vision: false,
    }),
    { tool_call: false, structured_output: undefined, limit: { context: 40_960, output: 0 } },
    undefined,
  );
  // Lab card already types it as an embedding model with output 0; the host
  // file restates only cost and the wider read context.
  expect(synced).toMatchObject({
    cost: { input: 1.5, output: 0 },
    limit: { context: 40_960 },
  });
  // The lab card (context 32_768, output 0) owns the output limit; the host
  // file restates only the wider input context.
  expect("limit" in synced && synced.limit !== undefined ? synced.limit.output : undefined).toBeUndefined();
  if ("structured_output" in synced) expect(synced.structured_output).not.toBe(false);
});

test("non-chat modes keep authored entries or get skipped", () => {
  const whisper = model("Systran/faster-whisper-large-v3", { mode: "audio_transcription" });
  expect(tensorx.translateModel(whisper, context({}))).toBeUndefined();
  const authored: ExistingModel = { name: "Whisper" };
  expect(tensorx.translateModel(whisper, context({ [whisper.model_name]: authored }))).toMatchObject({
    model: authored,
  });
  // Unsyncable modes are reported (as skip notices) rather than silently dropped.
  expect(tensorx.sourceID!(model("some/rerank", { mode: "rerank" }))).toBe("some/rerank");
});

test("non-canonical models keep existing name and dates", () => {
  const existing: ExistingModel = {
    name: "Custom Name",
    release_date: "2026-01-15",
    last_updated: "2026-02-01",
    reasoning: false,
  };
  const synced = buildTensorXModel(
    model("chatterbox/custom-chat", { supports_reasoning: false, supports_vision: false }),
    existing,
    existing,
  ) as { name: string; release_date: string; last_updated: string };
  expect(synced.name).toBe("Custom Name");
  expect(synced.release_date).toBe("2026-01-15");
  expect(synced.last_updated).toBe("2026-02-01");
});
