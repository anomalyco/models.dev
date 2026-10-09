import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { groups, providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import {
  buildNovitaModel,
  fetchNovitaModels,
  novitaAi,
  parseNovitaModels,
  type NovitaModel,
} from "../src/sync/providers/novita-ai.js";

const row = (overrides: Partial<NovitaModel> = {}): NovitaModel => ({
  id: "qwen/qwen3.8-max",
  model_type: "chat",
  context_size: 1_000_000,
  max_output_tokens: 131_072,
  input_token_price_per_m: 20_000,
  output_token_price_per_m: 60_000,
  is_tiered_billing: false,
  ...overrides,
});

const authored: ExistingModel = {
  base_model: "alibaba/qwen3.8-max",
  structured_output: true,
  reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "xhigh"] }],
  interleaved: { field: "reasoning_content" },
  modalities: { input: ["text", "image", "video"] } as ExistingModel["modalities"],
  cost: { input: 2, output: 6, cache_read: 0.25, cache_write: 2.5, input_audio: 1 },
};

const existing: ExistingModel = {
  ...Bun.TOML.parse(await Bun.file("models/alibaba/qwen3.8-max.toml").text()),
  ...authored,
  limit: { context: 1_000_000, output: 131_072 },
} as ExistingModel;

const context = (present = true) => ({
  existing: () => present ? existing : undefined,
  authored: () => present ? authored : undefined,
});

test("registers update-only hourly sync and never deletes absent entries", () => {
  expect(providers["novita-ai"]).toBe(novitaAi);
  expect(groups.aggregators).toContain("novita-ai");
  expect(novitaAi.skipCreates).toBe(true);
  expect(novitaAi.trackMissingModels).toBe(true);
  expect(novitaAi.deleteMissing).toBe(false);
});

test("fetches the authenticated catalog and rejects HTTP failures", async () => {
  let request: { url: string; auth: string | null } | undefined;
  const fetcher = (async (input, init) => {
    request = { url: String(input), auth: new Headers(init?.headers).get("authorization") };
    return Response.json({ data: [row()] });
  }) as typeof fetch;
  await expect(fetchNovitaModels("test-key", fetcher)).resolves.toMatchObject({ data: [row()] });
  expect(request).toEqual({ url: "https://api.novita.ai/openai/v1/models", auth: "Bearer test-key" });
  await expect(fetchNovitaModels("", fetcher)).rejects.toThrow("NOVITA_AI_API_KEY");
  await expect(fetchNovitaModels("test-key", (async (_input, _init) => new Response("unauthorized", { status: 401 })) as typeof fetch))
    .rejects.toThrow("401");
});

