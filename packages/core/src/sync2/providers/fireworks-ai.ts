// Fireworks AI: the serverless pricing feed (https://api.fireworks.ai/v1/serverless/models)
// and List Models (https://api.fireworks.ai/v1/accounts/fireworks/models, filtered
// to serverless), both with FIREWORKS_API_KEY. The feed gives invocation IDs,
// prices, modalities, context and flag modes (Priority); List Models says what
// is still served and when it is deprecated. A model in neither isn't served.
// Authoritative: token prices, the Priority multiplier and mode, input and
// output kinds, the context window (only lowered), deprecation, and the
// Responses and Messages APIs every serverless text model has. Output limits,
// reasoning controls and tool support aren't listed, so new models are added by hand.

import { z } from "zod";

import { bearer, fetchJSON, requireEnv } from "../http.js";
import type { Observation, SyncModule } from "../types.js";
import { round } from "../units.js";

const API_ENDPOINT = "https://api.fireworks.ai/v1/serverless/models";
const INVENTORY_ENDPOINT = "https://api.fireworks.ai/v1/accounts/fireworks/models";
// Fireworks announced GLM 5.2 serverless retirement for 2026-09-25, but on
// 2026-09-28 List Models still returns supportsServerless=true and no date.
// https://docs.fireworks.ai/updates/changelog (2026-09-12)
const DEPRECATION_DATE_FALLBACK: Record<string, string> = {
  "accounts/fireworks/models/glm-5p2": "2026-09-25",
};

const FireworksModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  serverless_mode: z.string().min(1),
  service_tier: z.string().min(1).optional(),
  usage_identifier: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  pricing: z.array(z.object({ sku: z.string().min(1), amount: z.string().regex(/^\d+(?:\.\d+)?$/), unit: z.literal("1M tokens") }).passthrough()),
  display_name: z.string().min(1),
  context_length: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
}).passthrough();
type FireworksModel = z.infer<typeof FireworksModel>;

const FireworksRouter = z.object({ id: z.string().min(1), object: z.literal("model"), kind: z.literal("router") }).passthrough();

// FireRouter auto routes to other models and has no fixed modalities or token prices.
const FireworksResponse = z.object({
  object: z.literal("list"),
  data: z.array(z.union([FireworksRouter, FireworksModel]))
    .transform((rows) => rows.filter((row): row is FireworksModel => row.kind !== "router")),
}).passthrough();

const InventoryModel = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  supportsServerless: z.boolean(),
  deprecationDate: z.object({ year: z.number().int().min(1), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).nullish(),
}).passthrough();
type InventoryModel = z.infer<typeof InventoryModel>;

const InventoryResponse = z.object({ models: z.array(InventoryModel), nextPageToken: z.string().optional() }).passthrough();

const Raw = z.object({ serverless: FireworksResponse, inventory: z.array(InventoryModel) });

// Legacy BERT embedding models still serve on serverless under their Hugging
// Face IDs but are in neither source, so they're listed here to keep their files.
// https://docs.fireworks.ai/guides/querying-embeddings-models ("BERT-based models (legacy)")
const LEGACY_EMBEDDING_MODELS = [
  "BAAI/bge-small-en-v1.5",
  "thenlper/gte-base",
  "BAAI/bge-base-en-v1.5",
  "nomic-ai/nomic-embed-text-v1.5",
  "nomic-ai/nomic-embed-text-v1",
  "thenlper/gte-large",
  "WhereIsAI/UAE-Large-V1",
  "mixedbread-ai/mxbai-embed-large-v1",
];

