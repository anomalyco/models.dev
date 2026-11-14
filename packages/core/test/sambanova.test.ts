import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, type ExistingModel } from "../src/sync/index.js";

import {
  fetchSambaNovaModels,
  parseSambaNovaModels,
  sambaNova,
  type SambaNovaModel,
} from "../src/sync/providers/sambanova.js";

const REPO = path.join(import.meta.dir, "../../..");

function model(overrides: Partial<SambaNovaModel> = {}): SambaNovaModel {
  return {
    id: "GLM-5.3",
    context_length: 1_048_576,
    max_completion_tokens: 1_048_576,
    pricing: {
      prompt: "0.00000280",
      completion: "0.00000880",
      input_cache_read: "0.00000014",
    },
    ...overrides,
  };
}

test("parses the public SambaNova model inventory", () => {
  expect(parseSambaNovaModels({
    data: [model()],
  })).toEqual([model()]);
});

test("fetches the SambaNova models endpoint without authentication", async () => {
  let request: string | URL | undefined;
  const fetcher = async (input: string | URL | Request) => {
    request = input as string | URL;
    return Response.json({ data: [model()] });
  };

  await expect(fetchSambaNovaModels(fetcher as unknown as typeof fetch)).resolves.toEqual({
    data: [model()],
  });
  expect(String(request)).toBe("https://api.sambanova.ai/v1/models");
});

test("skips remote-only models instead of creating entries", () => {
  expect(sambaNova.translateModel(model({ id: "new-model" }), {
    existing: () => undefined,
    authored: () => undefined,
  })).toBeUndefined();
});

test("syncs limits and per-token pricing onto existing entries", () => {
  const existing: ExistingModel = {
    base_model: "zhipuai/glm-5.3",
    reasoning_options: [{ type: "effort" as const, values: ["low", "high", "max"] }],
    limit: { context: 1_048_576, output: 1_048_576 },
    cost: { input: 2.8, output: 8.8, cache_read: 0.14 },
  };
  expect(sambaNova.translateModel(model(), {
    existing: () => existing,
    authored: () => existing,
  })).toEqual({
    id: "GLM-5.3",
    model: {
      base_model: "zhipuai/glm-5.3",
      reasoning_options: [{ type: "effort" as const, values: ["low", "high", "max"] }],
      limit: { context: 1_048_576, output: 1_048_576 },
      cost: { input: 2.8, output: 8.8, cache_read: 0.14 },
    },
  });
});

test("updates stale limits and prices from the API", () => {
  const existing: ExistingModel = {
    base_model: "zhipuai/glm-5.3",
    limit: { context: 131_072, output: 8_192 },
    cost: { input: 3, output: 9 },
  };
  expect(sambaNova.translateModel(model(), {
    existing: () => existing,
    authored: () => existing,
  })).toEqual({
    id: "GLM-5.3",
    model: {
      base_model: "zhipuai/glm-5.3",
      limit: { context: 1_048_576, output: 1_048_576 },
      cost: { input: 2.8, output: 8.8, cache_read: 0.14 },
    },
  });
});

test("keeps existing cost when the API omits pricing", () => {
  const existing: ExistingModel = {
    base_model: "meta/llama-3.3-70b-instruct",
    cost: { input: 0.6, output: 1.2 },
  };
  expect(sambaNova.translateModel(model({ id: "Meta-Llama-3.3-70B-Instruct", context_length: 131_072, max_completion_tokens: 3_072, pricing: undefined }), {
    existing: () => existing,
    authored: () => existing,
  })).toEqual({
    id: "Meta-Llama-3.3-70B-Instruct",
    model: {
      base_model: "meta/llama-3.3-70b-instruct",
      limit: { context: 131_072, output: 3_072 },
      cost: { input: 0.6, output: 1.2 },
    },
  });
});

