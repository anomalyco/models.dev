import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeDeep } from "remeda";

import { generate } from "../src/generate.js";
import { groups, providers, syncProvider, syncProviderMatrix, type ExistingModel, type SyncedModel } from "../src/sync/index.js";
import {
  buildInferModel,
  createLowCostModel,
  fetchInferCatalog,
  infer,
  InferCatalog,
  parseInferCatalog,
  type InferRoute,
} from "../src/sync/providers/infer.js";
import { modelMetadata } from "../src/sync/providers/openrouter.js";
import { modelV2ToV1 } from "../src/translate.js";

const REPO = path.join(import.meta.dirname, "..", "..", "..");
const SHIPPED_DIR = path.join(REPO, "providers", "infer", "models", "infer");

// Every shipped file as the runner sees it: its text, its own fields, and the file merged over its lab.
type Shipped = { file: string; text: string; authored: ExistingModel; resolved: ExistingModel };
const SHIPPED: Record<string, Shipped> = Object.fromEntries(
  readdirSync(SHIPPED_DIR).map((file) => {
    const id = `infer/${file.slice(0, -".toml".length)}`;
    const text = readFileSync(path.join(SHIPPED_DIR, file), "utf8");
    const { id: _id, ...authored } = modelV2ToV1({ ...(Bun.TOML.parse(text) as Record<string, unknown>), id }) as ExistingModel & { id?: string };
    const { benchmarks: _benchmarks, weights: _weights, ...lab } = modelMetadata(authored.base_model!);
    return [id, { file, text, authored, resolved: mergeDeep(lab, authored) as ExistingModel }];
  }),
);
const ASTRA = SHIPPED["infer/gpt-6-astra:low-cost"]!;
const NO_FREEFORM = "# No freeform: Infer's docs (https://infer.flow7.org/docs, Responses API) say custom tools the client runs pass through";

// The routes Infer's catalog lists today. Every route it lists quotes a cache-read price, so the sync
// gives its file a cache kind; a shipped file without one is a route the catalog has stopped listing,
// kept because the sync never removes a file.
const LISTED = Object.keys(SHIPPED).filter((id) =>
  (Bun.TOML.parse(SHIPPED[id]!.text) as { capabilities?: { cache?: unknown } }).capabilities?.cache !== undefined);
const UNLISTED = Object.keys(SHIPPED).filter((id) => !LISTED.includes(id));

// A tier as https://infer.flow7.org/api/public/catalog publishes it, trimmed to the fields the sync
// reads. Prices are USD per 1M tokens, and 0 means the route quotes none.
function tier(id: string, model: ExistingModel, official = id.endsWith(":official")) {
  return {
    selector: id,
    available: true,
    input_per_million_usd: model.cost?.input ?? 0,
    cached_input_per_million_usd: model.cost?.cache_read ?? 0,
    cache_write_per_million_usd: model.cost?.cache_write ?? 0,
    output_per_million_usd: model.cost?.output ?? 0,
    generation: null,
    // Discount routes publish no limits of their own; Official routes do.
    runtime: {
      max_context_tokens: official ? model.limit?.context : null,
      max_output_tokens: official ? model.limit?.output : null,
      vision: official,
      files: official,
      audio: false,
      video: false,
      structured_outputs: true,
      responses_api: true,
    },
    // Percent below the lab's list price: Official routes sell above it, discount routes below.
    market: { discounts: official
      ? { input_percent: -25, cached_input_percent: -25, output_percent: -25 }
      : { input_percent: 50, cached_input_percent: 50, output_percent: 50 } },
  };
}

type CatalogModel = { slug: string; kind: string; tiers: Record<string, unknown>; runtime: Record<string, unknown> | null };

// Every listed route as Infer would publish it. The model publishes the lowest limit across its routes.
function catalog(edit: (models: Map<string, CatalogModel>) => void = () => {}) {
  const models = new Map<string, CatalogModel>();
  for (const id of LISTED) {
    const { resolved } = SHIPPED[id]!;
    const [slug, route] = id.slice("infer/".length).split(":") as [string, string];
    const entry = models.get(slug) ?? { slug, kind: "exact", tiers: {}, runtime: null };
    entry.tiers[route] = tier(id, resolved);
    entry.runtime = { max_context_tokens: resolved.limit?.context, max_output_tokens: resolved.limit?.output };
    models.set(slug, entry);
  }
  edit(models);
  return { currency: "USD", environment: "live", simulated: false, live_available: true, models: [...models.values()] };
}

