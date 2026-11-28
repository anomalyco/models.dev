import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://api.openuncensored.com/v1/models";

const TOKENS_PER_PRICING_UNIT = 1_000_000;

// Prices are USD per token, sent as decimal strings ("0.000001").
const PerTokenPrice = z.union([z.string(), z.number()]).pipe(z.coerce.number().nonnegative());

const OpenUncensoredPricing = z
  .object({
    prompt: PerTokenPrice,
    completion: PerTokenPrice,
  })
  .passthrough();

export const OpenUncensoredModel = z
  .object({
    id: z.string().min(1),
    object: z.literal("model"),
    owned_by: z.string(),
    pricing: OpenUncensoredPricing,
    context_length: z.number().int().positive().nullable(),
    available: z.boolean().optional(),
  })
  .passthrough();

// An empty list would read as every model retired, so it fails the sync instead.
export const OpenUncensoredResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(OpenUncensoredModel).min(1),
  })
  .passthrough();

export type OpenUncensoredModel = z.infer<typeof OpenUncensoredModel>;

/**
 * OpenUncensored's public `/v1/models` lists every chat model the API serves,
 * including ones temporarily unavailable (`available: false`), so a model
 * missing from it is retired and its file is removed. The list has ids,
 * per-token prices and context lengths only, so new models are not created
 * (`skipCreates`): each one opens a missing-model issue for its modalities,
 * output limit, reasoning controls and lab file. Names, output limits,
 * modalities and reasoning controls stay hand-authored.
 */
export const openuncensored = {
  id: "openuncensored",
  name: "OpenUncensored",
  modelsDir: "providers/openuncensored/models",
  skipCreates: true,
  sourceID(model) {
    return model.id;
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`OpenUncensored models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return OpenUncensoredResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    const existing = context.existing(model.id);
    if (authored === undefined || existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildOpenUncensoredModel(model, authored, existing),
    };
  },
} satisfies SyncProvider<OpenUncensoredModel>;

// Per-token prices; scaling introduces float artifacts, so round.
function perMillion(value: number): number {
  return Number((value * TOKENS_PER_PRICING_UNIT).toFixed(6));
}

export function buildOpenUncensoredModel(
  model: OpenUncensoredModel,
  authored: ExistingModel,
  existing: ExistingModel,
): SyncedModel {
  const { id: _authoredID, ...preserved } = authored;

  // Cache prices are not listed, so any the file declares are kept as authored.
  const cost = {
    ...authored.cost,
    input: perMillion(model.pricing.prompt),
    output: perMillion(model.pricing.completion),
  };

  // `context_length` can be the lab's window rounded up (1048576 for 1M), so it
  // only ever lowers the limit. Input and output are carved out of the context,
  // so they come down with it.
  const context = existing.limit?.context;
  const lowered = context !== undefined && model.context_length !== null && model.context_length < context;
  const limit = lowered ? lowerLimit(authored.limit, existing.limit, model.context_length as number) : authored.limit;

  return {
    ...preserved,
    cost,
    ...(limit === undefined ? {} : { limit }),
  } as SyncedModel;
}

function lowerLimit(
  authored: ExistingModel["limit"],
  resolved: ExistingModel["limit"],
  context: number,
): NonNullable<ExistingModel["limit"]> {
  const limit: Record<string, number | undefined> = { ...authored, context };
  for (const field of ["input", "output"] as const) {
    const value = resolved?.[field];
    if (value !== undefined && value > context) limit[field] = context;
  }
  return limit as NonNullable<ExistingModel["limit"]>;
}