// Serverless text models are also served on the Responses API and the Anthropic Messages API:
// https://docs.fireworks.ai/guides/response-api
// https://docs.fireworks.ai/api-reference/anthropic-messages
const EXTRA_APIS = {
  responses: { sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" } },
  messages: { sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/anthropic-compatible" } },
};

const KINDS = new Set(["text", "audio", "image", "video", "pdf"]);

export const fireworksAi: SyncModule<unknown> = {
  id: "fireworks-ai",
  name: "Fireworks AI",
  policy: {
    owns: [
      { path: "status", merge: "deprecated" },
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      { path: "limit.context", merge: "min" },
      { path: "limit.output", merge: "min" },
      { path: "api", merge: "tables" },
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.output.price",
      "cost.multipliers",
      { path: "experimental.modes", merge: "tables" },
    ],
    creates: "gap",
    removals: "delete",
  },
  async fetch() {
    const key = requireEnv("Fireworks AI", "FIREWORKS_API_KEY");
    const [serverless, inventory] = await Promise.all([
      fetchJSON(API_ENDPOINT, { source: "Fireworks AI models", headers: bearer(key) }),
      fetchInventory(key),
    ]);
    return { serverless, inventory };
  },
  observe(raw) {
    const { serverless, inventory } = Raw.parse(raw);
    return [
      ...merge(serverless.data, inventory),
      // Hand-authored embedding files, kept as written.
      ...LEGACY_EMBEDDING_MODELS.map((id) => ({ id, updateOnly: true })),
    ];
  },
};

async function fetchInventory(key: string): Promise<InventoryModel[]> {
  const models: InventoryModel[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(INVENTORY_ENDPOINT);
    url.searchParams.set("filter", "supports_serverless=true");
    url.searchParams.set("pageSize", "200");
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const page = InventoryResponse.parse(await fetchJSON(url.toString(), { source: "Fireworks AI inventory", headers: bearer(key) }));
    models.push(...page.models);
    pageToken = page.nextPageToken || undefined;
  } while (pageToken !== undefined);
  return models;
}

type Expanded = FireworksModel & { catalogId: string; flagModes: FireworksModel[] };

function merge(serverless: FireworksModel[], inventory: InventoryModel[], now = new Date()): Observation[] {
  if (serverless.length === 0 || inventory.length === 0) throw new Error("Fireworks AI returned an empty serverless source; refusing destructive sync");
  const today = now.toISOString().slice(0, 10);
  const deprecated = new Set<string>();
  const available = inventory.filter((model) => {
    if (!model.supportsServerless) return false;
    const date = model.deprecationDate;
    // A date has no time zone; the model is kept through that UTC day.
    const lastDay = date == null
      ? DEPRECATION_DATE_FALLBACK[model.name]
      : `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
    if (lastDay !== undefined) deprecated.add(model.name);
    return lastDay === undefined || lastDay >= today;
  });
  // Pricing rows can outlive serverless deployments, so only rows List Models still has count.
  const availableIds = new Set(available.map((model) => model.name));
  const expanded = expand(serverless.filter((model) => availableIds.has(model.id)));
  const ids = new Set(expanded.map((model) => model.catalogId));
  const inventoryOnly = available.filter((model) => model.kind === "HF_BASE_MODEL" && !ids.has(model.name));
  if (!expanded.some((model) => model.output_modalities.includes("text")) && inventoryOnly.length === 0) {
    throw new Error("Fireworks AI returned an empty active serverless inventory; refusing destructive sync");
  }
  return [
    // Non-text, non-embedding rows (image generation) aren't catalog models here.
    ...expanded
      .filter((model) => model.output_modalities.includes("text") || model.output_modalities.includes("embeddings"))
      .map((model) => observe(model, deprecated.has(model.id))),
    // Models List Models has but the pricing feed doesn't: only their lifecycle and APIs.
    ...inventoryOnly.map((model): Observation => ({ id: model.name, status: deprecated.has(model.name) ? "deprecated" : null, api: EXTRA_APIS })),
  ];
}

// A default row owns the base ID and carries flag modes (Priority); a
// priority-only model's recipe becomes the base invocation. Usage identifiers
// and aliases are their own catalog IDs.
function expand(models: FireworksModel[]): Expanded[] {
  const expanded = new Map<string, Expanded>();
  const add = (catalogId: string, model: FireworksModel, flagModes: FireworksModel[]) => {
    if (!expanded.has(catalogId)) expanded.set(catalogId, { ...model, catalogId, flagModes });
  };
  for (const rows of Map.groupBy(models, (model) => model.id).values()) {
    const defaultRow = rows.find((model) => model.usage_identifier === undefined && model.service_tier === undefined);
    const flagModes = rows.filter((model) => model.service_tier !== undefined);
    const baseRow = defaultRow ?? flagModes[0];
    if (baseRow !== undefined) add(baseRow.id, baseRow, defaultRow === undefined ? [] : flagModes);
    for (const model of rows) {
      if (model.usage_identifier !== undefined) add(model.usage_identifier, model, []);
      for (const alias of model.aliases ?? []) add(alias, model, model === defaultRow ? flagModes : []);
    }
  }
  return [...expanded.values()];
}

function prices(model: FireworksModel) {
  const bySku = new Map(model.pricing.map((price) => [price.sku, Number(price.amount)]));
  return {
    input: bySku.get("LLM input tokens (uncached)"),
    cacheRead: bySku.get("LLM input tokens (cached)"),
    output: bySku.get("LLM output tokens"),
  };
}

function observe(model: Expanded, deprecated: boolean): Observation {
  const id = model.catalogId;
  // Embedding files are hand-authored; keep them as written.
  if (model.output_modalities.includes("embeddings")) return { id, updateOnly: true };
  const base = prices(model);
  if (base.input === undefined || base.output === undefined) {
    throw new Error(`Fireworks AI model ${model.id} ${model.serverless_mode} mode has incomplete token pricing`);
  }
  const kinds = (values: string[]) => values.filter((value) => KINDS.has(value)).map((value) => (value === "pdf" ? "application/pdf" : value));
  const input = kinds(model.input_modalities);
  const output = kinds(model.output_modalities);
  const modes: Record<string, unknown> = { priority: null };
  const multipliers: unknown[] = [];
  for (const mode of model.flagModes) {
    const tier = mode.service_tier!;
    const modePrices = prices(mode);
    const factor = uniformFactor(base, modePrices);
    if (factor !== undefined) multipliers.push({ when: { service_tier: { equals: tier } }, factor });
    modes[mode.serverless_mode] = {
      ...(tier === mode.serverless_mode ? {} : { service_tier: tier }),
      body: { service_tier: tier },
      // Prices that aren't a plain multiple of the base stay on the mode.
      ...(factor === undefined ? { cost: { text: { input: { price: modePrices.input ?? base.input, ...(modePrices.cacheRead === undefined ? {} : { cache: { read: modePrices.cacheRead } }) }, output: { price: modePrices.output ?? base.output } } } } : {}),
    };
  }
  // Built loosely: service tiers and mode tables come from the source as plain strings.
  return {
    id,
    status: deprecated ? "deprecated" : null,
    modalities: { ...(input.length > 0 ? { input } : {}), ...(output.length > 0 ? { output } : {}) },
    // The listed window is the advertised one; some deployments reserve a few
    // prompt tokens, so a smaller verified file value stays. Output never exceeds it.
    limit: { context: model.context_length, output: model.context_length },
    api: EXTRA_APIS,
    cost: {
      text: {
        input: { price: base.input, ...(base.cacheRead === undefined ? {} : { cache: { read: base.cacheRead } }) },
        output: { price: base.output },
      },
      multipliers: multipliers.length > 0 ? multipliers : null,
    },
    experimental: { modes },
  } as Observation;
}

// The one factor that turns every base price into the mode's, if there is one.
function uniformFactor(base: ReturnType<typeof prices>, mode: ReturnType<typeof prices>) {
  if (base.input === undefined || mode.input === undefined) return undefined;
  const factor = round(mode.input / base.input);
  const scaled = (value: number | undefined, other: number | undefined) => (value === undefined ? true : round(value * factor) === (other ?? value));
  return scaled(base.output, mode.output) && scaled(base.cacheRead, mode.cacheRead) ? factor : undefined;
}
