import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://api.unrestricted.sh/v1/models";

const UnrestrictedPricing = z
  .object({
    input: z.number().nonnegative(),
    cached_input: z.number().nonnegative().optional(),
    output: z.number().nonnegative(),
  })
  .passthrough();

export const UnrestrictedModel = z
  .object({
    id: z.string().min(1),
    object: z.literal("model"),
    pricing: UnrestrictedPricing,
  })
  .passthrough();

export const UnrestrictedResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(UnrestrictedModel).min(1),
  })
  .passthrough();

export type UnrestrictedModel = z.infer<typeof UnrestrictedModel>;

/**
 * Unrestricted's public `/v1/models` states its prices in USD per 1M tokens.
 * The sync only reprices the hand-authored TOMLs (`skipCreates`): limits,
 * reasoning controls and capabilities come from live probes recorded in each
 * file's header. The endpoint lists only models that are serving right now, so
 * a model missing from one response is reported, not removed
 * (`deleteMissing: false`).
 */
export const unrestricted = {
  id: "unrestricted",
  name: "Unrestricted",
  modelsDir: "providers/unrestricted/models",
  skipCreates: true,
  trackMissingModels: false,
  deleteMissing: false,
  missingNotice(paths) {
    return paths.map(
      (file) => `Unrestricted /v1/models no longer lists ${file}; review for manual deprecation or removal.`,
    );
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Unrestricted models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return UnrestrictedResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return {
      id: model.id,
      model: buildUnrestrictedModel(model, authored),
    };
  },
} satisfies SyncProvider<UnrestrictedModel>;

export function buildUnrestrictedModel(model: UnrestrictedModel, authored: ExistingModel): SyncedModel {
  const { id: _authoredID, ...preserved } = authored;

  // A cached-input price is kept only on files that already declare one: each
  // model's caching is confirmed live by hand before it is added.
  const cost = {
    ...authored.cost,
    input: model.pricing.input,
    output: model.pricing.output,
    cache_read: authored.cost?.cache_read === undefined ? undefined : model.pricing.cached_input,
  };

  return { ...preserved, cost } as SyncedModel;
}