function route(id: string, overrides: Record<string, unknown> = {}, modelRuntime: Record<string, unknown> | null = null): InferRoute {
  const [slug, name] = id.slice("infer/".length).split(":") as [string, "low-cost" | "official"];
  const shipped = SHIPPED[id]?.resolved ?? ASTRA.resolved;
  const routeTier = { ...tier(id, shipped), ...overrides } as InferRoute["tier"];
  return { id, route: name, tier: routeTier, model: { slug, kind: "exact", tiers: { [name]: routeTier! }, runtime: modelRuntime } };
}

const none = { existing: () => undefined, authored: () => undefined };
const listed = (id: string) => ({ existing: () => SHIPPED[id]!.resolved, authored: () => SHIPPED[id]!.authored });

test("Infer is registered for scheduled sync and fetches its public catalog without credentials", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === infer.id)).toBe(true);
  expect(providers.infer).toBe(infer);
  expect(groups.aggregators).toContain("infer");
  // A route the catalog leaves out while it fails a health check is kept, so nothing is ever removed.
  expect(infer.deleteMissing).toBe(false);
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json(catalog());
  }) as unknown as typeof fetch;
  await fetchInferCatalog(fetcher);
  expect(request!.url).toBe("https://infer.flow7.org/api/public/catalog");
  expect(request!.headers.get("authorization")).toBeNull();

  const unavailable = (async () => new Response("", { status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch;
  expect(fetchInferCatalog(unavailable)).rejects.toThrow("Infer catalog request failed: 503 Service Unavailable");
});

test("empty, degraded, duplicate and malformed catalogs fail before any writes", () => {
  expect(() => InferCatalog.parse({ ...catalog(), models: [] })).toThrow("empty catalog");
  for (const degraded of [{ live_available: false }, { simulated: true }, { environment: "staging" }]) {
    expect(() => InferCatalog.parse({ ...catalog(), ...degraded })).toThrow("no live capacity");
  }
  const astra = catalog().models.find((model) => model.slug === "gpt-6-astra")!;
  expect(() => InferCatalog.parse({ ...catalog(), models: [...catalog().models, astra] })).toThrow("duplicate model slugs");
  expect(() => InferCatalog.parse(catalog((models) => {
    models.get("gpt-6-astra")!.tiers["low-cost"] = tier("infer/gpt-6-astra:balanced", ASTRA.resolved);
  }))).toThrow("doesn't match its model and tier");
  for (const input_per_million_usd of [-1, "1.18", null]) {
    expect(() => InferCatalog.parse(catalog((models) => {
      Object.assign(models.get("gpt-6-astra")!.tiers["low-cost"] as object, { input_per_million_usd });
    }))).toThrow();
  }
});

test("reads each text model's Low cost and Official routes, listed or not, and leaves out video models", () => {
  const routes = parseInferCatalog(catalog((models) => {
    models.set("kling-3.0", {
      slug: "kling-3.0", kind: "video_generation", runtime: null,
      tiers: { stable: { ...tier("infer/kling-3.0:stable", ASTRA.resolved), generation: { unit: "generated_second", prices: { "720p": 0.15 } } } },
    });
  }));
  const astra = routes.filter((item) => item.model.slug === "gpt-6-astra");
  expect(astra.map((item) => [item.id, item.tier?.selector])).toEqual([
    ["infer/gpt-6-astra:low-cost", "infer/gpt-6-astra:low-cost"],
    ["infer/gpt-6-astra:official", "infer/gpt-6-astra:official"],
  ]);
  // Grok 4.7 has no Official file, so its Official route is read but not listed.
  expect(routes.find((item) => item.id === "infer/grok-4.7:official")?.tier).toBeUndefined();
  expect(routes.some((item) => item.model.slug === "kling-3.0")).toBe(false);
});

test("creates a Low cost route as a text-only override of the lab model", () => {
  const source = route("infer/gpt-5.5:low-cost", {
    input_per_million_usd: 0.3, cached_input_per_million_usd: 0.03, cache_write_per_million_usd: 0, output_per_million_usd: 1.77,
  }, { max_context_tokens: 271_999, max_output_tokens: 128_000 });
  const created = infer.translateModel(source, none) as ReturnType<typeof createLowCostModel> & {};
  expect(created.model as unknown).toEqual({
    base_model: "openai/gpt-5.5",
    // The lab's 922,000 input limit would exceed Infer's 271,999 context.
    base_model_omit: ["limit.input"],
    name: `${modelMetadata("openai/gpt-5.5").name} (Low cost)`,
    attachment: false,
    modalities: { input: ["text"] },
    reasoning_options: [{ type: "effort", values: labReasoning("openai", "gpt-5.5").effort }],
    structured_output: true,
    limit: { context: 271_999 },
    // A cache-write rate of 0 isn't priced separately, so no write price is written.
    cost: { input: 0.3, output: 1.77, cache_read: 0.03 },
  });
  expect(created.v2Set?.["capabilities.reasoning"] as unknown).toEqual(labReasoning("openai", "gpt-5.5"));
  expect(created.header).toContain("# Exact selector: infer/gpt-5.5:low-cost.");
  expect(created.header).toContain("Reasoning controls copied from the lab's own entry");
  // AGENTS.md asks GPT-5+ hosts to say which custom-tool grammars they enforce.
  expect(created.header).toContain(NO_FREEFORM);
  expect(createLowCostModel(route("infer/claude-opus-5:low-cost"), route("infer/claude-opus-5:low-cost").tier!)!.header).not.toContain("freeform");
});

test("owns capabilities.cache: implicit wherever the route quotes a cache-read price, in step with that price", () => {
  const kind = (cached: number, current: unknown) => {
    const translated = infer.translateModel(route("infer/gpt-6-astra:low-cost", { cached_input_per_million_usd: cached },
      { max_context_tokens: 271_999 }), listed("infer/gpt-6-astra:low-cost")) as { v2Set?: Record<string, unknown> };
    return (translated.v2Set?.["capabilities.cache"] as (value: unknown) => unknown)(current);
  };
  // Infer meters cache reads with no cache control from the client, so a quoted cache-read price means it caches.
  expect(kind(0.12, undefined)).toEqual({ implicit: true });
  expect(kind(0.12, false)).toEqual({ implicit: true });
  // A file's own cache kinds are kept.
  const explicit = { implicit: true, explicit: { ttl: ["5m"] } };
  expect(kind(0.12, explicit)).toEqual(explicit);
  // Once the route quotes no cache-read price, the sync's own kind goes; anything authored stays.
  expect(kind(0, { implicit: true })).toBeUndefined();
  expect(kind(0, explicit)).toEqual(explicit);
  expect(kind(0, undefined)).toBeUndefined();
  // New files get it too.
  const created = createLowCostModel(route("infer/claude-opus-5:low-cost"), route("infer/claude-opus-5:low-cost").tier!)!;
  expect((created.v2Set?.["capabilities.cache"] as (value: unknown) => unknown)(undefined)).toEqual({ implicit: true });
});

test("creates a Low cost route only where the catalog shows it below the lab's list price", () => {
  const priced = (market: unknown) => route("infer/gpt-5.5:low-cost", { market }, { max_context_tokens: 271_999 });
  expect(infer.translateModel(priced({ discounts: { input_percent: 94, output_percent: 94.1 } }), none)).toBeDefined();
  for (const market of [
    { discounts: { input_percent: -150, output_percent: -146 } }, // above the lab's list price
    { discounts: { input_percent: 40, output_percent: 0 } }, // not below it on output
    { discounts: { input_percent: null, output_percent: null } }, // no list price to compare with
    null,
  ]) {
    const source = priced(market);
    expect(infer.translateModel(source, none)).toBeUndefined();
    // It isn't a discount route, so it isn't reported as waiting for authoring either.
    expect(infer.sourceID(source)).toBeUndefined();
  }
});

test("an existing Low cost file stays priced once the catalog stops showing it below list, and is reported", () => {
  const above = route("infer/gpt-6-astra:low-cost", { input_per_million_usd: 9, market: { discounts: { input_percent: -10, output_percent: 5 } } },
    { max_context_tokens: 271_999, max_output_tokens: 128_000 });
  const kept = infer.translateModel(above, listed(above.id)) as { model: SyncedModel; notices?: string[] };
  expect(kept.model.cost).toMatchObject({ input: 9 });
  expect(kept.notices).toEqual([expect.stringContaining("infer/gpt-6-astra:low-cost isn't below the lab's list price in the catalog (input -10%, output 5%)")]);
  // Official routes sell above list by design, so they aren't reported.
  const official = route("infer/gpt-6-astra:official", {}, { max_context_tokens: 271_999, max_output_tokens: 128_000 });
  expect((infer.translateModel(official, listed(official.id)) as { notices?: string[] }).notices).toBeUndefined();
});

test("copies the lab's reasoning controls with their default, and skips a toggle Infer's Responses API has no field for", () => {
  const gemini = createLowCostModel(route("infer/gemini-3.6-flash:low-cost"), route("infer/gemini-3.6-flash:low-cost").tier!)!;
  expect(gemini.v2Set?.["capabilities.reasoning"] as unknown).toEqual(labReasoning("google", "gemini-3.6-flash"));
  expect(labReasoning("google", "gemini-3.6-flash").default).toEqual({ type: "effort", value: expect.any(String) });

  // A token budget goes on reasoning.max_tokens, which Infer documents, and the header says so.
  const haiku = createLowCostModel(route("infer/claude-haiku-4-5:low-cost"), route("infer/claude-haiku-4-5:low-cost").tier!)!;
  const budget = labReasoning("anthropic", "claude-haiku-4-5").budget as Record<string, number>;
  expect(budget).toBeDefined();
  expect(haiku.model as unknown).toMatchObject({ reasoning_options: [{ type: "budget_tokens", ...budget }] });
  expect(haiku.header).toContain("# Budget: reasoning.max_tokens on /v1/responses");
  expect(gemini.header).not.toContain("# Budget:");

  for (const id of [
    "infer/claude-sonnet-5:low-cost", // a thinking toggle
    "infer/deepseek-v4-flash:low-cost", // a lab the sync doesn't map
    "infer/gemini-3.8-flash-high:low-cost", // no lab model to base it on
  ]) {
    const source = route(id);
    expect(infer.translateModel(source, none)).toBeUndefined();
    expect(infer.sourceID(source)).toBe(id);
  }
  // An Official route is never created, and isn't reported either.
  const official = route("infer/grok-4.7:official");
  expect(infer.translateModel(official, none)).toBeUndefined();
  expect(infer.sourceID(official)).toBeUndefined();
});

test("limits: a published limit below the lab's is written, output never passes the context, and a lab input above it is dropped", () => {
  // Grok 4.7: the model publishes a 450,000 output against a 199,999 context.
  const grok = route("infer/grok-4.7:low-cost", {}, { max_context_tokens: 199_999, max_output_tokens: 450_000 });
  expect(createLowCostModel(grok, grok.tier!)!.model).toMatchObject({ limit: { context: 199_999, output: 199_999 } });
  // Claude Opus 5.5: Infer's figures match the lab's, so the lab's are inherited.
  const opus = route("infer/claude-opus-5-5:low-cost", {}, { max_context_tokens: 1_000_000, max_output_tokens: 128_000 });
  expect(createLowCostModel(opus, opus.tier!)!.model).not.toHaveProperty("limit");
  // A route's own limit wins over the model's.
  const own = route("infer/claude-opus-5-5:low-cost", { runtime: { ...route("infer/claude-opus-5-5:low-cost").tier!.runtime, max_context_tokens: 400_000 } },
    { max_context_tokens: 1_000_000 });
  expect(createLowCostModel(own, own.tier!)!.model).toMatchObject({ limit: { context: 400_000 } });
  // With no published figure, an existing file keeps its own limits.
  const silent = route("infer/gpt-6-astra:low-cost", {}, null);
  expect(buildInferModel(silent, silent.tier!, ASTRA.resolved, ASTRA.authored))
    .toMatchObject({ base_model_omit: ["limit.input"], limit: { context: 271_999 } });
});

test("an update takes the catalog's prices and drops a cache price the route no longer quotes", () => {
  const repriced = route("infer/gpt-6-astra:low-cost", { input_per_million_usd: 1.2, cache_write_per_million_usd: 0 },
    { max_context_tokens: 271_999, max_output_tokens: 128_000 });
  const model = buildInferModel(repriced, repriced.tier!, ASTRA.resolved, ASTRA.authored);
  expect(model.cost).toEqual({ input: 1.2, output: ASTRA.resolved.cost!.output, cache_read: ASTRA.resolved.cost!.cache_read });
  // Everything else is the file's: name, text-only input and reasoning controls, factored on its lab.
  expect(model).toMatchObject({ base_model: "openai/gpt-6-astra", name: ASTRA.authored.name,
    reasoning_options: ASTRA.authored.reasoning_options, modalities: { input: ["text"] } });
});

// A throwaway checkout: provider.toml, the shipped files and the lab files they point at, so the
// runner resolves base_model as it does in the repo.
async function inRoot(run: (modelsDir: string, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-infer-"));
  const modelsDir = path.join(root, "providers", "infer", "models");
  await mkdir(path.join(modelsDir, "infer"), { recursive: true });
  try {
    await copyFile(path.join(REPO, "providers", "infer", "provider.toml"), path.join(root, "providers", "infer", "provider.toml"));
    const labs = new Set(Object.values(SHIPPED).map(({ authored }) => authored.base_model!));
    for (const { file, text } of Object.values(SHIPPED)) await writeFile(path.join(modelsDir, "infer", file), text);
    for (const lab of labs) {
      await mkdir(path.join(root, "models", path.dirname(lab)), { recursive: true });
      await copyFile(path.join(REPO, "models", `${lab}.toml`), path.join(root, "models", `${lab}.toml`));
    }
    await run(modelsDir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const at = (modelsDir: string, source: () => unknown) => ({ ...infer, modelsDir, fetchModels: async () => source() });
const read = (modelsDir: string, id: string) => readFile(path.join(modelsDir, `${id}.toml`), "utf8");

test("the shipped files are a fixed point", async () => {
  await inRoot(async (modelsDir) => {
    for (let run = 0; run < 2; run++) {
      const result = await syncProvider(at(modelsDir, () => catalog()));
      expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: Object.keys(SHIPPED).length, files: [] });
      // Only a route the catalog no longer lists is named, as kept.
      expect(result.notices).toHaveLength(UNLISTED.length === 0 ? 0 : 1);
      for (const id of UNLISTED) expect(result.notices[0]).toContain(`\`${id}.toml\``);
    }
    for (const [id, { text }] of Object.entries(SHIPPED)) expect(await read(modelsDir, id)).toBe(text);
  });
});

test("a file that lost its cache kind gets it back, and loses it with the route's cache-read price", async () => {
  await inRoot(async (modelsDir) => {
    const file = path.join(modelsDir, "infer", ASTRA.file);
    await writeFile(file, ASTRA.text.replace("cache = { implicit = true }\n", ""));
    expect(await syncProvider(at(modelsDir, () => catalog()))).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    expect(await read(modelsDir, "infer/gpt-6-astra:low-cost")).toBe(ASTRA.text);

    await syncProvider(at(modelsDir, () => catalog((models) => {
      Object.assign(models.get("gpt-6-astra")!.tiers["low-cost"] as object, { cached_input_per_million_usd: 0, cache_write_per_million_usd: 0 });
    })));
    const uncached = Bun.TOML.parse(await read(modelsDir, "infer/gpt-6-astra:low-cost")) as {
      capabilities: Record<string, unknown>; cost: { text: { input: Record<string, unknown> } };
    };
    expect(uncached.capabilities).not.toHaveProperty("cache");
    expect(uncached.cost.text.input).not.toHaveProperty("cache");
  });
});

test("a repricing changes the price line and nothing else", async () => {
  await inRoot(async (modelsDir) => {
    const input = ASTRA.resolved.cost!.input;
    const result = await syncProvider(at(modelsDir, () => catalog((models) => {
      Object.assign(models.get("gpt-6-astra")!.tiers["low-cost"] as object, { input_per_million_usd: input * 2 });
    })));
    expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    expect(await read(modelsDir, "infer/gpt-6-astra:low-cost"))
      .toBe(ASTRA.text.replace(`[cost.text.input]\nprice = ${input}\n`, `[cost.text.input]\nprice = ${input * 2}\n`));
  });
});

test("nothing is removed: a route or a model missing from the catalog is kept and named in the report", async () => {
  await inRoot(async (modelsDir) => {
    // GPT-6 Astra's Low cost route drops out, and every route of a model with an Official file disappears.
    const official = Object.keys(SHIPPED).find((id) => id.endsWith(":official") && id !== "infer/gpt-6-astra:official")!;
    const slug = official.slice("infer/".length, -":official".length);
    const missing = ["infer/gpt-6-astra:low-cost", ...Object.keys(SHIPPED).filter((id) => id.startsWith(`infer/${slug}:`))];
    const result = await syncProvider(at(modelsDir, () => catalog((models) => {
      delete models.get("gpt-6-astra")!.tiers["low-cost"];
      models.delete(slug);
    })));
    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0, files: [] });
    expect(result.notices).toHaveLength(1);
    for (const id of missing) expect(result.notices[0]).toContain(`\`${id}.toml\``);
    for (const [id, { text }] of Object.entries(SHIPPED)) expect(await read(modelsDir, id)).toBe(text);

    // An Official-only catalog, as in an outage, removes nothing either; an empty one fails.
    const outage = await syncProvider(at(modelsDir, () => catalog((models) => {
      for (const model of models.values()) delete model.tiers["low-cost"];
    })));
    expect(outage).toMatchObject({ created: 0, deleted: 0 });
    expect(syncProvider(at(modelsDir, () => ({ ...catalog(), models: [] })))).rejects.toThrow("empty catalog");
    for (const [id, { text }] of Object.entries(SHIPPED)) expect(await read(modelsDir, id)).toBe(text);
  });
});

test("every file the sync created comes back byte for byte from its lab, and the next run changes nothing", async () => {
  const created = Object.entries(SHIPPED).filter(([, { text }]) => text.startsWith(`# Generated by bun models:sync infer from `));
  expect(created.length).toBeGreaterThan(0);
  await inRoot(async (modelsDir, root) => {
    for (const [id] of created) await rm(path.join(modelsDir, `${id}.toml`));
    expect(await syncProvider(at(modelsDir, () => catalog()))).toMatchObject({ created: created.length, updated: 0, deleted: 0 });
    for (const [id, { text }] of created) expect(await read(modelsDir, id)).toBe(text);

    const generated = (await generate(path.join(root, "providers"))).infer!.models;
    for (const [id, { authored }] of created) {
      expect(generated[id]).toMatchObject({ name: `${modelMetadata(authored.base_model!).name} (Low cost)`, modalities: { input: ["text"], output: ["text"] } });
      const [lab, model] = authored.base_model!.split("/") as [string, string];
      expect((Bun.TOML.parse(await read(modelsDir, id)) as { capabilities: { reasoning: unknown } }).capabilities.reasoning)
        .toEqual(labReasoning(lab, model));
    }
    expect(await syncProvider(at(modelsDir, () => catalog()))).toMatchObject({ created: 0, updated: 0, deleted: 0 });
  });
});

// The lab's own reasoning table, as `providers/<lab>/models/<model>.toml` writes it.
function labReasoning(lab: string, model: string) {
  const toml = Bun.TOML.parse(readFileSync(path.join(REPO, "providers", lab, "models", `${model}.toml`), "utf8")) as {
    capabilities: { reasoning: { effort?: string[]; budget?: unknown; default?: unknown } };
  };
  return toml.capabilities.reasoning;
}
