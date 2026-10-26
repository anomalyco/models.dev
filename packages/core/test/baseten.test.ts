import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider } from "../src/sync/index.js";
import {
  baseten,
  basetenV2Set,
  buildBasetenDecisionModel,
  buildBasetenModel,
  chatApis,
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

test("Baseten base_model entries carry no model facts or generated description", () => {
  const built = buildBasetenModel(
    basetenModel({ id: "zai-org/GLM-5.3", name: "GLM 5.3" }),
    {
      base_model: "zhipuai/glm-5.3",
      family: "glm",
      release_date: "2020-01-01",
      last_updated: "2020-01-02",
      knowledge: "2019-01",
      open_weights: false,
    },
    "zhipuai/glm-5.3",
  );
  for (const key of ["family", "release_date", "last_updated", "knowledge", "open_weights"]) {
    expect(built).not.toHaveProperty(key);
  }

  const created = buildBasetenModel(
    basetenModel({ id: "zai-org/GLM-5.3", name: "GLM 5.3" }),
    undefined,
    "zhipuai/glm-5.3",
  );
  expect(created).not.toHaveProperty("description");
});

test("reads Baseten cache-read prices from the catalog", () => {
  const built = buildBasetenModel(
    basetenModel({
      pricing: { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000007" },
    }),
    { cost: { input: 0.3, output: 1.2, cache_read: 0.03 } },
    "deepseek/deepseek-v4-flash-0731",
  );
  expect(built.cost).toMatchObject({ input: 0.3, output: 1.2, cache_read: 0.007 });

  expect(basetenV2Set(0.007, undefined)).toEqual({
    "capabilities.cache": { implicit: true },
  });
  expect(basetenV2Set(undefined, undefined)).toBeUndefined();
  expect(basetenV2Set(undefined, { capabilities: { cache: { implicit: true } } })).toEqual({
    "capabilities.cache": undefined,
  });
});

test("Baseten price updates keep v2 data in migrated files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-baseten-v2-"));
  const modelsDir = path.join(root, "providers", "baseten", "models");
  const repo = path.join(import.meta.dirname, "..", "..", "..");
  const id = "zai-org/GLM-5.3";
  const base = "zhipuai/glm-5.3";

  try {
    await mkdir(path.dirname(path.join(modelsDir, `${id}.toml`)), { recursive: true });
    await mkdir(path.dirname(path.join(root, "models", `${base}.toml`)), { recursive: true });
    await copyFile(path.join(repo, "models", `${base}.toml`), path.join(root, "models", `${base}.toml`));
    const shipped = await readFile(path.join(repo, "providers", "baseten", "models", `${id}.toml`), "utf8");
    const stale = shipped.replace(/\[cost\.text\.input\]\nprice = [\d.]+/, "[cost.text.input]\nprice = 9");
    expect(stale).not.toBe(shipped);
    await writeFile(path.join(modelsDir, `${id}.toml`), stale);

    const source = basetenModel({
      id,
      name: "GLM 5.3",
      context_length: 1_048_576,
      max_completion_tokens: 262_144,
      input_modalities: ["text", "image"],
      pricing: { prompt: "0.0000014", completion: "0.0000044", input_cache_read: "0.00000014" },
      supported_sampling_parameters: ["temperature", "top_p", "stop"],
      supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
    });
    const provider = { ...baseten, modelsDir, fetchModels: async () => ({ data: [source] }) };

    const result = await syncProvider(provider);
    expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    expect(await readFile(path.join(modelsDir, `${id}.toml`), "utf8")).toBe(shipped);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps an authored Baseten knowledge override on base_model entries", () => {
  const built = buildBasetenModel(
    basetenModel({ id: "zai-org/GLM-5", name: "GLM 5" }),
    { base_model: "zhipuai/glm-5", knowledge: "2026-01" },
    "zhipuai/glm-5",
    { base_model: "zhipuai/glm-5", knowledge: "2026-01" },
  );
  expect(built).toMatchObject({ knowledge: "2026-01" });
});

test("Baseten decision models get the systemone table, new or stale", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-baseten-decision-"));
  const modelsDir = path.join(root, "providers", "baseten", "models");
  const repo = path.join(import.meta.dirname, "..", "..", "..");
  const stale = "decision-models/baseten-elephant-9b-latest";
  const fresh = "decision-models/baseten-mammoth-27b-latest";

  try {
    await mkdir(path.join(modelsDir, "decision-models"), { recursive: true });
    await mkdir(path.join(root, "models", "baseten"), { recursive: true });
    for (const lab of ["elephant-1", "mammoth-1"]) {
      await copyFile(path.join(repo, "models", "baseten", `${lab}.toml`), path.join(root, "models", "baseten", `${lab}.toml`));
    }
    const shipped = (id: string) => readFile(path.join(repo, "providers", "baseten", "models", `${id}.toml`), "utf8");
    const staleShipped = await shipped(stale);
    expect(staleShipped).toContain("[api.systemone]");
    // An older file with a wrong table is corrected; a new model gets the table too.
    await writeFile(
      path.join(modelsDir, `${stale}.toml`),
      staleShipped.replace(/sdk = \{[^\n]*\}/, 'sdk = { aisdk = "none", opencodeai = "@opencode/ai/providers/baseten" }'),
    );

    const lab = (name: string) => readFile(path.join(repo, "models", "baseten", `${name}.toml`), "utf8")
      .then((text) => (Bun.TOML.parse(text) as { limit: { context: number } }).limit.context);
    const source = async (id: string, name: string) => basetenModel({
      id,
      name,
      context_length: await lab(name),
      max_completion_tokens: undefined,
      pricing: { prompt: "0", completion: "0" },
      supported_features: [],
    });
    const models = [await source(stale, "elephant-1"), await source(fresh, "mammoth-1")];
    expect(buildBasetenDecisionModel(models[1]!, undefined)?.api).toEqual({
      systemone: { sdk: { aisdk: "@ai-sdk/typesafe-ai", opencodeai: "@opencode/ai/providers/typesafe-ai" } },
    });

    const provider = { ...baseten, modelsDir, fetchModels: async () => ({ data: models }) };
    const result = await syncProvider(provider);
    expect(result).toMatchObject({ created: 1, updated: 1, deleted: 0 });
    expect(await readFile(path.join(modelsDir, `${stale}.toml`), "utf8")).toBe(staleShipped);
    expect(await readFile(path.join(modelsDir, `${fresh}.toml`), "utf8")).toBe(await shipped(fresh));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Baseten chat models list the Messages API after their first table", () => {
  const messages = { sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/anthropic-compatible" } };
  // No table: the provider's Chat Completions API comes first.
  expect(chatApis(undefined)).toEqual({ "chat-completions": {}, messages });
  const first = { "chat-completions": { compatibility: { reasoning_field: "reasoning_content" } } };
  const once = chatApis(first);
  expect(Object.keys(once)).toEqual(["chat-completions", "messages"]);
  expect(once).toEqual({ ...first, messages });
  expect(chatApis(once)).toEqual(once);
  const translated = baseten.translateModel(basetenModel(), {
    existing: () => undefined,
    authored: () => undefined,
  });
  expect(translated?.v2Set?.api).toBe(chatApis);
});
