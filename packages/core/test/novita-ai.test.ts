import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { groups, providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import { fetchNovitaAIModels, NovitaAIResponse, novitaAi, type NovitaAIModel } from "../src/sync/providers/novita-ai.js";

function novitaAiModel(overrides: Partial<NovitaAIModel> = {}): NovitaAIModel {
  return {
    id: "deepseek/deepseek-v3.2",
    object: "model",
    created: 1_765_440_000,
    owned_by: "novita",
    ...overrides,
  };
}

test("parses Novita AI API response", () => {
  const parsed = NovitaAIResponse.parse({
    data: [
      novitaAiModel(),
      novitaAiModel({ id: "meta-llama/llama-3.3-70b-instruct", created: 1_733_635_200 }),
    ],
  });
  expect(parsed.data).toHaveLength(2);
  expect(parsed.data[0]?.id).toBe("deepseek/deepseek-v3.2");
  expect(parsed.data[1]?.id).toBe("meta-llama/llama-3.3-70b-instruct");
});

test("accepts the standard OpenAI list marker when present", () => {
  expect(NovitaAIResponse.parse({ object: "list", data: [novitaAiModel()] }).data).toHaveLength(1);
});

test("accepts Novita non-LLM catalog entries with zero context size", () => {
  expect(NovitaAIResponse.parse({ data: [novitaAiModel({ id: "image/design", context_size: 0 })] }).data[0]?.context_size).toBe(0);
});

test("maps Novita catalog metadata onto existing models", () => {
  const translated = novitaAi.translateModel(novitaAiModel({
    display_name: "GLM 5.3 Flash",
    description: "Updated description",
    context_size: 1_048_576,
    max_output_tokens: 131_072,
    features: ["function-calling", "structured-outputs", "reasoning"],
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    pricing: {
      prompt: { price_per_m_decimal: "0.15" },
      completion: { price_per_m_decimal: "0.5" },
      input_cache_read: { price_per_m_decimal: "0.03" },
    },
  }), {
    existing: () => ({}),
    authored: () => ({ base_model: "deepseek/deepseek-v3.2", name: "Old", description: "Old", attachment: false, reasoning: false, tool_call: false, open_weights: true, limit: { context: 1, output: 1 }, modalities: { input: ["text"], output: ["text"] } }),
  });
  expect(translated?.model).toMatchObject({ name: "GLM 5.3 Flash", limit: { context: 1_048_576, output: 131_072 }, cost: { input: 0.15, output: 0.5, cache_read: 0.03 }, modalities: { input: ["text", "image"] } });
});

test("rejects invalid Novita AI API responses", () => {
  expect(() => NovitaAIResponse.parse({ data: [] })).toThrow();
  expect(() => NovitaAIResponse.parse({ object: "list", data: [{ id: "bad", object: "not-model", created: 1, owned_by: "" }] }))
    .toThrow();
  expect(() => NovitaAIResponse.parse({ object: "list", data: [{ id: "", object: "model", created: -1, owned_by: "" }] }))
    .toThrow();
});

test("Novita AI sync retains prices absent from the API", () => {
  const existing = {
    base_model: "deepseek/deepseek-v3",
    cost: { input: 1, output: 2, cache_read: 0.2, cache_write: 1.5625, input_audio: 2.2, output_audio: 1.788, reasoning: 0.4 },
  };
  const result = novitaAi.translateModel(novitaAiModel({
    id: "deepseek/deepseek-v3", features: [],
    pricing: { prompt: { price_per_m_decimal: "0.7" }, completion: { price_per_m_decimal: "1.5" }, input_cache_read: { price_per_m_decimal: "0.1" } },
  }), { authored: () => existing, existing: () => existing });
  expect(result?.model.cost).toMatchObject({
    input: 0.7, output: 1.5, cache_read: 0.1, cache_write: 1.5625,
    input_audio: 2.2, output_audio: 1.788, reasoning: 0.4,
  });
});

test("Novita AI sync preserves optional tier prices only at matching thresholds", () => {
  const existing = {
    base_model: "deepseek/deepseek-v3",
    cost: {
      input: 1, output: 2, cache_write: 0.3, input_audio: 2.2,
      tiers: [{ tier: { type: "context" as const, size: 256_000 }, input: 3, output: 4, cache_write: 0.7 },
        { tier: { type: "context" as const, size: 500_000 }, input: 5, output: 6, cache_write: 0.9 }],
    },
  };
  const result = novitaAi.translateModel(novitaAiModel({
    id: "deepseek/deepseek-v3", features: [], is_tiered_billing: true,
    tiered_billing_configs: [
      { min_tokens: 1, max_tokens: 256_000, pricing: { prompt: { price_per_m_decimal: "1.5" }, completion: { price_per_m_decimal: "2.5" } } },
      { min_tokens: 256_000, max_tokens: 750_000, pricing: { prompt: { price_per_m_decimal: "3.5" }, completion: { price_per_m_decimal: "4.5" } } },
      { min_tokens: 750_000, max_tokens: 1_000_000, pricing: { prompt: { price_per_m_decimal: "5.5" }, completion: { price_per_m_decimal: "6.5" } } },
    ],
  }), { authored: () => existing, existing: () => existing });
  expect(result?.model.cost).toMatchObject({
    input: 1.5, output: 2.5, cache_write: 0.3, input_audio: 2.2,
    tiers: [
      { tier: { size: 256_000 }, input: 3.5, output: 4.5, cache_write: 0.7 },
      { tier: { size: 750_000 }, input: 5.5, output: 6.5 },
    ],
  });
  expect(result?.model.cost?.tiers?.[1]?.cache_write).toBeUndefined();
});

test("Novita AI sync preserves authored metadata for existing models", () => {
  const authored: ExistingModel = {
    base_model: "deepseek/deepseek-v3.2",
    name: "Deepseek V3.2",
    description: "DeepSeek chat model for instruction following, coding, and analysis",
    family: "deepseek",
    release_date: "2025-12-01",
    last_updated: "2025-12-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "toggle" } as const],
    temperature: true,
    tool_call: true,
    structured_output: true,
    open_weights: true,
    cost: { input: 0.269, output: 0.4, cache_read: 0.1345 },
    limit: { context: 163_840, output: 65_536 },
    interleaved: { field: "reasoning_content" },
    modalities: { input: ["text"], output: ["text"] },
  };

  const translated = novitaAi.translateModel(novitaAiModel(), {
    existing: () => authored,
    authored: () => authored,
  });

  expect(translated).toMatchObject({ id: "deepseek/deepseek-v3.2", model: {
    base_model: authored.base_model,
    reasoning_options: authored.reasoning_options,
    interleaved: authored.interleaved,
    cost: authored.cost,
  } });
});

test("Novita AI sync creates non-reasoning models with a known lab base and a price", () => {
  const translated = novitaAi.translateModel(novitaAiModel({ id: "deepseek/deepseek-v3", context_size: 8192, max_output_tokens: 4096, features: [], pricing: { prompt: { price_per_m_decimal: "0.1" }, completion: { price_per_m_decimal: "0.2" } } }), {
    existing: () => undefined,
    authored: () => undefined,
  });
  expect(translated?.id).toBe("deepseek/deepseek-v3");
  expect(translated?.model).toMatchObject({ base_model: "deepseek/deepseek-v3", limit: { context: 8192, output: 4096 }, cost: { input: 0.1, output: 0.2 } });
});

test("Novita AI sync skips new models with unknown lab, price, or reasoning controls", () => {
  const context = { existing: () => undefined, authored: () => undefined };
  const price = { prompt: { price_per_m_decimal: "0.1" }, completion: { price_per_m_decimal: "0.2" } };
  expect(novitaAi.translateModel(novitaAiModel({ id: "novita/unknown-model", pricing: price }), context)).toBeUndefined();
  expect(novitaAi.translateModel(novitaAiModel({ id: "deepseek/deepseek-v3", features: [] }), context)).toBeUndefined();
  expect(novitaAi.translateModel(novitaAiModel({ id: "deepseek/deepseek-v3", features: ["reasoning"], pricing: price }), context)).toBeUndefined();
});

test("Novita AI sync treats explicit zero prices without tiers as free", () => {
  const model = novitaAiModel({
    id: "inclusionai/ling-3.0-flash-fin",
    input_token_price_per_m: 0,
    output_token_price_per_m: 0,
    features: ["reasoning"],
  });
  expect(novitaAi.translateModel(model, { existing: () => undefined, authored: () => undefined })?.model)
    .toMatchObject({ base_model: "inclusionai/ling-3.0-flash-fin", reasoning_options: [{ type: "toggle" }], cost: { input: 0, output: 0 } });
  const authored = { base_model: "inclusionai/ling-3.0-flash-fin", reasoning_options: [] };
  const translated = novitaAi.translateModel(model, { existing: () => authored, authored: () => authored });
  expect(translated?.model).toMatchObject({
    base_model: "inclusionai/ling-3.0-flash-fin", cost: { input: 0, output: 0 },
  });
  expect(translated?.model.cost).not.toHaveProperty("base_model");
});

test("Novita AI sync does not mistake tier-only pricing for free", () => {
  const translated = novitaAi.translateModel(novitaAiModel({
    id: "deepseek/deepseek-v3",
    input_token_price_per_m: 0,
    output_token_price_per_m: 0,
    is_tiered_billing: true,
    features: [],
    tiered_billing_configs: [{
      min_tokens: 1, max_tokens: 10_000,
      pricing: { prompt: { price_per_m_decimal: "0.5" }, completion: { price_per_m_decimal: "2" } },
    }],
  }), { existing: () => undefined, authored: () => undefined });
  expect(translated?.model).toMatchObject({ cost: { input: 0.5, output: 2 } });
});

test("Novita AI sync reuses a verified lab alias and fixed R1 controls", () => {
  const context = { existing: () => undefined, authored: () => undefined };
  const pricing = { prompt: { price_per_m_decimal: "0.89" }, completion: { price_per_m_decimal: "0.89" } };
  expect(novitaAi.translateModel(novitaAiModel({
    id: "deepseek/deepseek_v3", features: [], pricing,
  }), context)?.model).toMatchObject({ base_model: "deepseek/deepseek-v3" });
  expect(novitaAi.translateModel(novitaAiModel({
    id: "deepseek/deepseek-r1", features: ["reasoning"], pricing,
  }), context)?.model).toMatchObject({ base_model: "deepseek/deepseek-r1", reasoning_options: [] });
});

test("Novita AI sync updates V4.1 Flash prices while retaining its verified toggle", () => {
  const authored: ExistingModel = {
    base_model: "deepseek/deepseek-v4.1-flash",
    reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
    interleaved: { field: "reasoning_content" },
    cost: { input: 1, output: 2 },
  };
  const translated = novitaAi.translateModel(novitaAiModel({
    id: "deepseek/deepseek-v4.1-flash",
    context_size: 1_048_576,
    max_output_tokens: 393_216,
    features: ["reasoning", "function-calling", "structured-outputs"],
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    pricing: {
      prompt: { price_per_m_decimal: "0.3" },
      completion: { price_per_m_decimal: "1.2" },
      input_cache_read: { price_per_m_decimal: "0.006" },
    },
  }), { authored: () => authored, existing: () => authored });
  expect(translated?.model).toMatchObject({
    base_model: authored.base_model,
    reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
    interleaved: { field: "reasoning_content" },
    cost: { input: 0.3, output: 1.2, cache_read: 0.006 },
    limit: { context: 1_048_576, output: 393_216 },
  });
  expect(translated?.model).not.toHaveProperty("description");
});

test("Novita AI sync creates only explicitly verified new reasoners", () => {
  const context = { authored: () => undefined, existing: () => undefined };
  const pricing = { prompt: { price_per_m_decimal: "0.15" }, completion: { price_per_m_decimal: "0.5" } };
  for (const id of ["qwen/qwen3.8-flash", "minimax/minimax-m3", "zai-org/glm-5.3", "deepseek/deepseek-v4-flash-0731"]) {
    const translated = novitaAi.translateModel(novitaAiModel({ id, features: ["reasoning"], pricing }), context);
    expect(translated?.model).toMatchObject({
      reasoning_options: id.startsWith("qwen/")
        ? [{ type: "toggle" }, { type: "budget_tokens" }]
        : id === "deepseek/deepseek-v4-flash-0731"
          ? [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }]
          : [{ type: "toggle" }],
      interleaved: { field: "reasoning_content" },
    });
    expect(translated?.header).toContain("thinking.type = enabled|disabled");
    if (id === "zai-org/glm-5.3") expect(translated?.model).not.toHaveProperty("description");
  }
  for (const id of ["zai-org/glm-5.3-flash", "deepseek/deepseek-v4-pro-0813", "qwen/qwen3.8-2.4t-a95b"]) {
    expect(novitaAi.translateModel(novitaAiModel({ id, features: ["reasoning"], pricing }), context)).toBeUndefined();
  }
});

