import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { groups, providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import {
  buildInceptionModel,
  fetchInceptionModels,
  inception,
  parseInceptionModels,
  type InceptionModel,
} from "../src/sync/providers/inception.js";

const row = (overrides: Partial<InceptionModel> = {}): InceptionModel => ({
  id: "mercury-2",
  name: "Inception: Mercury 2",
  context_length: 128_000,
  max_output_length: 50_000,
  pricing: {
    prompt: "0.00000025",
    completion: "0.00000075",
    input_cache_reads: "0.000000025",
    input_cache_writes: "0",
  },
  supported_endpoints: ["chat.completions"],
  ...overrides,
});

const authored: ExistingModel = {
  name: "Mercury 2",
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
  cost: { input: 0.25, output: 0.75, cache_read: 0.025 },
  limit: { context: 128_000, output: 50_000 },
};

const existing: ExistingModel = { ...authored };

test("registers an update-only hourly sync in the direct group", () => {
  expect(providers.inception).toBe(inception);
  expect(groups.direct).toContain("inception");
  expect(inception.skipCreates).toBe(true);
  expect(inception.trackMissingModels).toBe(true);
  expect(inception.deleteMissing).toBe(false);
});

test("fetches the public catalog and rejects HTTP failures", async () => {
  let request: string | undefined;
  const fetcher = (async (input) => {
    request = String(input);
    return Response.json({ data: [row()] });
  }) as typeof fetch;
  await expect(fetchInceptionModels(fetcher)).resolves.toMatchObject({ data: [row()] });
  expect(request).toBe("https://api.inceptionlabs.ai/v1/models");
  await expect(
    fetchInceptionModels((async () => new Response("bad gateway", { status: 502 })) as typeof fetch),
  ).rejects.toThrow("502");
});

test("rejects empty, duplicate, and malformed catalogs", () => {
  expect(() => parseInceptionModels({ data: [] })).toThrow();
  expect(() => parseInceptionModels({ data: [row(), row()] })).toThrow("duplicate");
  expect(() => parseInceptionModels({ data: [row({ pricing: { prompt: "-1" } })] })).toThrow();
  expect(parseInceptionModels({ data: [row({ description: "ok" } as Partial<InceptionModel>)] })).toHaveLength(1);
});

test("tracks new chat models and ignores the decisions-only preview", () => {
  expect(inception.sourceID(row())).toBe("mercury-2");
  expect(inception.sourceID(row({ id: "mercury-decide", supported_endpoints: ["decisions"] }))).toBeUndefined();
  expect(inception.sourceID(row({ id: "unpriced", pricing: {} }))).toBeUndefined();
  expect(inception.sourceID(row({ supported_endpoints: undefined }))).toBe("mercury-2");
});

test("converts per-token prices to per-1M-token and syncs served limits", () => {
  const synced = buildInceptionModel(row(), existing, authored);
  expect(synced).toMatchObject({
    name: "Mercury 2",
    cost: { input: 0.25, output: 0.75, cache_read: 0.025 },
    limit: { context: 128_000, output: 50_000 },
    reasoning_options: authored.reasoning_options,
  });
  expect(synced.cost).not.toHaveProperty("cache_write");
});

test("updates stale local rates and applies a lower served context", () => {
  const model = row({
    context_length: 65_536,
    max_output_length: 32_768,
    pricing: { prompt: "0.00000004", completion: "0.00000015", input_cache_reads: "0.000000004" },
  });
  const synced = buildInceptionModel(model, existing, authored);
  expect(synced).toMatchObject({
    cost: { input: 0.04, output: 0.15, cache_read: 0.004 },
    limit: { context: 65_536, output: 32_768 },
  });
});

test("keeps authored cache rates while clearing a zero placeholder", () => {
  const model = row({
    pricing: { prompt: "0.00000025", completion: "0.00000075", input_cache_reads: "0", input_cache_writes: "0" },
  });
  const synced = buildInceptionModel(model, existing, authored);
  expect(synced).toMatchObject({ cost: { input: 0.25, output: 0.75, cache_read: 0 } });
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("runner preserves absent entries and headers, reports new models, and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inception-sync-test-"));
  roots.push(root);
  const modelsDir = path.join(root, "providers/inception/models");
  await mkdir(modelsDir, { recursive: true });
  const header = "# Curated source header\n";
  const initial = header + (await Bun.file("providers/inception/models/mercury-2.toml").text())
    .replace("input = 0.25", "input = 9")
    .replace("context = 128_000", "context = 32_000");
  const file = path.join(modelsDir, "mercury-2.toml");
  const absent = path.join(modelsDir, "mercury-edit-2.toml");
  await Bun.write(file, initial);
  await Bun.write(absent, initial);
  const provider = {
    ...inception,
    modelsDir,
    fetchModels: async () => ({ data: [row(), row({ id: "mercury-3" })] }),
  };
  const result = await syncProvider(provider);
  expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0, unchanged: 1 });
  expect(result.notices.join("\n")).toContain("mercury-3");
  expect(await Bun.file(absent).text()).toBe(initial);
  expect(await Bun.file(path.join(modelsDir, "mercury-3.toml")).exists()).toBe(false);
  const content = await Bun.file(file).text();
  expect(content.startsWith(header)).toBe(true);
  expect(Bun.TOML.parse(content)).toMatchObject({
    cost: { input: 0.25, output: 0.75, cache_read: 0.025 },
    limit: { context: 128_000, output: 50_000 },
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
  });
  expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
});
