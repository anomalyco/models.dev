import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { modelMetadata } from "./openrouter.js";

const API_ENDPOINT = "https://straitly.ai/api/catalog";
const MIN_EXPECTED_MODELS = 20;

const StraitlyPrice = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative().nullable().optional(),
    cacheWrite: z.number().nonnegative().nullable().optional(),
  })
  .passthrough();

export const StraitlyModel = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    context: z.number().int().positive().nullable().optional(),
    price: StraitlyPrice,
  })
  .passthrough();

export const StraitlyResponse = z
  .object({
    models: z.array(StraitlyModel),
  })
  .passthrough();

export type StraitlyModel = z.infer<typeof StraitlyModel>;

/**
 * Straitly's public `/api/catalog` lists 150+ models, while this provider carries
 * a curated frontier set whose reasoning controls, protocols, and cache behavior
 * are live-probed by hand. This sync updates only existing TOMLs (`skipCreates`)
 * without opening missing-model issues (`trackMissingModels: false`) and retains
 * files missing from a single response (`deleteMissing: false`).
 */
export const straitly = {
  id: "straitly",
  name: "Straitly",
  modelsDir: "providers/straitly/models",
  skipCreates: true,
  trackMissingModels: false,
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  missingNotice(paths) {
    return paths.map(
      (file) => `Straitly /api/catalog no longer lists ${file}; review for manual deprecation or removal.`,
    );
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Straitly catalog request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const models = StraitlyResponse.parse(raw).models;
    if (models.length < MIN_EXPECTED_MODELS) {
      throw new Error(`Straitly catalog returned ${models.length} models (expected at least ${MIN_EXPECTED_MODELS})`);
    }
    return models;
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return {
      id: model.id,
      model: buildStraitlyModel(model, authored),
    };
  },
} satisfies SyncProvider<StraitlyModel>;

function finitePrice(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/**
 * Updates published USD/MTok prices (including `cache_read` and `cache_write`
 * only when the authored file already declares them) and `limit.context` when
 * the file already pins a context override or Straitly differs from the lab's
 * `base_model`. Authored reasoning controls, cache settings, protocols, and
 * compatibility flags stay untouched.
 */
export function buildStraitlyModel(model: StraitlyModel, authored: ExistingModel): SyncedModel {
  const { id: _authoredID, ...preserved } = authored;

  const cacheRead =
    authored.cost?.cache_read === undefined ? undefined : (finitePrice(model.price.cacheRead) ?? authored.cost.cache_read);
  const cacheWrite =
    authored.cost?.cache_write === undefined ? undefined : (finitePrice(model.price.cacheWrite) ?? authored.cost.cache_write);

  const cost = {
    ...authored.cost,
    input: model.price.input,
    output: model.price.output,
    ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
  };

  const labContext =
    authored.base_model === undefined
      ? undefined
      : (modelMetadata(authored.base_model).limit as { context?: number } | undefined)?.context;
  const contextValue = typeof model.context === "number" ? model.context : undefined;
  const limit =
    contextValue !== undefined && (authored.limit?.context !== undefined || (labContext !== undefined && labContext !== contextValue))
      ? { ...authored.limit, context: contextValue }
      : authored.limit;

  return {
    ...preserved,
    cost,
    ...(limit === undefined ? {} : { limit }),
  } as SyncedModel;
}
