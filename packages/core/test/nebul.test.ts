import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";

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
      huggingface_id: model_name ?? "zai-org/GLM-5.3",
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
  // The lab model here does not reason. A new entry keeps the factored pricing
  // and context and carries no options.
  const translated = nebul.translateModel(
    nebulEntry("mistralai/Mistral-Large-3-675B-Instruct-2512", { max_input_tokens: 1_048_576 }),
    context(undefined),
  );
  expect(translated).toMatchObject({
    id: "mistralai/Mistral-Large-3-675B-Instruct-2512",
    model: {
      base_model: "mistral/mistral-large-2512",
      cost: { input: 1.47, output: 4.62, cache_read: 0.35 },
      limit: { context: 1_048_576 },
    },
  });
  expect(translated?.model.reasoning_options).toBeUndefined();
});

test("fails closed for a new reasoner that only advertises efforts", () => {
  // Probes proved the advertised list unreliable: one catalog model advertised
  // low|medium|high|max, and its engine rejected every value but high. A new
  // reasoner must never inherit the list. The options need live probe evidence
  // first.
  const entry = nebulEntry("zai-org/GLM-5.3");
  expect(() => nebul.translateModel(entry, context(undefined))).toThrow(MissingReasoningOptionsError);
});

test("preserves authored reasoning controls when the host exposes no efforts", () => {
  const authored = [{ type: "toggle" as const }];
  const translated = nebul.translateModel(nebulEntry("zai-org/GLM-5.3", { reasoning_efforts: [] }), context(existingWith(authored)));
  expect(translated?.model.reasoning_options).toEqual(authored);
});

test("keeps authored probe-verified controls over the advertised effort list", () => {
  // Live probes on 2026-09-23 showed that the advertised list can be wrong: one
  // catalog model advertised low|medium|high|max, and its served engine rejected
  // every value but high.
  const authored = [{ type: "effort" as const, values: ["none", "high"] }];
  const translated = nebul.translateModel(nebulEntry("zai-org/GLM-5.3"), context(existingWith(authored)));
  expect(translated?.model.reasoning_options).toEqual(authored);
});

test("carries authored interleaved through sync", () => {
  const inline = nebul.translateModel(
    nebulEntry("zai-org/GLM-5.3"),
    context({ interleaved: true, reasoning_options: [{ type: "toggle" }] } as ExistingModel),
  );
  expect(inline?.model.interleaved).toBe(true);

  const named = nebul.translateModel(
    nebulEntry("someorg/Some-Model"),
    context({ interleaved: { field: "reasoning_content" }, reasoning_options: [{ type: "toggle" }] } as ExistingModel),
  );
  expect(named?.model.interleaved).toEqual({ field: "reasoning_content" });
});

test("keeps an authored reasoning = false override for a lab reasoner the host serves without thinking", () => {
  const existing = {
    base_model: "alibaba/qwen3.5-397b-a17b",
    reasoning: false,
    reasoning_options: [{ type: "effort" as const, values: ["low"] }],
    interleaved: { field: "reasoning_content" as const },
  } as ExistingModel;
  const translated = nebul.translateModel(
    nebulEntry("Qwen/Qwen3.5-397B-A17B", { reasoning_efforts: undefined }),
    context(existing),
  );
  expect(translated?.model.reasoning).toBe(false);
  expect(translated?.model.reasoning_options).toBeUndefined();
  expect(translated?.model.interleaved).toBeUndefined();
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
    reasoning_options: [{ type: "effort" as const, values: ["low", "high"] }],
  } as ExistingModel;
  const translated = nebul.translateModel(
    nebulEntry("zai-org/GLM-5.3", { input_cost_per_1m_tokens: null, output_cost_per_1m_tokens: null, max_input_tokens: null }),
    context(existing),
  );
  expect(translated).toMatchObject({
    id: "zai-org/GLM-5.3",
    model: {
      base_model: "zhipuai/glm-5.3",
      cost: { input: 1.47, output: 4.62 },
      limit: { context: 1_048_576 },
      reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    },
  });
});

test("keeps existing entries when the served alias no longer resolves to lab metadata", () => {
  const existing = {
    base_model: "zhipuai/glm-5.3",
    cost: { input: 1.47, output: 4.62 },
    limit: { context: 1_048_576 },
    reasoning_options: [{ type: "effort" as const, values: ["low", "high"] }],
  } as ExistingModel;
  const translated = nebul.translateModel(nebulEntry("someorg/Unknown-Model", { huggingface_id: null }), context(existing));
  expect(translated?.model.base_model).toBe("zhipuai/glm-5.3");
});

test("resolves base models across org renames and quantization suffixes", () => {
  const cases: [string, string | null, string][] = [
    ["zai-org/GLM-5.3", "zai-org/GLM-5.3", "zhipuai/glm-5.3"],
    ["Qwen/Qwen3.5-397B-A17B", "Qwen/Qwen3.5-397B-A17B", "alibaba/qwen3.5-397b-a17b"],
    // Hugging Face org paths are case-insensitive, so a lowercase org must
    // resolve identically.
    ["qwen/qwen3.5-397b-a17b", "qwen/qwen3.5-397b-a17b", "alibaba/qwen3.5-397b-a17b"],
    ["nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16", "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16", "nvidia/nemotron-3-super-120b-a12b"],
    ["mistralai/Mistral-Large-3-675B-Instruct-2512", "mistralai/Mistral-Large-3-675B-Instruct-2512", "mistral/mistral-large-2512"],
  ];
  // The authored options in the context keep reasoner labs out of the
  // fail-closed path. This case asserts base_model resolution only.
  for (const [model_name, huggingface_id, expected] of cases) {
    const entry = nebulEntry(model_name, { huggingface_id });
    expect(
      nebul.translateModel(entry, context(existingWith([{ type: "effort" as const, values: ["high"] }])))?.model.base_model,
    ).toBe(expected);
  }
});