test("uses the local key when set and the CI key otherwise", async () => {
  const previous = [process.env.NOVITA_AI_MODELS_DEV_KEY, process.env.NOVITA_AI_API_KEY];
  const auth: Array<string | null> = [];
  const fetcher = (async (_input, init) => {
    auth.push(new Headers(init?.headers).get("authorization"));
    return Response.json({ data: [row()] });
  }) as typeof fetch;
  try {
    process.env.NOVITA_AI_MODELS_DEV_KEY = "local-test-key";
    process.env.NOVITA_AI_API_KEY = "ci-test-key";
    await fetchNovitaModels(undefined, fetcher);
    delete process.env.NOVITA_AI_MODELS_DEV_KEY;
    await fetchNovitaModels(undefined, fetcher);
    delete process.env.NOVITA_AI_API_KEY;
    await expect(fetchNovitaModels(undefined, fetcher)).rejects.toThrow("requires");
    expect(auth).toEqual(["Bearer local-test-key", "Bearer ci-test-key"]);
  } finally {
    for (const [index, key] of ["NOVITA_AI_MODELS_DEV_KEY", "NOVITA_AI_API_KEY"].entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
});

test("rejects empty, duplicate, and malformed inventories", () => {
  expect(() => parseNovitaModels({ data: [] })).toThrow();
  expect(() => parseNovitaModels({ data: [row(), row()] })).toThrow("duplicate");
  expect(() => parseNovitaModels({ data: [row({ input_token_price_per_m: -1 })] })).toThrow();
  expect(() => parseNovitaModels({ data: [row({ pricing: { prompt: { price_per_m_decimal: "" } } })] })).toThrow();
  expect(parseNovitaModels({ data: [row({ features: ["reasoning"], status: 1 } as Partial<NovitaModel>)] })).toHaveLength(1);
});

test("tracks new eligible models without constructing unreviewed TOMLs", () => {
  const source = row({ id: "qwen/qwen-future-model" });
  expect(novitaAi.sourceID(source)).toBe(source.id);
  expect(novitaAi.translateModel(source, context(false))).toBeUndefined();
});

test("preserves existing non-chat entries even if the inventory mislabels them as chat", () => {
  const translated = novitaAi.translateModel(row(), {
    existing: () => ({ ...existing, type: "embedding" }),
    authored: () => authored,
  });
  expect(translated?.id).toBe(row().id);
  expect(translated?.model === authored).toBe(true);
});

test("silently skips deferred, internal, non-chat, zero-limit, and unpriced rows", () => {
  const rows = [
    row({ id: "Sao10K/L3-8B-Stheno-v3.2" }),
    row({ id: "sao10k/l3-70b-euryale-v2.1" }),
    row({ id: "deepseek/deepseek-v4.1-flash-p" }),
    row({ id: "deepseek/deepseek-v4-flash" }),
    row({ id: "dev/glm46" }),
    row({ id: "dev/new-test-route" }),
    row({ id: "pa/gpt-5.6-sol" }),
    row({ model_type: "embedding" }),
    row({ context_size: 0 }),
    row({ max_output_tokens: 0 }),
    row({ max_output_tokens: undefined }),
    row({ input_token_price_per_m: undefined, output_token_price_per_m: undefined }),
  ];
  for (const source of rows) {
    expect(novitaAi.sourceID(source)).toBeUndefined();
    expect(novitaAi.translateModel(source, context())).toBeUndefined();
  }
  expect(novitaAi.sourceID(row({ input_token_price_per_m: 0, output_token_price_per_m: 0 }))).toBeDefined();
});

test("updates legacy scaled prices and limits without restating base metadata", () => {
  const synced = buildNovitaModel(row({ input_token_price_per_m: 15_000, max_output_tokens: 64_000 }), existing, authored);
  expect(synced).toMatchObject({
    base_model: authored.base_model,
    cost: { input: 1.5, output: 6, cache_read: 0.25, cache_write: 2.5, input_audio: 1 },
    limit: { output: 64_000 },
    reasoning_options: authored.reasoning_options,
    interleaved: authored.interleaved,
  });
  expect(synced.limit?.context).toBeUndefined();
  for (const field of ["name", "description", "release_date", "last_updated", "reasoning", "open_weights"]) {
    expect(synced).not.toHaveProperty(field);
  }
});

test("prefers decimal USD fields and preserves curated fields absent from inventory", () => {
  const synced = buildNovitaModel(row({ pricing: {
    prompt: { price_per_m_decimal: "0.435", price_per_m: 99999 },
    completion: { price_per_m_decimal: "0.87" },
    input_cache_read: { price_per_m_decimal: "0.0036" },
  } }), existing, authored);
  expect(synced.cost).toMatchObject({ input: 0.435, output: 0.87, cache_read: 0.0036, cache_write: 2.5, input_audio: 1 });
});

test("does not invent free cache support from zero placeholders", () => {
  const local = { ...authored, cost: { input: 2, output: 6 } };
  const synced = buildNovitaModel(row({ pricing: {
    input_cache_read: { price_per_m: 0 }, input_cache_write: { price_per_m_decimal: "0" },
  } }), { ...existing, cost: local.cost }, local);
  expect(synced.cost).toEqual({ input: 2, output: 6 });
});

test("does not change curated reasoning or modalities based on inventory labels", () => {
  const source = row({ features: ["reasoning"], input_modalities: ["text", "image"] } as Partial<NovitaModel>);
  const local = { ...authored, reasoning: false, reasoning_options: undefined, modalities: { input: ["text"], output: ["text"] } } as ExistingModel;
  const synced = buildNovitaModel(source, { ...existing, ...local }, local);
  expect(synced.reasoning).toBe(false);
  expect(synced.reasoning_options).toBeUndefined();
  expect(synced.modalities).toEqual({ input: ["text"] });
});

test("does not replace missing reasoning controls with an empty placeholder", () => {
  expect(() => buildNovitaModel(row(), { ...existing, reasoning: true, reasoning_options: undefined }, { ...authored, reasoning_options: undefined }))
    .toThrow("author reasoning_options");
});

test("syncs context tiers, preserving optional tier pricing and normalizing flat pricing", () => {
  const tiered = row({ is_tiered_billing: true, tiered_billing_configs: [
    { min_tokens: 524_288, pricing: { prompt: { price_per_m_decimal: "0.6" }, completion: { price_per_m_decimal: "2.4" }, input_cache_read: { price_per_m_decimal: "0.12" } } },
    { min_tokens: 1, pricing: { prompt: { price_per_m_decimal: "0.3" }, completion: { price_per_m_decimal: "1.2" }, input_cache_read: { price_per_m_decimal: "0.06" } } },
  ] });
  const local = { ...authored, cost: { ...authored.cost!, tiers: [{ tier: { type: "context" as const, size: 524_288 }, input: 1, output: 2, input_audio: 3 }] } };
  const synced = buildNovitaModel(tiered, { ...existing, cost: local.cost }, local);
  expect(synced.cost).toMatchObject({ input: 0.3, output: 1.2, cache_read: 0.06, tiers: [
    { tier: { type: "context", size: 524_288 }, input: 0.6, output: 2.4, cache_read: 0.12, input_audio: 3 },
  ] });
  expect(buildNovitaModel(row(), { ...existing, cost: local.cost }, local).cost?.tiers).toBeUndefined();
  expect(buildNovitaModel(row({ is_tiered_billing: undefined }), { ...existing, cost: local.cost }, local).cost?.tiers).toEqual(local.cost.tiers);
  expect(() => buildNovitaModel(row({ is_tiered_billing: true }), existing, authored)).toThrow("missing or duplicate");
  expect(() => buildNovitaModel(row({ is_tiered_billing: true, tiered_billing_configs: [tiered.tiered_billing_configs![0]!] }), existing, authored)).toThrow("missing or duplicate");
  expect(() => buildNovitaModel(row({ is_tiered_billing: true, tiered_billing_configs: [tiered.tiered_billing_configs![0]!, tiered.tiered_billing_configs![0]!] }), existing, authored)).toThrow("missing or duplicate");
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("runner preserves absent entries and headers, reports new models, and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "novita-sync-test-"));
  roots.push(root);
  const modelsDir = path.join(root, "providers/novita-ai/models");
  await mkdir(path.join(modelsDir, "qwen"), { recursive: true });
  await mkdir(path.join(root, "models/alibaba"), { recursive: true });
  await Bun.write(path.join(root, "models/alibaba/qwen3.8-max.toml"), await Bun.file("models/alibaba/qwen3.8-max.toml").text());
  const header = "# Toggle: thinking.type = enabled|disabled\n# Curated source header\n";
  const initial = header + 'base_model = "alibaba/qwen3.8-max"\nreasoning_options = [{ type = "toggle" }]\n[cost]\ninput = 2\noutput = 6\n';
  const file = path.join(modelsDir, "qwen/qwen3.8-max.toml");
  const absent = path.join(modelsDir, "qwen/unlisted.toml");
  await Bun.write(file, initial);
  await Bun.write(absent, initial);
  const provider = { ...novitaAi, modelsDir, fetchModels: async () => ({ data: [row({ max_output_tokens: 64_000 }), row({ id: "qwen/new-model" })] }) };
  const result = await syncProvider(provider);
  expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0, unchanged: 1 });
  expect(result.notices.join("\n")).toContain("qwen/new-model");
  expect(await Bun.file(absent).text()).toBe(initial);
  expect(await Bun.file(path.join(modelsDir, "qwen/new-model.toml")).exists()).toBe(false);
  const content = await Bun.file(file).text();
  expect(content.startsWith(header)).toBe(true);
  expect(Bun.TOML.parse(content)).toMatchObject({ base_model: "alibaba/qwen3.8-max", limit: { output: 64_000 }, reasoning_options: [{ type: "toggle" }] });
  expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
});
