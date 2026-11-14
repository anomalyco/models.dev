import { z } from "zod";

import type { SyncProvider } from "../index.js";

// AICraft's public price list doubles as its model index: it names every model
// the gateway serves and answers without a key, so sync needs no credential.
const API_ENDPOINT = "https://aicraftapi.net/api/pricing";

// The host serves well over a hundred models and the catalog mirrors them. A
// list shorter than this is a truncated response, not a catalog of removals, so
// it fails the sync before any hand-authored file is deleted — nothing here
// would recreate one.
const MIN_MODELS = 100;

export const AICraftModel = z.object({
  model_name: z.string().min(1),
  supported_endpoint_types: z.array(z.string()).optional(),
}).passthrough();

const AICraftResponse = z.object({
  success: z.boolean().optional(),
  data: z.array(AICraftModel),
}).passthrough();

export type AICraftModel = z.infer<typeof AICraftModel>;

export function parseAICraftModels(raw: unknown) {
  const { data } = AICraftResponse.parse(raw);
  if (data.length < MIN_MODELS) {
    throw new Error(
      `AICraft price list returned ${data.length} models, below the ${MIN_MODELS} this catalog expects; refusing to sync`,
    );
  }

  return data;
}

export async function fetchAICraftModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`AICraft price list request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export const aicraft = {
  id: "aicraft",
  name: "AICraft",
  modelsDir: "providers/aicraft/models",
  // Prices, capabilities and API protocols are hand-authored; the source only
  // says which IDs are served. The list is a superset — it also carries the
  // video and image routes and the older aliases the catalog does not list — so
  // a source model with no local file is skipped silently rather than created
  // or turned into an issue. An ID the source drops is a file to remove: that
  // is how the delisted and renamed entries were caught by hand.
  skipCreates: true,
  deleteMissing: true,
  async fetchModels() {
    return fetchAICraftModels();
  },
  parseModels: parseAICraftModels,
  translateModel(model, context) {
    const v2 = context.v2?.(model.model_name);
    if (v2 === undefined) return undefined;
    // Rewrite each file from its own body: sync owns the ID set, not the data.
    return { id: model.model_name, v2 };
  },
} satisfies SyncProvider<AICraftModel>;