test("leaves shipped v2 files byte-identical on a current catalog", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sambanova-sync-"));
  const modelsDir = path.join(dir, "providers/sambanova/models");
  const ids = ["GLM-5.3", "MiniMax-M3.1-Flash", "gpt-oss-120b"];
  await mkdir(modelsDir, { recursive: true });
  for (const id of ids) {
    await Bun.write(path.join(modelsDir, `${id}.toml`), Bun.file(path.join(REPO, "providers/sambanova/models", `${id}.toml`)));
  }
  for (const lab of ["zhipuai/glm-5.3", "minimax/MiniMax-M3.1-Flash", "openai/gpt-oss-120b"]) {
    await mkdir(path.dirname(path.join(dir, "models", lab)), { recursive: true });
    await Bun.write(path.join(dir, "models", `${lab}.toml`), Bun.file(path.join(REPO, "models", `${lab}.toml`)));
  }
  const before = await Promise.all(ids.map((id) => Bun.file(path.join(modelsDir, `${id}.toml`)).text()));

  try {
    const result = await syncProvider({
      ...sambaNova,
      modelsDir,
      async fetchModels() {
        return {
          data: [
            model(),
            model({
              id: "MiniMax-M3.1-Flash",
              pricing: { prompt: "0.00000030", completion: "0.00000120", input_cache_read: "0.00000003" },
            }),
            model({
              id: "gpt-oss-120b",
              context_length: 131_072,
              max_completion_tokens: 131_072,
              pricing: { prompt: "0.00000022", completion: "0.00000059" },
            }),
          ],
        };
      },
    });
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
    const after = await Promise.all(ids.map((id) => Bun.file(path.join(modelsDir, `${id}.toml`)).text()));
    expect(after).toEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drops the cache price when the feed lists no cached SKU", () => {
  const existing: ExistingModel = {
    base_model: "zhipuai/glm-5.3",
    limit: { context: 1_048_576, output: 1_048_576 },
    cost: { input: 2.8, output: 8.8, cache_read: 0.14 },
  };
  expect(sambaNova.translateModel(model({ pricing: { prompt: "0.00000280", completion: "0.00000880" } }), {
    existing: () => existing,
    authored: () => existing,
  })).toEqual({
    id: "GLM-5.3",
    model: {
      base_model: "zhipuai/glm-5.3",
      limit: { context: 1_048_576, output: 1_048_576 },
      cost: { input: 2.8, output: 8.8 },
    },
  });
});

test("keeps a zero cached-input price as a real price", () => {
  const existing: ExistingModel = {
    base_model: "zhipuai/glm-5.3",
    limit: { context: 1_048_576, output: 1_048_576 },
    cost: { input: 2.8, output: 8.8, cache_read: 0.14 },
  };
  expect(sambaNova.translateModel(model({ pricing: { prompt: "0.00000280", completion: "0.00000880", input_cache_read: "0.00000000" } }), {
    existing: () => existing,
    authored: () => existing,
  })).toEqual({
    id: "GLM-5.3",
    model: {
      base_model: "zhipuai/glm-5.3",
      limit: { context: 1_048_576, output: 1_048_576 },
      cost: { input: 2.8, output: 8.8, cache_read: 0 },
    },
  });
});

test("deletes local files the API no longer serves", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sambanova-sync-"));
  const modelsDir = path.join(dir, "providers/sambanova/models");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(dir, "models"), { recursive: true });
  await Bun.write(path.join(modelsDir, "DeepSeek-V3.1.toml"), Bun.file(path.join(REPO, "providers/sambanova/models", "GLM-5.3.toml")));
  await Bun.write(path.join(dir, "models/zhipuai/glm-5.3.toml"), Bun.file(path.join(REPO, "models/zhipuai/glm-5.3.toml")));

  try {
    const result = await syncProvider({
      ...sambaNova,
      modelsDir,
      async fetchModels() {
        return { data: [model()] };
      },
    });
    expect(result.deleted).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});