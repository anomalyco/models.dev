import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import {
  buildIoNetModel,
  fetchIoNetModels,
  ioNet,
  parseIoNetModels,
  type IoNetModel,
} from "../src/sync/providers/io-net.js";

const row = (overrides: Partial<IoNetModel> = {}): IoNetModel => ({
  id: "deepseek-ai/DeepSeek-R1-0528",
  name: "DeepSeek: DeepSeek R1",
  context_window: 128_000,
  max_tokens: null,
  input_token_price: 5.6775e-7,
  output_token_price: 2.279e-6,
  cache_read_token_price: 2.83875e-7,
  supports_reasoning: true,
  supports_tools: true,
  ...overrides,
});

const authored: ExistingModel = {
  name: "DeepSeek R1",
  reasoning: true,
  reasoning_options: [],
  cost: { input: 2, output: 8.75, cache_read: 1, cache_write: 4 },
  limit: { context: 128_000, output: 4_096 },
};

const existing: ExistingModel = { ...authored };

test("registers an update-only hourly sync and never deletes absent entries", () => {
  expect(providers["io-net"]).toBe(ioNet);
  expect(ioNet.skipCreates).toBe(true);
  expect(ioNet.trackMissingModels).toBe(true);
  expect(ioNet.deleteMissing).toBe(false);
});

test("fetches the public catalog and rejects HTTP failures", async () => {
  let request: string | undefined;
  const fetcher = (async (input) => {
    request = String(input);
    return Response.json({ data: [row()] });
  }) as typeof fetch;
  await expect(fetchIoNetModels(fetcher)).resolves.toMatchObject({ data: [row()] });
  expect(request).toBe("https://api.intelligence.io.solutions/api/v1/models");
  await expect(
    fetchIoNetModels((async () => new Response("bad gateway", { status: 502 })) as typeof fetch),
  ).rejects.toThrow("502");
});

test("rejects empty, duplicate, and malformed catalogs", () => {
  expect(() => parseIoNetModels({ data: [] })).toThrow();
  expect(() => parseIoNetModels({ data: [row(), row()] })).toThrow("duplicate");
  expect(() => parseIoNetModels({ data: [row({ input_token_price: -1 })] })).toThrow();
  expect(parseIoNetModels({ data: [row({ precision: "fp8" } as Partial<IoNetModel>)] })).toHaveLength(1);
});

test("tracks new priced chat models and ignores unpriced services", () => {
  expect(ioNet.sourceID(row())).toBe("deepseek-ai/DeepSeek-R1-0528");
  expect(ioNet.sourceID(row({ id: "vendor/new-model" }))).toBe("vendor/new-model");
  expect(ioNet.sourceID(row({ input_token_price: undefined }))).toBeUndefined();
  expect(ioNet.sourceID(row({ output_token_price: undefined }))).toBeUndefined();
});

test("converts per-token prices to per-1M-token and preserves null limits", () => {
  const synced = buildIoNetModel(row(), existing, authored);
  expect(synced).toMatchObject({
    name: "DeepSeek R1",
    cost: { input: 0.56775, output: 2.279, cache_read: 0.283875, cache_write: 4 },
    limit: { context: 128_000, output: 4_096 },
    reasoning_options: [],
  });
});

test("applies served limits when the catalog publishes them", () => {
  const synced = buildIoNetModel(row({ context_window: 1048320, max_tokens: 131072 }), existing, authored);
  expect(synced).toMatchObject({ limit: { context: 1_048_320, output: 131_072 } });
});

test("writes zero cache rates only when the field is already authored", () => {
  const synced = buildIoNetModel(row({ cache_read_token_price: 0 }), existing, authored);
  expect(synced).toMatchObject({ cost: { cache_read: 0 } });
  const minimal = { ...authored, cost: { input: 2, output: 8.75 } };
  const untouched = buildIoNetModel(row({ cache_read_token_price: 0 }), { ...existing, cost: minimal.cost }, minimal);
  expect(untouched.cost).not.toHaveProperty("cache_read");
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("runner preserves absent entries and headers, reports new models, and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "io-net-sync-test-"));
  roots.push(root);
  const modelsDir = path.join(root, "providers/io-net/models");
  await mkdir(path.join(modelsDir, "zai-org"), { recursive: true });
  const header = "# Curated source header\n";
  const initial = header + (await Bun.file("providers/io-net/models/zai-org/GLM-4.6.toml").text())
    .replace("input = 0.4", "input = 9")
    .replace("context = 200000", "context = 32_000");
  const file = path.join(modelsDir, "zai-org/GLM-4.6.toml");
  const absent = path.join(modelsDir, "zai-org/GLM-4.5.toml");
  await Bun.write(file, initial);
  await Bun.write(absent, initial);
  const model = row({
    id: "zai-org/GLM-4.6",
    name: "Z.ai: GLM 4.6",
    context_window: 131_072,
    max_tokens: null,
    input_token_price: 5.2e-7,
    output_token_price: 2.0375e-6,
    cache_read_token_price: 2.6e-7,
  });
  const provider = {
    ...ioNet,
    modelsDir,
    fetchModels: async () => ({ data: [model, row({ id: "vendor/new-model" })] }),
  };
  const result = await syncProvider(provider);
  expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0, unchanged: 1 });
  expect(result.notices.join("\n")).toContain("vendor/new-model");
  expect(await Bun.file(absent).text()).toBe(initial);
  expect(await Bun.file(path.join(modelsDir, "vendor/new-model.toml")).exists()).toBe(false);
  const content = await Bun.file(file).text();
  expect(content.startsWith(header)).toBe(true);
  expect(Bun.TOML.parse(content)).toMatchObject({
    cost: { input: 0.52, output: 2.0375, cache_read: 0.26 },
    limit: { context: 131_072, output: 4_096 },
  });
  expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
});