test("Novita AI keeps verified DeepSeek and Qwen controls on re-sync", () => {
  const context = { authored: () => undefined, existing: () => undefined };
  const pricing = { prompt: { price_per_m_decimal: "0.1" }, completion: { price_per_m_decimal: "0.2" } };
  expect(novitaAi.translateModel(novitaAiModel({ id: "deepseek/deepseek-v4-flash-0731", features: ["reasoning"], pricing }), context)?.model)
    .toMatchObject({ reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }] });
  expect(novitaAi.translateModel(novitaAiModel({ id: "deepseek/deepseek-v4-flash-vision-exp", features: ["reasoning"], pricing }), context)?.model)
    .toMatchObject({ reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }] });
  for (const id of ["qwen/qwen3.6-27b", "qwen/qwen3.6-35b-a3b", "qwen/qwen3.6-plus", "qwen/qwen3.8-27b", "qwen/qwen3.8-flash", "qwen/qwen3.8-max"]) {
    expect(novitaAi.translateModel(novitaAiModel({ id, features: ["reasoning"], pricing }), context)?.model)
      .toMatchObject({ reasoning_options: [{ type: "toggle" }, { type: "budget_tokens" }] });
  }
});

test("Novita AI sync inherits capabilities from partial feature lists", () => {
  const authored: ExistingModel = {
    name: "DeepSeek", description: "DeepSeek", attachment: false, open_weights: true,
    limit: { context: 1000, output: 100 }, modalities: { input: ["text"], output: ["text"] },
    base_model: undefined, reasoning: true, tool_call: true,
    reasoning_options: [{ type: "toggle" }],
  };
  const translated = novitaAi.translateModel(novitaAiModel({ id: "novita/custom", features: ["serverless"] }), {
    authored: () => authored, existing: () => authored,
  });
  expect(translated?.model).toMatchObject({ reasoning: true, tool_call: true, reasoning_options: [{ type: "toggle" }] });
});

