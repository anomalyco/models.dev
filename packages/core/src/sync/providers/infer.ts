import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { ReasoningSupportV2 } from "../../schema-v2.js";
import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel, modelMetadata } from "./openrouter.js";

const API_ENDPOINT = "https://infer.flow7.org/api/public/catalog";
const ROOT = path.join(import.meta.dirname, "..", "..", "..", "..", "..");

// Infer names each model after the lab's own id, so the prefix says which lab made it.
const LABS: Array<[prefix: string, lab: string]> = [
  ["claude-", "anthropic"],
  ["gpt-", "openai"],
  ["grok-", "xai"],
  ["gemini-", "google"],
];
// Low cost files are created from the catalog and kept priced. Official files are added by hand,
// and the sync only prices them.
const ROUTES = ["low-cost", "official"] as const;

// USD per 1M tokens already. A negative or non-numeric price fails the run.
const Price = z.number().nonnegative();
// A limit the catalog doesn't publish is null.
const Limit = z.number().int().positive().nullish();

const Runtime = z.object({ max_context_tokens: Limit, max_output_tokens: Limit }).passthrough();

const Tier = z.object({
  selector: z.string(),
  available: z.boolean(),
  input_per_million_usd: Price,
  cached_input_per_million_usd: Price,
  cache_write_per_million_usd: Price,
  output_per_million_usd: Price,
  // Image and video tiers are priced per image or generated second, which a token price can't hold.
  generation: z.unknown().nullish(),
  runtime: Runtime.extend({
    vision: z.boolean().optional(),
    files: z.boolean().optional(),
    audio: z.boolean().optional(),
    video: z.boolean().optional(),
    structured_outputs: z.boolean().optional(),
    responses_api: z.boolean().optional(),
  }),
  // How far the route's prices sit below the lab's own list price, in percent; null without a list price.
  market: z.object({
    discounts: z.object({
      input_percent: z.number().nullish(),
      output_percent: z.number().nullish(),
    }).passthrough().nullish(),
  }).passthrough().nullish(),
}).passthrough();

const CatalogModel = z.object({
  slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  kind: z.string(),
  tiers: z.record(z.string(), Tier),
  runtime: Runtime.nullish(),
}).passthrough();

export const InferCatalog = z.object({
  environment: z.string(),
  simulated: z.boolean(),
  live_available: z.boolean(),
  models: z.array(CatalogModel).min(1, "Infer returned an empty catalog"),
}).passthrough()
  .refine(
    (catalog) => catalog.environment === "live" && !catalog.simulated && catalog.live_available,
    "Infer's catalog reports no live capacity; refusing to sync from it",
  )
  .refine(
    (catalog) => new Set(catalog.models.map((model) => model.slug)).size === catalog.models.length,
    "Infer returned duplicate model slugs",
  )
  .refine(
    (catalog) => catalog.models.every((model) =>
      Object.entries(model.tiers).every(([tier, route]) => route.selector === `infer/${model.slug}:${tier}`)),
    "Infer returned a selector that doesn't match its model and tier",
  );

export type InferCatalogModel = z.infer<typeof CatalogModel>;
export type InferTier = z.infer<typeof Tier>;

/** One route of one model, listed or not: `id` is its exact selector and the file id. */
export interface InferRoute {
  id: string;
  route: (typeof ROUTES)[number];
  model: InferCatalogModel;
  tier?: InferTier;
}

export const infer = {
  id: "infer",
  name: "Infer by Flow7",
  modelsDir: "providers/infer/models",
  // Every file names its lab model, and the sync writes that pointer itself.
  preserveBaseModels: false,
  // The catalog lists only routes that pass Infer's health checks at that moment, so a route can drop
  // out for a few minutes while it is still served. Absence isn't retirement: missing routes are kept
  // and named in the report, and a person removes one once Infer has stopped serving it.
  deleteMissing: false,
  missingNotice(paths) {
    return paths.length === 0 ? [] : [
      `Infer routes missing from the catalog, kept because the catalog leaves a route out while it fails a health check; remove one by hand once Infer has stopped serving it: ${paths.map((file) => `\`${file}\``).join(", ")}`,
    ];
  },
  fetchModels: fetchInferCatalog,
  parseModels(raw) {
    return parseInferCatalog(raw);
  },
  // Reported: a Low cost route below the lab's list price that the sync couldn't create.
  sourceID(route) {
    return route.route === "low-cost" && route.tier !== undefined && servable(route.tier) && belowListPrice(route.tier)
      ? route.id
      : undefined;
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `Infer Low cost routes awaiting a lab model to base them on, or reasoning controls authored by hand: ${ids.join(", ")}`,
    ];
  },
  translateModel(route, context) {
    const { tier } = route;
    if (tier === undefined || !servable(tier)) return undefined;
    const existing = context.existing(route.id);
    const authored = context.authored(route.id);
    if (existing === undefined || authored === undefined) {
      // Only a route the catalog shows below the lab's own list price is listed as Low cost.
      return route.route === "low-cost" && belowListPrice(tier) ? createLowCostModel(route, tier) : undefined;
    }
    const model = buildInferModel(route, tier, existing, authored);
    const v2Set = cacheKind(tier);
    if (route.route === "official" || belowListPrice(tier)) return { id: route.id, model, v2Set };
    const discounts = tier.market?.discounts;
    return {
      id: route.id,
      model,
      v2Set,
      notices: [
        `${route.id} isn't below the lab's list price in the catalog (input ${discounts?.input_percent ?? "n/a"}%, `
          + `output ${discounts?.output_percent ?? "n/a"}%); it is still synced, so remove it by hand if it shouldn't stay listed`,
      ],
    };
  },
} satisfies SyncProvider<InferRoute>;

