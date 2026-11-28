import { z } from "zod";

import type { SyncProvider, SyncedModel } from "../index.js";

const Price = z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number).pipe(z.number().finite().nonnegative());
const RedRouterModel = z.object({
  id: z.string().min(1),
  context_tokens: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  pricing: z.object({
    source: z.literal("retail"),
    input_usd_per_mtok: Price,
    cached_input_usd_per_mtok: Price,
    output_usd_per_mtok: Price,
  }).nullable(),
});
const Catalog = z.object({ models: z.array(RedRouterModel) });

export type RedRouterModel = z.infer<typeof RedRouterModel>;

export const redrouter = {
  id: "redrouter",
  name: "RedRouter",
  modelsDir: "providers/redrouter/models",
  skipCreates: true,
  trackMissingModels: false,
  // Availability is not a retirement signal; canonical IDs and release dates are hand-authored.
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  async fetchModels() {
    const response = await fetch("https://redrouter.org/api/catalog", {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`RedRouter catalog request failed: ${response.status}`);
    return response.json();
  },
  parseModels(raw) {
    return Catalog.parse(raw).models;
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined || model.pricing === null) return undefined;
    const { id: _id, ...preserved } = authored;
    return {
      id: model.id,
      model: {
        ...preserved,
        limit: { ...authored.limit, context: model.context_tokens, output: model.max_output_tokens },
        cost: {
          ...authored.cost,
          input: model.pricing.input_usd_per_mtok,
          output: model.pricing.output_usd_per_mtok,
          ...(authored.cost?.cache_read === undefined ? {} : { cache_read: model.pricing.cached_input_usd_per_mtok }),
        },
      } as SyncedModel,
    };
  },
} satisfies SyncProvider<RedRouterModel>;
