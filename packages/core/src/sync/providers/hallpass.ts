import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://hallpassai.com/models.json";

export const HallPassModel = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: z.string().min(1),
    inputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
    cacheReadPerMillion: z.number().nonnegative().optional(),
    cacheWritePerMillion: z.number().nonnegative().optional(),
    contextLength: z.number().int().positive().nullable().optional(),
  })
  .passthrough();

export const HallPassResponse = z
  .object({
    models: z.array(HallPassModel),
  })
  .passthrough();

export type HallPassModel = z.infer<typeof HallPassModel>;

/**
 * HallPass's public `/models.json` lists more models than the catalog carries,
 * so this sync only updates the hand-authored TOMLs (`skipCreates`) and opens
 * no missing-model issues. A model temporarily absent from one response is not
 * treated as retired (`deleteMissing: false`).
 */
export const hallpass = {
  id: "hallpass",
  name: "HallPass",
  modelsDir: "providers/hallpass/models",
  skipCreates: true,
  trackMissingModels: false,
  deleteMissing: false,
  missingNotice(paths) {
    return paths.map(
      (file) => `HallPass /models.json no longer lists ${file}; review for manual deprecation or removal.`,
    );
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`HallPass models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return HallPassResponse.parse(raw).models;
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    const existing = context.existing(model.id);
    if (authored === undefined || existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildHallPassModel(model, authored, existing),
    };
  },
} satisfies SyncProvider<HallPassModel>;

export function buildHallPassModel(
  model: HallPassModel,
  authored: ExistingModel,
  existing: ExistingModel,
): SyncedModel {
  const { id: _authoredID, ...preserved } = authored;

  // Cache prices are kept only on files that already declare one, so each
  // model's cache behavior is verified before a cache price is added.
  const cost = {
    ...authored.cost,
    input: model.inputPerMillion,
    output: model.outputPerMillion,
    cache_read: authored.cost?.cache_read === undefined ? undefined : model.cacheReadPerMillion,
    cache_write: authored.cost?.cache_write === undefined ? undefined : model.cacheWritePerMillion,
  };

  // Only lower the context limit relative to the resolved base model.
  const context = existing.limit?.context;
  const limit =
    context !== undefined && model.contextLength != null && model.contextLength < context
      ? { ...authored.limit, context: model.contextLength }
      : authored.limit;

  return {
    ...preserved,
    cost,
    ...(limit === undefined ? {} : { limit }),
  } as SyncedModel;
}
