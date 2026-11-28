import { expect, test } from "bun:test";

import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import { buildNumesModel, numes, perMillion, reasoningControls, resolveBaseModel, type NumesModel } from "../src/sync/providers/numes.js";

function numesModel(overrides: Partial<NumesModel> = {}): NumesModel {
  const price = (type: string, cost: string) => ({ type, cost, currency: "USD", unit: "token", pricing_basis: "fixed" });
  return {
    compatible_request_id: "anthropic/claude-opus-5.5",
    name: "Claude Opus 5.5",
    context_length: 1_000_000,
    max_output_length: 128_000,
    input_modalities: ["text", "file"],
    output_modalities: ["text"],
    supported_parameters: ["max_tokens", "reasoning", "structured_outputs", "temperature", "tools"],
    tasks: ["chat"],
    lowest_prices: [price("prompt", "0.000004")],
    lowest_output_prices: [price("completion", "0.00002")],
    lowest_cache_read_prices: [price("cached_prompt", "0.0000002")],
    reasoning: { supported_efforts: ["high", "low", "medium"], mandatory: false, supports_max_tokens: false },
    ...overrides,
  };
}

const translate = (model: NumesModel) => numes.translateModel(model);

test("shifts per-token decimal prices to per-million without float drift", () => {
  expect(perMillion("0.0000002")).toBe(0.2);
  expect(perMillion("0.000000844")).toBe(0.844);
  expect(perMillion("0.00001425")).toBe(14.25);
  expect(perMillion("0")).toBe(0);
  expect(perMillion("-1")).toBeUndefined();
});

test("maps a declared optional reasoning without none to a toggle and sorted efforts", () => {
  const translated = translate(numesModel());

  expect(translated).toMatchObject({
    id: "anthropic/claude-opus-5.5",
    model: {
      base_model: "anthropic/claude-opus-5-5",
      reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high"] }],
      cost: { input: 4, output: 20, cache_read: 0.2 },
    },
  });
  expect(translated && "header" in translated ? translated.header : undefined).toContain("reasoning.enabled");
});

test("treats none as the off switch and mandatory reasoning without efforts as always on", () => {
  const withNone = reasoningControls(
    numesModel({ reasoning: { supported_efforts: ["none", "low", "high"], mandatory: false, supports_max_tokens: true } }),
    "anthropic/claude-opus-5.5",
    "anthropic/claude-opus-5-5",
  );
  expect(withNone.options).toEqual([{ type: "effort", values: ["none", "low", "high"] }, { type: "budget_tokens" }]);

  const alwaysOn = reasoningControls(
    numesModel({ reasoning: { supported_efforts: [], mandatory: true, supports_max_tokens: false } }),
    "anthropic/claude-opus-5.5",
    "anthropic/claude-opus-5-5",
  );
  expect(alwaysOn.reasoning).toBe(true);
  expect(alwaysOn.options).toEqual([]);
  expect(alwaysOn.header).toContain("always on");
});

test("copies OpenRouter's controls for an undeclared reasoning model", () => {
  const controls = reasoningControls(numesModel({ reasoning: null }), "sakana/fugu-ultra", "sakana/fugu-ultra");

  expect(controls.options).toEqual([{ type: "effort", values: ["high", "xhigh", "max"] }]);
  expect(controls.header).toContain("openrouter/sakana/fugu-ultra");

  const freePeer = reasoningControls(
    numesModel({ compatible_request_id: "inclusionai/ling-3.2-flash", reasoning: null }),
    "inclusionai/ling-3.2-flash",
    "inclusionai/ling-3.2-flash",
  );
  expect(freePeer.options).toEqual([{ type: "toggle" }]);
  expect(freePeer.header).toContain("openrouter/inclusionai/ling-3.2-flash:free");
});

test("fails closed when an undeclared reasoning model has no OpenRouter or lab peer", () => {
  expect(() =>
    reasoningControls(
      numesModel({
        compatible_request_id: "baichuan/baichuan-m2-32b",
        reasoning: null,
        supported_parameters: ["max_tokens", "stop", "temperature", "top_p"],
      }),
      "baichuan/baichuan-m2-32b",
      "baichuan/baichuan-m2-32b",
    ),
  ).toThrow(MissingReasoningOptionsError);
});

test("falls back to the lab provider when OpenRouter has no peer and respects host non-reasoning", () => {
  const fromLab = reasoningControls(
    numesModel({ compatible_request_id: "qwen/qwen3.8-max", reasoning: null }),
    "qwen/qwen3.8-max",
    "alibaba/qwen3.8-max",
  );
  expect(fromLab.options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["low", "medium", "xhigh"] },
    { type: "budget_tokens" },
  ]);
  expect(fromLab.header).toContain("alibaba/qwen3.8-max");

  const disabled = reasoningControls(
    numesModel({
      compatible_request_id: "writer/palmyra-x5",
      reasoning: null,
      supported_parameters: ["max_tokens", "stop", "temperature"],
    }),
    "writer/palmyra-x5",
    "writer/palmyra-x5",
  );
  expect(disabled.reasoning).toBe(false);
  expect(disabled.header).toContain("openrouter/writer/palmyra-x5");
});