export async function fetchInferCatalog(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Infer catalog request failed: ${response.status} ${response.statusText}`);
  }
  return InferCatalog.parse(await response.json());
}

/** The Low cost and Official route of each text model, listed or not. */
export function parseInferCatalog(raw: unknown): InferRoute[] {
  return InferCatalog.parse(raw).models
    .filter((model) => model.kind === "exact")
    .flatMap((model) => ROUTES.map((route) => ({ id: `infer/${model.slug}:${route}`, route, model, tier: model.tiers[route] })));
}

// A token-priced route that takes Responses requests, as provider.toml's @ai-sdk/openai sends them.
function servable(tier: InferTier) {
  return tier.available && tier.generation == null && tier.runtime.responses_api === true;
}

// Input and output both priced below the lab's own list price, as the catalog's market data shows.
function belowListPrice(tier: InferTier) {
  const discounts = tier.market?.discounts;
  const below = (value: number | null | undefined) => typeof value === "number" && value > 0;
  return below(discounts?.input_percent) && below(discounts?.output_percent);
}

/**
 * Infer meters cache reads without any cache control from the client ("Prompt cache reads and writes
 * are first-class metered usage", https://infer.flow7.org/docs), so a route that quotes a cache-read
 * price caches implicitly. A file's own cache kinds are kept while it does; once the route quotes no
 * cache-read price, the sync's own `{ implicit = true }` goes with it.
 */
function cacheKind(tier: InferTier) {
  const caches = tier.cached_input_per_million_usd > 0;
  const implicitOnly = (value: unknown) =>
    value !== null && typeof value === "object" && Object.keys(value).length === 1 && (value as { implicit?: unknown }).implicit === true;
  return {
    "capabilities.cache": (current: unknown) => {
      if (caches) return current !== null && typeof current === "object" ? current : { implicit: true };
      return implicitOnly(current) ? undefined : current;
    },
  };
}

// AGENTS.md asks every host of an OpenAI GPT-5 or later model to say which custom-tool grammars it enforces.
function gptFiveOrLater(slug: string) {
  return Number(/^gpt-(\d+)/u.exec(slug)?.[1] ?? 0) >= 5;
}
const NO_FREEFORM = "# No freeform: Infer's docs (https://infer.flow7.org/docs, Responses API) say custom tools the client runs pass through; with no paid probe, grammar enforcement is unverified, so freeform is left out.";

/** Prices and limits from the catalog. Every other field stays as the file has it. */
export function buildInferModel(route: InferRoute, tier: InferTier, existing: ExistingModel, authored: ExistingModel): SyncedModel {
  const { base_model: baseModel, base_model_omit: omit, ...current } = existing;
  const { limit, omitInput } = inferLimit(route, tier, baseModel === undefined ? {} : labLimit(baseModel), authored.limit);
  const values = { ...current, cost: { ...current.cost, ...inferCost(tier) }, limit } as SyncedFullModel;
  if (baseModel === undefined) return values;
  const kept = (omit ?? []).filter((key) => key !== "limit.input");
  const nextOmit = omitInput ? [...kept, "limit.input"] : kept;
  return factorBaseModel(baseModel, values, undefined, nextOmit.length > 0 ? nextOmit : undefined);
}

/** A new Low cost file, written the way the hand-written ones were. */
export function createLowCostModel(route: InferRoute, tier: InferTier) {
  const lab = LABS.find(([prefix]) => route.model.slug.startsWith(prefix))?.[1];
  if (lab === undefined) return undefined;
  const baseModel = `${lab}/${route.model.slug}`;
  if (!existsSync(path.join(ROOT, "models", `${baseModel}.toml`))) return undefined;
  const reasoning = labReasoning(lab, route.model.slug);
  if (reasoning === undefined) return undefined;

  const { limit, omitInput } = inferLimit(route, tier, labLimit(baseModel), undefined);
  // Infer's discount routes take no image or file input, so they're text in and text out.
  const textOnly = !tier.runtime.vision && !tier.runtime.files && !tier.runtime.audio && !tier.runtime.video;
  const values = {
    name: `${modelMetadata(baseModel).name} (Low cost)`,
    ...(textOnly && { attachment: false, modalities: { input: ["text"], output: ["text"] } }),
    reasoning_options: [
      ...(reasoning.effort === undefined ? [] : [{ type: "effort", values: reasoning.effort }]),
      ...(reasoning.budget === undefined ? [] : [{ type: "budget_tokens", ...reasoning.budget }]),
    ],
    ...(tier.runtime.structured_outputs && { structured_output: true }),
    limit,
    cost: inferCost(tier),
  } as Parameters<typeof factorBaseModel>[1];

  return {
    id: route.id,
    model: factorBaseModel(baseModel, values, undefined, omitInput ? ["limit.input"] : undefined),
    header: [
      `# Generated by bun models:sync infer from ${API_ENDPOINT}.`,
      `# Exact selector: ${route.id}. Prices are USD per million tokens.`,
      ...(textOnly ? ["# Text in and out: the catalog lists this route without image or file input."] : []),
      "# Limits: Infer's published figures where they're below the lab's; otherwise the lab's.",
      "# Reasoning controls copied from the lab's own entry, as AGENTS.md asks of relays.",
      ...(reasoning.budget === undefined ? [] : ["# Budget: reasoning.max_tokens on /v1/responses; Infer drops a budget at or above the output cap."]),
      ...(lab === "openai" && gptFiveOrLater(route.model.slug) ? [NO_FREEFORM] : []),
    ].join("\n"),
    // The reasoning table is copied as the lab writes it, so a default effort v1 fields can't carry comes along.
    v2Set: { "capabilities.reasoning": reasoning, ...cacheKind(tier) },
  };
}

