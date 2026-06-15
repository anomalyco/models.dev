import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";

import { syncProvider } from "../src/sync/index.js";
import {
  BasetenResponse,
  baseten,
  buildBasetenModel,
  fetchBasetenModels,
  type BasetenModel,
} from "../src/sync/providers/baseten.js";

const catalogModel: BasetenModel = {
  id: "zai-org/GLM-5.1",
  name: "GLM 5.1",
  context_length: 128_000,
  max_completion_tokens: 32_000,
  input_modalities: ["text"],
  output_modalities: ["text"],
  pricing: {
    prompt: "0.00000012",
    completion: "0.0000005",
  },
  supported_features: ["reasoning", "reasoning_effort", "tools", "structured_outputs"],
  supported_sampling_parameters: ["temperature", "top_p"],
};

const newCatalogModel: BasetenModel = {
  ...catalogModel,
};

afterEach(() => {
  baseten.modelsDir = "providers/baseten/models";
  baseten.fetchModels = async () => {
    const key = process.env.BASETEN_API_KEY;
    if (key === undefined) throw new Error("Baseten sync requires BASETEN_API_KEY");
    return fetchBasetenModels(key);
  };
});

test("Baseten maps authoritative fields and preserves curated metadata", () => {
  const synced = buildBasetenModel(catalogModel, {
    name: "Old name",
    release_date: "2025-08-05",
    last_updated: "2025-09-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    tool_call: true,
    open_weights: true,
    status: "deprecated",
    interleaved: { field: "reasoning_content" },
    base_model: "zhipuai/glm-5.1",
    base_model_omit: ["limit.input"],
    cost: { input: 0.1, output: 0.4, cache_write: 0.2 },
    limit: { context: 64_000, output: 16_000 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(synced).toMatchObject({
    base_model: "zhipuai/glm-5.1",
    base_model_omit: ["limit.input"],
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    status: "deprecated",
    interleaved: { field: "reasoning_content" },
    cost: { input: 0.12, output: 0.5, cache_write: 0.2 },
    limit: { context: 128_000, output: 32_000 },
  });
});

test("Baseten preserves curated reasoning when an opt-in capability is omitted", () => {
  const synced = buildBasetenModel({
    ...catalogModel,
    supported_features: ["tools", "structured_outputs"],
  }, {
    name: "GLM 5.1",
    release_date: "2026-05-20",
    last_updated: "2026-05-20",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    open_weights: true,
    cost: { input: 1, output: 4 },
    limit: { context: 100_000, output: 50_000 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(synced).toMatchObject({
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
  });
});

test("Baseten sync adds exact base models, retains missing entries, and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "models-dev-baseten-"));
  const modelsDir = path.join(root, "providers", "baseten", "models");
  const metadataDir = path.join(root, "models", "zhipuai");
  await mkdir(path.join(modelsDir, "stale"), { recursive: true });
  await mkdir(metadataDir, { recursive: true });
  await Bun.write(
    path.join(metadataDir, "glm-5.1.toml"),
    Bun.file(path.join(import.meta.dirname, "../../../models/zhipuai/glm-5.1.toml")),
  );
  await Bun.write(path.join(modelsDir, "stale", "model.toml"), [
    'name = "Retained"',
    'release_date = "2025-01-01"',
    'last_updated = "2025-01-01"',
    "attachment = false",
    "reasoning = false",
    "tool_call = false",
    "open_weights = false",
    "[cost]",
    "input = 1",
    "output = 1",
    "[limit]",
    "context = 1000",
    "output = 100",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
    "",
  ].join("\n"));
  baseten.modelsDir = modelsDir;
  baseten.fetchModels = async () => ({ data: [newCatalogModel] });

  const first = await syncProvider(baseten);
  const second = await syncProvider(baseten);

  expect(first.created).toBe(1);
  expect(first.deleted).toBe(0);
  expect(first.notices.join(" ")).toContain("stale/model.toml");
  expect(second).toMatchObject({ created: 0, updated: 0, deleted: 0 });
});

test("Baseten rejects malformed catalog responses", () => {
  expect(() => BasetenResponse.parse({ data: "broken" })).toThrow();
});

test("Baseten rejects non-success API responses", async () => {
  const fetcher = async () => new Response("unauthorized", {
    status: 401,
    statusText: "Unauthorized",
  });

  expect(fetchBasetenModels("fixture-key", fetcher as typeof fetch))
    .rejects.toThrow("Baseten models request failed: 401 Unauthorized");
});