test("narrows lab modalities to exact MIME types and sets implicit cache when cache_read is priced", () => {
  const translated = translate(numesModel({ input_modalities: ["text", "image", "audio"] }));
  const v2Set = translated && "v2Set" in translated ? (translated.v2Set as Record<string, unknown>) : undefined;

  expect(v2Set?.["modalities.input"]).toEqual([
    "text",
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);
  const cacheUpdater = v2Set?.["capabilities.cache"] as (current: unknown) => unknown;
  expect(cacheUpdater(undefined)).toEqual({ implicit: true });
  expect(cacheUpdater({ explicit: true })).toEqual({ explicit: true });

  const noCache = translate(numesModel({ lowest_cache_read_prices: [] }));
  const noCacheV2 = noCache && "v2Set" in noCache ? (noCache.v2Set as Record<string, unknown>) : undefined;
  expect(noCacheV2?.["capabilities.cache"]).toBeUndefined();
});

test("lets the host turn temperature off but never on", () => {
  const off = buildNumesModel(
    numesModel({ compatible_request_id: "google/gemma-3-4b-it", supported_parameters: ["max_tokens"] }),
    "google/gemma-3-4b-it",
    {},
  );
  expect(off).toMatchObject({ temperature: false });

  const on = buildNumesModel(numesModel(), "anthropic/claude-opus-5-5", {});
  expect("temperature" in on).toBe(false);
});

test("only lowers limits and treats a zero ceiling as unknown", () => {
  const lowered = buildNumesModel(
    numesModel({ compatible_request_id: "google/gemma-3-4b-it", context_length: 32_768, max_output_length: 0 }),
    "google/gemma-3-4b-it",
    {},
  );
  expect(lowered).toMatchObject({ limit: { context: 32_768, output: 32_768 } });

  const unchanged = buildNumesModel(numesModel({ context_length: 2_000_000 }), "anthropic/claude-opus-5-5", {});
  expect("limit" in unchanged).toBe(false);
});

test("skips encrypted models silently and reports unmapped ones as missing", () => {
  const encrypted = numesModel({ compatible_request_id: "anthropic/claude-opus-5.5:e2ee" });
  expect(translate(encrypted)).toBeUndefined();
  expect(numes.sourceID(encrypted)).toBeUndefined();
  expect(numes.missingModelID(encrypted)).toBeUndefined();

  const unmapped = numesModel({ compatible_request_id: "examplelab/unknown-model", reasoning: null });
  expect(translate(unmapped)).toBeUndefined();
  expect(numes.missingModelID(unmapped)).toBe("examplelab/unknown-model");
});

test("caps output at the gateway's completion-token ceiling", () => {
  const capped = buildNumesModel(
    numesModel({ compatible_request_id: "moonshotai/kimi-k3", context_length: 1_048_576, max_output_length: 943_718 }),
    "moonshotai/kimi-k3",
    {},
  );
  expect(capped).toMatchObject({ limit: { output: 131_072 } });
});

test("assigns -free families to free routes and resolves non-OpenRouter lab slugs", () => {
  const free = buildNumesModel(
    numesModel({ compatible_request_id: "deepseek/deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (free)" }),
    "deepseek/deepseek-v4.1-flash",
    {},
  );
  expect(free).toMatchObject({ family: "deepseek-flash-free", name: "DeepSeek V4.1 Flash (free)" });

  const kimiFree = buildNumesModel(
    numesModel({ compatible_request_id: "moonshotai/kimi-k3.1-pro:free", name: "Kimi K3.1 Pro (free)" }),
    "moonshotai/kimi-k3.1-pro",
    {},
  );
  expect(kimiFree).toMatchObject({ family: "kimi-pro-free" });

  const suffixedPro = buildNumesModel(
    numesModel({ compatible_request_id: "openai/gpt-5.6-luna-pro", name: "GPT-5.6 Luna Pro" }),
    "openai/gpt-5.6-luna",
    {},
  );
  expect(suffixedPro).toMatchObject({ name: "GPT-5.6 Luna Pro" });

  const datedSnapshot = buildNumesModel(
    numesModel({ compatible_request_id: "openai/gpt-4o-mini-2024-07-18", name: "GPT-4o-mini (2024-07-18)" }),
    "openai/gpt-4o-mini",
    {},
  );
  expect(datedSnapshot).toMatchObject({ name: "GPT-4o-mini (2024-07-18)" });

  const plainBase = buildNumesModel(
    numesModel({ compatible_request_id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" }),
    "openai/gpt-5.6-luna",
    {},
  );
  expect("name" in plainBase).toBe(false);

  expect(resolveBaseModel("perplexity/sonar-pro")).toBe("perplexity/sonar-pro");
  expect(resolveBaseModel("bytedance/seed-2.0-pro")).toBe("bytedance-seed/seed-2.0-pro");
  expect(resolveBaseModel("bytedance/seed-1.8")).toBe("bytedance-seed/seed-1-8");
  expect(resolveBaseModel("mindai/macaron-v1-tall")).toBe("mindlab/macaron-v1-tall");
});

test("propagates v2_only from v2-only lab files", () => {
  const audio = translate(numesModel({ compatible_request_id: "openai/gpt-audio", reasoning: null }));
  const audioV2 = audio && "v2Set" in audio ? (audio.v2Set as Record<string, unknown>) : undefined;
  expect(audioV2?.v2_only).toBe(true);

  const regular = translate(numesModel());
  const regularV2 = regular && "v2Set" in regular ? (regular.v2Set as Record<string, unknown>) : undefined;
  expect(regularV2?.v2_only).toBeUndefined();
});

test("records custom-tool freeform exclusion in headers for OpenAI GPT-5+ and o3 models", () => {
  const gpt5 = translate(numesModel({ compatible_request_id: "openai/gpt-5.4", reasoning: null }));
  expect(gpt5 && "header" in gpt5 ? gpt5.header : undefined).toContain("custom (freeform) tools");

  const o3 = translate(numesModel({ compatible_request_id: "openai/o3", reasoning: null }));
  expect(o3 && "header" in o3 ? o3.header : undefined).toContain("custom (freeform) tools");

  const gpt4 = translate(numesModel({ compatible_request_id: "openai/gpt-4o", reasoning: null }));
  expect(gpt4 && "header" in gpt4 ? gpt4.header : undefined).toBeUndefined();
});
