import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import {
  buildMoarkModel,
  fetchMoarkServices,
  moark,
  parseMoarkServices,
  type MoarkService,
} from "../src/sync/providers/moark.js";

const row = (overrides: Partial<MoarkService> = {}): MoarkService => ({
  ident: "MiniMax-M2.7",
  name: "MiniMax-M2.7",
  status: 1,
  tags: [{ slug: "text-generation" }],
  operation_summary: {
    min_input_million_tokens_price: 0.29,
    min_output_million_tokens_price: 1.2,
  },
  ...overrides,
});

const authored: ExistingModel = {
  base_model: "minimax/MiniMax-M2.7",
  reasoning_options: [],
  cost: { input: 0.29, output: 1.2 },
};

const existing: ExistingModel = {
  ...Bun.TOML.parse(await Bun.file("models/minimax/MiniMax-M2.7.toml").text()),
  ...authored,
  reasoning: true,
} as ExistingModel;

test("registers an update-only hourly sync and never deletes absent entries", () => {
  expect(providers.moark).toBe(moark);
  expect(moark.skipCreates).toBe(true);
  expect(moark.trackMissingModels).toBe(true);
  expect(moark.deleteMissing).toBe(false);
});

test("fetches the public USD catalog and rejects HTTP failures", async () => {
  let request: string | undefined;
  const fetcher = (async (input) => {
    request = String(input);
    return Response.json({ total: 1, items: [row()] });
  }) as typeof fetch;
  await expect(fetchMoarkServices(fetcher)).resolves.toMatchObject({ total: 1 });
  expect(request).toBe("https://moark.ai/api/pay/services?type=serverless&status=1&size=1000");
  await expect(
    fetchMoarkServices((async () => new Response("bad gateway", { status: 502 })) as typeof fetch),
  ).rejects.toThrow("502");
});

test("rejects empty, duplicate, and malformed catalogs", () => {
  expect(() => parseMoarkServices({ total: 0, items: [] })).toThrow();
  expect(() => parseMoarkServices({ total: 2, items: [row(), row()] })).toThrow("duplicate");
  expect(() => parseMoarkServices({ total: 1, items: [row({ status: 1.5 })] })).toThrow();
  expect(parseMoarkServices({ total: 1, items: [row({ description_html: "<p>ok</p>" } as Partial<MoarkService>)] })).toHaveLength(1);
});

test("tracks new chat models and ignores non-chat services", () => {
  expect(moark.sourceID(row())).toBe("MiniMax-M2.7");
  expect(moark.sourceID(row({
    ident: "Kimi-K2.6",
    tags: [{ slug: "vision-language" }, { slug: "function_calling" }],
  }))).toBe("Kimi-K2.6");
  for (const tags of [
    [{ slug: "text-to-speech" }],
    [{ slug: "image_generation" }],
    [{ slug: "embedding-rerank" }],
    [{ slug: "Decision-Model" }],
  ]) {
    expect(moark.sourceID(row({ tags }))).toBeUndefined();
  }
  expect(moark.sourceID(row({ operation_summary: undefined }))).toBeUndefined();
});

test("updates USD token prices without restating base metadata", () => {
  const synced = buildMoarkModel(row(), existing, authored) as Record<string, unknown>;
  expect(synced).toMatchObject({
    base_model: "minimax/MiniMax-M2.7",
    cost: { input: 0.29, output: 1.2 },
    reasoning_options: [],
  });
  for (const field of ["name", "description", "release_date", "reasoning", "open_weights"]) {
    expect(synced).not.toHaveProperty(field);
  }
});

test("replaces stale local rates with the catalog USD prices", () => {
  const stale = { ...authored, cost: { input: 2.1, output: 8.4 } };
  const synced = buildMoarkModel(row(), { ...existing, cost: stale.cost }, stale);
  expect(synced).toMatchObject({ cost: { input: 0.29, output: 1.2 } });
});

test("requires authored reasoning controls instead of inventing an empty set", () => {
  expect(() => buildMoarkModel(
    row(),
    { ...existing, reasoning: true, reasoning_options: undefined },
    { ...authored, reasoning_options: undefined },
  )).toThrow("author reasoning_options");
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("runner preserves absent entries and headers, reports new models, and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "moark-sync-test-"));
  roots.push(root);
  const modelsDir = path.join(root, "providers/moark/models");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(root, "models/minimax"), { recursive: true });
  await Bun.write(
    path.join(root, "models/minimax/MiniMax-M2.7.toml"),
    await Bun.file("models/minimax/MiniMax-M2.7.toml").text(),
  );
  const header = "# Costs: Moark USD price list, https://moark.ai/serverless-api (accessed 2026-10-10)\n";
  const initial = header
    + 'base_model = "minimax/MiniMax-M2.7"\nreasoning_options = []\n[cost]\ninput = 2.1\noutput = 8.4\n';
  const file = path.join(modelsDir, "MiniMax-M2.7.toml");
  const absent = path.join(modelsDir, "unlisted.toml");
  await Bun.write(file, initial);
  await Bun.write(absent, initial);
  const provider = {
    ...moark,
    modelsDir,
    fetchModels: async () => ({ total: 2, items: [row(), row({ ident: "new-chat-model" })] }),
  };
  const result = await syncProvider(provider);
  expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0, unchanged: 1 });
  expect(result.notices.join("\n")).toContain("new-chat-model");
  expect(await Bun.file(absent).text()).toBe(initial);
  expect(await Bun.file(path.join(modelsDir, "new-chat-model.toml")).exists()).toBe(false);
  const content = await Bun.file(file).text();
  expect(content.startsWith(header)).toBe(true);
  expect(Bun.TOML.parse(content)).toMatchObject({
    base_model: "minimax/MiniMax-M2.7",
    cost: { input: 0.29, output: 1.2 },
    reasoning_options: [],
  });
  expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
});