/**
 * The lab's own reasoning controls, from `providers/<lab>/models/<model>.toml`. Effort levels go on
 * the Responses `reasoning.effort` and a token budget on `reasoning.max_tokens`, as
 * https://infer.flow7.org/docs describes. Infer documents no field that switches thinking on or off,
 * so a model with a toggle waits for controls authored by hand.
 */
function labReasoning(lab: string, model: string) {
  const file = path.join(ROOT, "providers", lab, "models", `${model}.toml`);
  if (!existsSync(file)) return undefined;
  const toml = Bun.TOML.parse(readFileSync(file, "utf8")) as { capabilities?: { reasoning?: unknown } };
  const parsed = ReasoningSupportV2.safeParse(toml.capabilities?.reasoning);
  if (!parsed.success || !parsed.data.supported) return undefined;
  const reasoning = parsed.data;
  if (reasoning.toggle !== undefined || reasoning.default?.type === "toggle") return undefined;
  return reasoning;
}

function labLimit(baseModel: string) {
  return (modelMetadata(baseModel).limit ?? {}) as { context?: number; input?: number; output?: number };
}

/**
 * Infer publishes limits per route where the route has its own, and per model otherwise (the lowest
 * across the model's routes). A published limit below the lab's goes in the file; one at or above it
 * leaves the lab's. Without a published figure the file keeps its own. Output never exceeds the
 * context, and a lab input limit above the context is dropped.
 */
function inferLimit(
  route: InferRoute,
  tier: InferTier,
  lab: { context?: number; input?: number; output?: number },
  own: ExistingModel["limit"] | undefined,
) {
  const published = (key: "max_context_tokens" | "max_output_tokens") =>
    tier.runtime[key] ?? route.model.runtime?.[key] ?? undefined;
  const pick = (value: number | undefined, labValue: number | undefined, ownValue: number | undefined) => {
    if (value === undefined) return ownValue ?? labValue;
    return labValue === undefined || value < labValue ? value : labValue;
  };
  const context = pick(published("max_context_tokens"), lab.context, own?.context);
  const output = pick(published("max_output_tokens"), lab.output, own?.output);
  const limit = {
    ...(context !== undefined && { context }),
    ...(output !== undefined && { output: context === undefined ? output : Math.min(output, context) }),
  };
  return { limit, omitInput: lab.input !== undefined && context !== undefined && lab.input > context };
}

// A price of 0 means the route quotes none (Grok's cache writes, for one), not a free one.
function inferCost(tier: InferTier) {
  const quoted = (value: number) => (value > 0 ? round(value) : undefined);
  return {
    input: round(tier.input_per_million_usd),
    output: round(tier.output_per_million_usd),
    cache_read: quoted(tier.cached_input_per_million_usd),
    cache_write: quoted(tier.cache_write_per_million_usd),
  };
}

// Infer publishes rounded decimals; this only clears float noise so an unchanged price isn't rewritten.
function round(value: number) {
  return Math.round(value * 1e6) / 1e6;
}
