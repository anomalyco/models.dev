import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider } from "../src/sync/index.js";
import {
  baseten,
  basetenV2Set,
  buildBasetenModel,
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
    "capabilities.cache": { supported: true, implicit: true },
  });
  expect(basetenV2Set(undefined, undefined)).toBeUndefined();
  expect(basetenV2Set(undefined, { capabilities: { cache: { supported: true } } })).toEqual({
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