test("Novita AI sync treats verified Qwen reasoning behavior per model", () => {
  const price = { prompt: { price_per_m_decimal: "0.1" }, completion: { price_per_m_decimal: "0.2" } };
  const context = { authored: () => undefined, existing: () => undefined };
  expect(novitaAi.translateModel(novitaAiModel({ id: "qwen/qwen3-max", features: ["reasoning"], pricing: price }), context)?.model)
    .toMatchObject({ reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "budget_tokens" }] });
  expect(novitaAi.translateModel(novitaAiModel({ id: "qwen/qwen3-next-80b-a3b-instruct", features: ["reasoning"], pricing: price }), context)?.model)
    .not.toHaveProperty("reasoning_options");
  expect(novitaAi.translateModel(novitaAiModel({ id: "qwen/qwen3-next-80b-a3b-instruct", features: ["reasoning"], pricing: price }), context)?.model)
    .not.toHaveProperty("reasoning_options");
});

test("Novita AI sync maps tiered context prices and cache-write", () => {
  const pricing = (input: string, output: string, cacheWrite: string) => ({
    prompt: { price_per_m_decimal: input },
    completion: { price_per_m_decimal: output },
    input_cache_write: { price_per_m_decimal: cacheWrite },
  });
  const result = novitaAi.translateModel(novitaAiModel({
    id: "deepseek/deepseek-v3",
    features: [],
    is_tiered_billing: true,
    tiered_billing_configs: [
      { min_tokens: 256_000, max_tokens: 1_000_000, pricing: pricing("0.5", "3", "0.625") },
      { min_tokens: 1, max_tokens: 256_000, pricing: pricing("0.4", "2.4", "0.5") },
    ],
  }), { existing: () => undefined, authored: () => undefined });
  expect(result?.model).toMatchObject({ cost: {
    input: 0.4, output: 2.4, cache_write: 0.5,
    tiers: [{ tier: { type: "context", size: 256_000 }, input: 0.5, output: 3, cache_write: 0.625 }],
  } });
});

