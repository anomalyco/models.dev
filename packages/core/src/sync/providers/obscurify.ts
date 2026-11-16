import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://obscurify.ai/v1/models";

const TOKENS_PER_PRICING_UNIT = 1_000_000;

const ObscurifyPricing = z
  .object({
    prompt: z.number().nonnegative(),
    completion: z.number().nonnegative(),
    input_cache_read: z.number().nonnegative().optional(),
    input_cache_write: z.number().nonnegative().optional(),
  })
  .passthrough();

export const ObscurifyModel = z
  .object({
    id: z.string().min(1),
    object: z.literal("model"),
    owned_by: z.string(),
    name: z.string().min(1),
    pricing: ObscurifyPricing,
    context_length: z.number().int().positive().nullable(),
    tools: z.boolean(),
    decisions: z.boolean(),
  })
  .passthrough();

export const ObscurifyResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(ObscurifyModel),
  })
  .passthrough();

export type ObscurifyModel = z.infer<typeof ObscurifyModel>;

/**
 * Obscurify.ai's public `/v1/models` lists far more models than the catalog
 * carries, so this sync only updates the hand-authored TOMLs (`skipCreates`)
 * and opens no missing-model issues. The endpoint lists only models that are
 * serving right now, so a model missing from one response is not treated as
 * retired (`deleteMissing: false`).
 */
export const obscurify = {
  id: "obscurify",
  name: "Obscurify.ai",
  modelsDir: "providers/obscurify/models",
  skipCreates: true,
  trackMissingModels: false,
  deleteMissing: false,
  sourceID(model) {
    return model.decisions ? undefined : model.id;
  },
  missingNotice(paths) {
    return paths.map(
      (file) => `Obscurify.ai /v1/models no longer lists ${file}; review for manual deprecation or removal.`,
    );
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Obscurify.ai models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return ObscurifyResponse.parse(raw).data;
  },
  translateModel(model, context) {
    // Decision models return a typed judgment, not chat text.
    if (model.decisions) return undefined;
    const authored = context.authored(model.id);
    const existing = context.existing(model.id);
    if (authored === undefined || existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildObscurifyModel(model, authored, existing),
    };
  },
} satisfies SyncProvider<ObscurifyModel>;

// Per-token prices; scaling introduces float artifacts, so round.
function perMillion(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Number((value * TOKENS_PER_PRICING_UNIT).toFixed(6));
}

export function buildObscurifyModel(
  model: ObscurifyModel,
  authored: ExistingModel,
  existing: ExistingModel,
): SyncedModel {
  const { id: _authoredID, ...preserved } = authored;

  // Cache prices are kept only on files that already declare one: a listed
  // cache price is not proof that a route caches, so each model's cache is
  // checked live by hand before it is added.
  const cost = {
    ...authored.cost,
    input: perMillion(model.pricing.prompt) ?? 0,
    output: perMillion(model.pricing.completion) ?? 0,
    cache_read: authored.cost?.cache_read === undefined ? undefined : perMillion(model.pricing.input_cache_read),
    cache_write: authored.cost?.cache_write === undefined ? undefined : perMillion(model.pricing.input_cache_write),
  };

  // `context_length` can be the lab's figure rounded up (1048576 for a 1M
  // window), so it only ever lowers the limit.
  const context = existing.limit?.context;
  const limit =
    context !== undefined && model.context_length !== null && model.context_length < context
      ? { ...authored.limit, context: model.context_length }
      : authored.limit;

  // Tool support is what the endpoint passes through, so a route without it
  // overrides the lab. Names are not synced: the endpoint prefixes the lab
  // name ("Z.ai: GLM 5.3"), and `owned_by` is the ID's namespace.
  const toolCall = model.tools === existing.tool_call ? authored.tool_call : model.tools;

  return {
    ...preserved,
    cost,
    ...(limit === undefined ? {} : { limit }),
    ...(toolCall === undefined ? {} : { tool_call: toolCall }),
  } as SyncedModel;
}
