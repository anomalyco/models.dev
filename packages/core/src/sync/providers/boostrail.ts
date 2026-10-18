import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://www.boostrail.com/models.json";

const Pricing = z
  .object({
    input: z.number(),
    output: z.number(),
    cache_read: z.number().optional(),
  })
  .passthrough();

export const BoostRailModel = z
  .object({
    id: z.string().min(1),
    lab: z.string().optional(),
    pricing: Pricing,
  })
  .passthrough();

export const BoostRailResponse = z
  .object({
    currency: z.literal("USD"),
    unit: z.literal("per_1m_tokens"),
    data: z.array(BoostRailModel),
  })
  .passthrough();

export type BoostRailModel = z.infer<typeof BoostRailModel>;

/**
 * BoostRail publishes its text-model price list as a static file built from
 * the same data as https://www.boostrail.com/models/ (USD per 1M tokens).
 * The file carries prices only, so this sync updates existing TOMLs
 * (`skipCreates`) and treats it as authoritative for `cost` alone. Everything
 * else — `base_model` inheritance and `reasoning_options` — stays
 * hand-authored. Cache writes are billed at the input price.
 */
export const boostrail = {
  id: "boostrail",
  name: "BoostRail",
  modelsDir: "providers/boostrail/models",
  skipCreates: true,
  trackMissingModels: false,
  deleteMissing: false,
  missingNotice(paths) {
    return paths.map(
      (file) => `BoostRail price list no longer lists ${file}; review for manual deprecation or removal.`,
    );
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`BoostRail request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return BoostRailResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return {
      id: model.id,
      model: buildBoostRailModel(model, authored),
    };
  },
} satisfies SyncProvider<BoostRailModel>;

export function buildBoostRailModel(model: BoostRailModel, authored: ExistingModel): SyncedModel {
  const { id: _authoredID, ...preserved } = authored;
  const { input, output, cache_read } = model.pricing;
  return {
    ...preserved,
    cost: {
      ...authored.cost,
      input,
      output,
      cache_read,
      cache_write: input,
    },
  } as SyncedModel;
}