test("Novita AI sync preserves inherited capabilities when features are absent", () => {
  const authored = { base_model: "deepseek/deepseek-v3.2", cost: { input: 0.1, output: 0.2 } };
  const resolved = { ...authored, reasoning: true, tool_call: true, modalities: { input: ["text" as const], output: ["text" as const] } };
  const translated = novitaAi.translateModel(novitaAiModel(), {
    authored: () => authored,
    existing: () => resolved,
  });
  expect(translated?.model).toMatchObject({ base_model: authored.base_model });
  expect(translated?.model).not.toHaveProperty("reasoning", false);
  expect(translated?.model).not.toHaveProperty("tool_call", false);
});

test("Novita AI sync updates existing inline model capabilities", () => {
  const existing = {
    name: "Old", description: "Old", reasoning: false, tool_call: false,
    attachment: false, open_weights: false, release_date: "2025-01-01", last_updated: "2025-01-01",
    limit: { context: 8192, output: 4096 }, modalities: { input: ["text" as const], output: ["text" as const] },
  };
  const translated = novitaAi.translateModel(novitaAiModel({
    id: "novita/custom-model",
    display_name: "Updated", features: ["reasoning", "function-calling"],
    input_modalities: ["text", "image"],
  }), { authored: () => existing, existing: () => existing });
  expect(translated?.model).toMatchObject({
    name: "Updated", reasoning: true, tool_call: true, attachment: true,
    modalities: { input: ["text", "image"] },
  });
});

