import { z } from "zod";

import { AuthoredModelV2, type CostWhenV2 } from "../../schema-v2.js";
import type { SyncProvider } from "../index.js";
import { modelMetadata } from "./openrouter.js";

const API_ENDPOINT = "https://api.anonrouter.ai/v1/models";
const PUBLIC_ENDPOINT = "https://control.anonrouter.ai/v1/catalog/models";
// Intentionally unlisted pending upstream lifecycle confirmation.
const EXCLUDED_MODEL_IDS = new Set(["tencent/hy4-uncensored"]);
const Price = z.number().finite().nonnegative().nullable();
const ModelID = z.string().min(1).refine(
  (id) => /^[A-Za-z0-9~][A-Za-z0-9_.:~/-]*$/.test(id)
    && id.split("/").every((part) => part !== "" && part !== ".." && part !== "."),
  "AnonRouter model ID must be a relative catalog path",
);

const PriceTier = z.object({
  above_input_tokens: z.number().int().nonnegative(),
  input_usd_per_million_tokens: Price,
  output_usd_per_million_tokens: Price,
  cache_read_usd_per_million_tokens: Price.optional(),
  cache_write_usd_per_million_tokens: Price.optional(),
  applies_to: z.literal("whole_request"),
  in_effect: z.boolean(),
}).passthrough();

const Pricing = z.object({
  input_usd_per_million_tokens: Price,
  output_usd_per_million_tokens: Price,
  unit_usd: Price,
  long_context_tiers: z.array(PriceTier).optional(),
}).passthrough().refine((pricing) => {
  const active = (pricing.long_context_tiers ?? []).filter((tier) => tier.in_effect);
  return new Set(active.map((tier) => tier.above_input_tokens)).size === active.length;
}, "AnonRouter returned duplicate active context thresholds");

export const AnonRouterModel = z.object({
  id: ModelID,
  canonical_slug: ModelID.optional(),
  model_type: z.enum(["text", "embedding", "image", "tts"]),
  context_window: z.number().int().positive(),
  max_output_tokens: z.number().int().nonnegative().nullable(),
  pricing: Pricing,
  provider_routes: z.array(z.object({
    callable: z.boolean(),
    privacy_class: z.string(),
    context_window: z.number().int().positive(),
    max_output_tokens: z.number().int().nonnegative().nullable(),
    pricing: Pricing,
  }).passthrough()).optional(),
}).passthrough();

export const AnonRouterResponse = z.object({
  object: z.literal("list"),
  data: z.array(AnonRouterModel).min(1, "AnonRouter returned an empty catalog"),
}).passthrough();

const PublicModel = z.object({ id: ModelID, callable: z.boolean() }).passthrough();
export const AnonRouterPublicResponse = z.object({
  models: z.array(PublicModel).min(1, "AnonRouter returned an empty public catalog"),
  routers: z.array(z.object({ id: ModelID }).passthrough()),
  stale: z.boolean().optional(),
}).passthrough();

type AuthenticatedModel = z.infer<typeof AnonRouterModel>;
export type AnonRouterSourceModel =
  | { id: string; source: "authenticated"; row: AuthenticatedModel }
  | { id: string; source: "public"; stale: boolean };

const ModelFile = AuthoredModelV2.omit({ id: true }).extend({ schema: z.literal(2) });

export const anonrouter = {
  id: "anonrouter",
  name: "AnonRouter",
  modelsDir: "providers/anonrouter/models",
  skipCreates: true,
  trackMissingModels: true,
  deleteMissing: false,
  fetchModels: fetchAnonRouterModels,
  parseModels: parseAnonRouterModels,
  sourceID(model) {
    return model.id;
  },
  missingModelID(model) {
    return model.id;
  },
  sourceNotices(models) {
    if (models[0]?.source !== "public") return [];
    return [
      "AnonRouter public inventory is discovery-only. Set ANONROUTER_API_KEY to update default-route prices and limits; public preferred routes can differ from API defaults.",
      ...(models[0].stale ? ["AnonRouter's public inventory reports stale source data; existing models are retained."] : []),
    ];
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `AnonRouter IDs awaiting authored model metadata and API verification: ${ids.join(", ")}`,
    ];
  },
  missingNotice(paths) {
    return paths.length === 0 ? [] : [
      `AnonRouter entries absent from this inventory are retained for lifecycle review: ${paths.join(", ")}`,
    ];
  },
  translateModel(model, context) {
    const current = context.v2?.(model.id);
    if (current === undefined) return undefined;
    if (model.source === "authenticated" && model.id.startsWith("~")) {
      const target = model.row.canonical_slug;
      const reviewedTarget = target === undefined ? undefined : context.v2?.(target);
      const metadata = ModelFile.parse(current).metadata?.anonrouter;
      const priorTarget = metadata != null && typeof metadata === "object" && !Array.isArray(metadata) ? metadata.alias_target : undefined;
      if ((priorTarget !== undefined && priorTarget !== target)
        || reviewedTarget?.base_model === undefined || reviewedTarget.base_model !== current.base_model) {
        return {
          id: model.id,
          v2: current,
          notices: [`AnonRouter alias ${model.id} now targets ${target ?? "an unreported model"}; retaining its reviewed definition until the new target is authored.`],
        };
      }
    }
    return {
      id: model.id,
      v2: model.source === "public" ? current : updateAnonRouterModel(model.row, current),
    };
  },
} satisfies SyncProvider<AnonRouterSourceModel>;

