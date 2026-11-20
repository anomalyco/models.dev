import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// Token Factory's public catalog, no key. Each model lists one or more flavors (serving tiers), each with its own model ID
// and prices.
const API_ENDPOINT = process.env.NEBIUS_MODELS_URL ?? "https://tokenfactory.nebius.com/api/public/models_info";

const Price = z.number().nonnegative();

export const NebiusFlavor = z.object({
  model_id: z.string().min(1),
  deprecated: z.boolean().nullable().optional(),
  external_provider: z.boolean().nullable().optional(),
  input_price_per_million_tokens: Price,
  input_cached_price_per_million_tokens: Price.nullable().optional(),
  output_price_per_million_tokens: Price,
}).passthrough();

export const NebiusModel = z.object({
  name: z.string(),
  flavors: z.array(NebiusFlavor),
}).passthrough();

export type NebiusFlavor = z.infer<typeof NebiusFlavor>;

// Token prices only. Limits, controls and capabilities stay hand-written: several files carry a measured or documented
// context below the catalog's max_model_len.
export function buildNebiusModel(flavor: NebiusFlavor, authored: ExistingModel): SyncedModel {
  const cached = flavor.input_cached_price_per_million_tokens;
  const cost = {
    ...authored.cost,
    input: flavor.input_price_per_million_tokens,
    output: flavor.output_price_per_million_tokens,
    ...(cached === null || cached === undefined ? {} : { cache_read: cached }),
  };
  return { ...authored, cost } as SyncedModel;
}

export const nebius = {
  id: "nebius",
  name: "Nebius Token Factory",
  modelsDir: "providers/nebius/models",
  // New models need hand-written controls and limits, so they're reported instead of created.
  skipCreates: true,
  deleteMissing: false,
  sourceID(flavor) {
    return flavor.deprecated === true || flavor.external_provider === true ? undefined : flavor.model_id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [`${ids.length} Token Factory models have no local file: ${ids.map((id) => `\`${id}\``).join(", ")}`];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [`${paths.length} local Nebius models are missing from the public catalog and were retained: ${paths.map((item) => `\`${item}\``).join(", ")}`];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) throw new Error(`Nebius models request failed: ${response.status} ${response.statusText}`);
    const type = response.headers.get("content-type") ?? "";
    // Token Factory sits behind Cloudflare; a challenge page must fail the sync, not parse as an empty catalog.
    if (!type.includes("json")) throw new Error(`Nebius models request returned ${type || "no content type"}, not JSON`);
    return response.json();
  },
  parseModels(raw) {
    const flavors = z.array(NebiusModel).parse(raw).flatMap((model) => model.flavors);
    if (flavors.length === 0) throw new Error("Nebius returned no models; refusing to sync an empty catalog");
    return flavors;
  },
  translateModel(flavor, context) {
    if (flavor.deprecated === true || flavor.external_provider === true) return undefined;
    const authored = context.authored(flavor.model_id);
    if (authored === undefined) return undefined;
    return { id: flavor.model_id, model: buildNebiusModel(flavor, authored) };
  },
} satisfies SyncProvider<NebiusFlavor>;