test("Novita AI sync retains local models absent from API response", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-novita-ai-"));
  const modelsDir = path.join(dir, "providers", "novita-ai", "models");
  await mkdir(modelsDir, { recursive: true });
  await Bun.write(path.join(modelsDir, "deepseek", "deepseek-v3.2.toml"), [
    'name = "Deepseek V3.2"',
    'description = "DeepSeek chat model for instruction following, coding, and analysis"',
    'family = "deepseek"',
    'release_date = "2025-12-01"',
    'last_updated = "2025-12-01"',
    "attachment = false",
    "reasoning = true",
    "reasoning_options = [{ type = \"toggle\" }]",
    "temperature = true",
    "tool_call = true",
    "structured_output = true",
    "open_weights = true",
    "",
    "[interleaved]",
    'field = "reasoning_content"',
    "",
    "[cost]",
    "input = 0.269",
    "output = 0.4",
    "cache_read = 0.1345",
    "",
    "[limit]",
    "context = 163_840",
    "output = 65_536",
    "",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
    "",
  ].join("\n"));

  try {
    const result = await syncProvider({
      ...novitaAi,
      modelsDir,
      maxMissingFraction: 1,
      async fetchModels() {
        return {
          object: "list",
          data: [novitaAiModel({ id: "meta-llama/llama-3.3-70b-instruct" })],
        };
      },
    });
    expect(result.deleted).toBe(0);
    expect(await Bun.file(path.join(modelsDir, "deepseek", "deepseek-v3.2.toml")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Novita AI sync updates visible models without deleting unseen files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-novita-guard-"));
  const modelsDir = path.join(dir, "providers", "novita-ai", "models");
  const file = path.join(modelsDir, "novita", "custom.toml");
  const other = path.join(modelsDir, "novita", "other.toml");
  const content = 'name = "Custom"\ndescription = "Custom hosted model"\nrelease_date = "2025-01-01"\nlast_updated = "2025-01-01"\nattachment = false\nreasoning = false\ntool_call = false\nopen_weights = false\n\n[cost]\ninput = 1\noutput = 2\n\n[limit]\ncontext = 8192\noutput = 4096\n\n[modalities]\ninput = ["text"]\noutput = ["text"]\n';
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(path.dirname(other), { recursive: true });
    await Bun.write(file, content);
    await Bun.write(other, content);
    await expect(syncProvider({
      ...novitaAi, modelsDir, maxMissingFraction: 0.49,
      async fetchModels() { return { data: [novitaAiModel({ id: "novita/custom", features: [], pricing: { prompt: { price_per_m_decimal: "0.1" }, completion: { price_per_m_decimal: "0.2" } } })] }; },
    })).resolves.toMatchObject({ deleted: 0 });
    expect(await Bun.file(file).text()).not.toBe(content);
    expect(await Bun.file(other).text()).toBe(content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Novita AI sync keeps local files when translation skips an existing remote ID", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-novita-skip-"));
  const modelsDir = path.join(dir, "providers", "novita-ai", "models");
  const file = path.join(modelsDir, "novita", "custom.toml");
  const content = 'name = "Custom"\ndescription = "Custom hosted model"\nrelease_date = "2025-01-01"\nlast_updated = "2025-01-01"\nattachment = false\nreasoning = false\ntool_call = false\nopen_weights = false\n\n[cost]\ninput = 1\noutput = 2\n\n[limit]\ncontext = 8192\noutput = 4096\n\n[modalities]\ninput = ["text"]\noutput = ["text"]\n';
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await Bun.write(file, content);
    const result = await syncProvider({
      ...novitaAi, modelsDir,
      async fetchModels() { return { data: [novitaAiModel({ id: "novita/custom", model_type: "chat", endpoints: ["chat/completions"] })] }; },
      translateModel() { return undefined; },
    }, { dryRun: true, openIssues: true });
    expect(result.deleted).toBe(0);
    expect(result.notices.join(" ")).toContain("novita/custom");
  expect(result.notices.join(" ")).toContain("Novita models needing lab metadata");
    expect(await Bun.file(file).text()).toBe(content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Novita AI sync tracks remote-only IDs", () => {
  expect(providers["novita-ai"]).toBe(novitaAi);
  expect(groups.aggregators).toContain("novita-ai");
  expect(novitaAi.sourceID?.(novitaAiModel())).toBe("deepseek/deepseek-v3.2");
  expect(novitaAi.sourceID?.(novitaAiModel({ id: "novita/new-model" }))).toBe("novita/new-model");
  expect(novitaAi.trackMissingModels).toBe(true);
  expect(novitaAi.missingModelID?.(novitaAiModel({ id: "novita/new-model", model_type: "chat", endpoints: ["chat/completions"] }))).toBeUndefined();
  expect(novitaAi.missingModelID?.(novitaAiModel({ id: "novita/image", model_type: "image", endpoints: ["images/generations"] }))).toBeUndefined();
});

test("Novita AI sync requires NOVITA_API_KEY", async () => {
  const original = process.env.NOVITA_API_KEY;
  delete process.env.NOVITA_API_KEY;
  try {
    await expect(novitaAi.fetchModels()).rejects.toThrow("Novita AI sync requires NOVITA_API_KEY");
  } finally {
    if (original !== undefined) process.env.NOVITA_API_KEY = original;
  }
});

test("fetchNovitaAIModels passes Authorization header", async () => {
  let request: Request | undefined;
  const fetcher = async (_url: string, _init?: RequestInit) => {
    request = new Request(_url, _init);
    return new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await fetchNovitaAIModels("test-key", fetcher);
  expect(result).toEqual({ object: "list", data: [] });
  expect(request?.method).toBe("GET");
  expect(request?.url).toBe("https://api.novita.ai/openai/v1/models");
  expect(request?.headers.get("authorization")).toBe("Bearer test-key");
});

test("fetchNovitaAIModels throws on HTTP error", async () => {
  const fetcher = async () =>
    new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });

  await expect(fetchNovitaAIModels("bad-key", fetcher)).rejects.toThrow("401 Unauthorized");
});