export async function fetchAnonRouterModels(fetcher: typeof fetch = fetch, apiKey = process.env.ANONROUTER_API_KEY) {
  const authenticated = Boolean(apiKey?.trim());
  const response = await fetcher(authenticated ? API_ENDPOINT : PUBLIC_ENDPOINT, {
    signal: AbortSignal.timeout(30_000),
    ...(authenticated ? { headers: { Authorization: `Bearer ${apiKey!.trim()}` } } : {}),
  });
  if (!response.ok) throw new Error(`AnonRouter catalog request failed: ${response.status} ${response.statusText}`);
  return { source: authenticated ? "authenticated" : "public", payload: await response.json() };
}

export function parseAnonRouterModels(raw: unknown): AnonRouterSourceModel[] {
  const envelope = z.object({ source: z.enum(["authenticated", "public"]), payload: z.unknown() }).parse(raw);
  let rows: AnonRouterSourceModel[];
  if (envelope.source === "authenticated") {
    rows = AnonRouterResponse.parse(envelope.payload).data.map((row) => ({ id: row.id, source: "authenticated", row }));
  } else {
    const catalog = AnonRouterPublicResponse.parse(envelope.payload);
    assertUniqueIDs([...catalog.models, ...catalog.routers]);
    rows = [...catalog.models.filter((model) => model.callable), ...catalog.routers]
      .map((row) => ({ id: row.id, source: "public", stale: catalog.stale === true }));
  }
  assertUniqueIDs(rows);
  rows = rows.filter((model) => !EXCLUDED_MODEL_IDS.has(model.id));
  if (rows.length === 0) throw new Error("AnonRouter returned no callable models");
  return rows;
}

function assertUniqueIDs(rows: { id: string }[]) {
  const ids = rows.map((row) => row.id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new Error("AnonRouter returned duplicate model IDs");
}

/** Preserve reviewed APIs and capabilities; the authenticated feed owns prices and serving limits. */
export function updateAnonRouterModel(model: AuthenticatedModel, current: Record<string, unknown>): Record<string, unknown> {
  const next = ModelFile.parse(current);
  // Plaintext APIs exclude E2EE routes before choosing the default provider.
  const route = model.id.startsWith("anonrouter/") || model.provider_routes === undefined
    ? model : model.provider_routes.find((route) => route.callable && route.privacy_class !== "e2ee");
  if (route === undefined) return current;
  if (model.model_type === "text" || model.model_type === "embedding") {
    const base = typeof current.base_model === "string" ? modelMetadata(current.base_model) : undefined;
    const baseLimit = base?.limit as { context?: number; output?: number } | undefined;
    const limits = { ...next.limit };
    const updates = {
      context: route.context_window,
      ...(model.model_type === "text" && route.max_output_tokens != null && route.max_output_tokens > 0
        ? { output: Math.min(route.max_output_tokens, route.context_window) } : {}),
    };
    for (const key of ["context", "output"] as const) {
      const value = updates[key];
      if (value === undefined) continue;
      if (baseLimit?.[key] === value) delete limits[key];
      else limits[key] = value;
    }
    if (Object.keys(limits).length > 0) next.limit = limits;
    else delete next.limit;
    for (const direction of ["input", "output"] as const) {
      if (direction === "output" && model.model_type === "embedding") continue;
      const price = direction === "input" ? route.pricing.input_usd_per_million_tokens : route.pricing.output_usd_per_million_tokens;
      if (price === null) {
        if (next.cost?.text !== undefined) delete next.cost.text[direction];
        continue;
      }
      next.cost ??= {};
      next.cost.text ??= {};
      next.cost.text[direction] = { ...next.cost.text[direction], price };
      const prior = next.cost.text[direction].overrides ?? [];
      const preserved = prior.filter((tier) => !isContextTier(tier.when));
      const tiers = (route.pricing.long_context_tiers ?? [])
        .filter((tier) => tier.in_effect)
        .sort((a, b) => a.above_input_tokens - b.above_input_tokens)
        .flatMap((tier) => {
          const tierPrice = direction === "input" ? tier.input_usd_per_million_tokens : tier.output_usd_per_million_tokens;
          if (tierPrice === null) return [];
          const cache = direction === "input" ? {
            ...(tier.cache_read_usd_per_million_tokens != null ? { read: tier.cache_read_usd_per_million_tokens } : {}),
            ...(tier.cache_write_usd_per_million_tokens != null ? { write: tier.cache_write_usd_per_million_tokens } : {}),
          } : {};
          return [{ when: { context: { gt: tier.above_input_tokens } }, price: tierPrice,
            ...(Object.keys(cache).length > 0 ? { cache } : {}) }];
        });
      if (preserved.length + tiers.length > 0) next.cost.text[direction].overrides = [...preserved, ...tiers];
      else delete next.cost.text[direction].overrides;
    }
    if (next.cost?.text !== undefined && Object.keys(next.cost.text).length === 0) delete next.cost.text;
  } else {
    const kind = model.model_type === "image" ? "image" : "text";
    const direction = model.model_type === "image" ? "output" : "input";
    if (route.pricing.unit_usd === null) {
      if (next.cost?.[kind] !== undefined) {
        delete next.cost[kind]![direction];
        if (Object.keys(next.cost[kind]!).length === 0) delete next.cost[kind];
      }
    } else {
      next.cost ??= {};
      next.cost[kind] ??= {};
      next.cost[kind]![direction] = {
        ...next.cost[kind]![direction],
        unit: model.model_type === "image" ? "image" : "character",
        // Models.dev prices both tokens and characters per million; images are per image.
        price: route.pricing.unit_usd,
      };
    }
  }
  if (next.cost !== undefined && Object.keys(next.cost).length === 0) delete next.cost;
  return next;
}

function isContextTier(when: CostWhenV2) {
  return when != null && Object.keys(when).length === 1 && when.context !== undefined;
}