test("skips out-of-scope specialized models and superseded entries silently", () => {
  for (const model_name of ["someorg/Doc-OCR-Tool", "someorg/ScanOCR-Large"]) {
    const entry = nebulEntry(model_name, {});
    expect(nebul.translateModel(entry, context(undefined))).toBeUndefined();
    expect(nebul.sourceID(entry)).toBeUndefined();
  }
  for (const display_tags of [["Guard Model"], ["Content Safety"], ["Private"], ["Internal"]]) {
    const entry = nebulEntry("someorg/Some-Model", { display_tags });
    expect(nebul.translateModel(entry, context(undefined))).toBeUndefined();
    expect(nebul.sourceID(entry)).toBeUndefined();
  }
  for (const model_name of ["someorg/Retired-Model-A", "someorg/Retired-Model-B"]) {
    const entry = nebulEntry(model_name, { superseded_by_model_name: "zai-org/GLM-5.3" });
    expect(nebul.translateModel(entry, context(undefined))).toBeUndefined();
    expect(nebul.sourceID(entry)).toBeUndefined();
  }
});

test("skips embeddings and rerankers while reporting unresolvable chat models", () => {
  const embedding = nebulEntry("someorg/Some-Embedding", { model_type: "embedding" });
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

test("fails closed on an empty catalog so sync cannot delete every local file", () => {
  expect(() => nebul.parseModels({ data: [] })).toThrow("Nebul returned an empty model catalog");
});

test("fails closed when no entry matches the chat-model filter", () => {
  expect(() =>
    nebul.parseModels({
      data: [
        { model_name: "Some/Embedding", model_info: { mode: null, model_type: "embedding" } },
        { model_name: "Some/Reranker", model_info: { mode: null, model_type: "rerank" } },
      ],
    }),
  ).toThrow("Nebul returned no usable chat models");
});

test("parseModels keeps chat entries alongside filtered serving artifacts", () => {
  const chat = { model_info: { mode: "chat", model_type: "llm" } };
  const parsed = nebul.parseModels({
    data: [
      { model_name: "Some/Embedding", model_info: { mode: null, model_type: "embedding" } },
      { model_name: "Some/Chat-A", ...chat },
      { model_name: "Some/Chat-B", ...chat },
      { model_name: "Some/Chat-C", ...chat },
      { model_name: "Some/Chat-D", ...chat },
      { model_name: "Some/Chat-E", ...chat },
      { model_name: "Some/Chat-F", ...chat },
    ],
  });
  expect(parsed).toHaveLength(7);
});

test("fails closed on a partial catalog so sync cannot prune healthy local files", () => {
  expect(() =>
    nebul.parseModels({
      data: [{ model_name: "Some/Chat", model_info: { mode: "chat", model_type: "llm" } }],
    }),
  ).toThrow("treating the catalog as a partial fault");
});

test("accepts and ignores unknown advertised reasoning effort values", () => {
  // The sync never copies the advertised list, so an unrecognized value must
  // not abort parsing. A strict enum fails the hourly run and blocks
  // cost/context refreshes for the curated models.
  const parsed = NebulResponse.parse({
    data: [{ model_name: "Some/Chat", model_info: { mode: "chat", model_type: "llm", reasoning_efforts: ["ultra"] } }],
  });
  expect(parsed.data[0]?.model_info.reasoning_efforts).toEqual(["ultra"]);

  const authored = [{ type: "effort" as const, values: ["high"] }];
  const translated = nebul.translateModel(
    nebulEntry("zai-org/GLM-5.3", { reasoning_efforts: ["ultra"] }),
    context(existingWith(authored)),
  );
  expect(translated?.model.reasoning_options).toEqual(authored);
});

// Nebul is a curated provider. Exactly the four requested flagship models ship,
// and the catalog sync must never add to or remove from that set.
const CURATED_MODEL_IDS = [
  "Qwen/Qwen3.5-397B-A17B",
  "mistralai/Mistral-Large-3-675B-Instruct-2512",
  "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16",
  "zai-org/GLM-5.3",
];

function modelFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return modelFiles(full);
    return entry.name.endsWith(".toml") ? [full] : [];
  });
}

test("ships exactly the four curated models", () => {
  const modelsDir = path.join(import.meta.dirname, "..", "..", "..", "providers", "nebul", "models");
  const ids = modelFiles(modelsDir)
    .map((file) => path.relative(modelsDir, file).replace(/\.toml$/, "").split(path.sep).join("/"))
    .sort();
  expect(ids).toEqual([...CURATED_MODEL_IDS].sort());
});

test("sync cannot grow or shrink the curated catalog", () => {
  expect(nebul.skipCreates).toBe(true);
  expect(nebul.deleteMissing).toBe(false);
  expect(nebul.trackMissingModels).toBe(false);
});
