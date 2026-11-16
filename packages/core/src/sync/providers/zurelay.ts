import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// Zurelay's public price feed (CC BY 4.0): every model it sells, with prices
// already in USD per 1M tokens for chat models.
const API_ENDPOINT = "https://zurelay.com/prices.json";

// Absence removes a model, so a feed with fewer chat models than this is
// refused instead of being read as a mass retirement.
const MIN_CHAT_MODELS = 20;

const ZurelayPrice = z
  .object({
    input_per_1m: z.number().nonnegative().optional(),
    output_per_1m: z.number().nonnegative().optional(),
    cached_input_per_1m: z.number().nonnegative().optional(),
  })
  .passthrough();

export const ZurelayModel = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.string().min(1),
    context_window: z.number().int().positive().nullable(),
    price: ZurelayPrice,
  })
  .passthrough();

export const ZurelayResponse = z
  .object({
    currency: z.literal("USD"),
    models: z.array(ZurelayModel),
  })
  .passthrough();

export type ZurelayModel = z.infer<typeof ZurelayModel>;

/**
 * Zurelay's feed lists exactly the models it sells, so it is authoritative for
 * prices and for retirement: a model that leaves the feed has been retired and
 * its file is removed. New models are not created (`skipCreates`) and open no
 * issues (`trackMissingModels: false`): Zurelay adds each one by PR with
 * reasoning controls, inputs and caching tested live, and the feed also lists
 * models the catalog leaves out on purpose (uncensored builds, and models that
 * failed those tests).
 * Image, video, speech, music, decision and embedding entries are ignored.
 */
export const zurelay = {
  id: "zurelay",
  name: "Zurelay",
  modelsDir: "providers/zurelay/models",
  skipCreates: true,
  trackMissingModels: false,
  sourceID(model) {
    return model.kind === "chat" ? model.id : undefined;
  },
  skippedNotice(ids) {
    return ids.map((id) => `Zurelay sells chat model ${id}, which has no file here; Zurelay adds models by hand after live tests.`);
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Zurelay price feed request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const models = ZurelayResponse.parse(raw).models;
    const chat = models.filter((model) => model.kind === "chat").length;
    if (chat < MIN_CHAT_MODELS) {
      throw new Error(`Zurelay price feed lists only ${chat} chat models; refusing to treat the rest as retired.`);
    }
    return models;
  },
  translateModel(model, context) {
    if (model.kind !== "chat") return undefined;
    const authored = context.authored(model.id);
    const existing = context.existing(model.id);
    if (authored === undefined || existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildZurelayModel(model, authored, existing),
    };
  },
} satisfies SyncProvider<ZurelayModel>;

// Prices are scaled by ratios below, which leaves float artifacts.
function round(value: number) {
  return Number(value.toFixed(6));
}

// A price derived from another one (a cache write, a long-prompt tier) moves
// with it, so the lab's multipliers are kept when Zurelay's price changes.
function scaled(value: number | undefined, from: number | undefined, to: number) {
  if (value === undefined) return undefined;
  if (from === undefined || from === 0) return value;
  return round((value * to) / from);
}

export function buildZurelayModel(model: ZurelayModel, authored: ExistingModel, existing: ExistingModel): SyncedModel {
  const { id: _authoredID, ...preserved } = authored;
  const before = authored.cost ?? existing.cost;
  const input = model.price.input_per_1m ?? before?.input ?? 0;
  const output = model.price.output_per_1m ?? before?.output ?? 0;
  // The feed leaves out a cached price that isn't below input, so such reads
  // bill at the input price. A cache price is only written to a file that
  // already declares one: each model's caching is tested live before it is added.
  const cacheRead =
    before?.cache_read === undefined ? undefined : round(model.price.cached_input_per_1m ?? input);

  const tiers = before?.tiers?.map((tier) => ({
    ...tier,
    input: scaled(tier.input, before.input, input) ?? tier.input,
    output: scaled(tier.output, before.output, output) ?? tier.output,
    cache_read: cacheRead === undefined ? tier.cache_read : scaled(tier.cache_read, before.cache_read, cacheRead),
    cache_write: scaled(tier.cache_write, before.input, input),
  }));

  const cost = {
    ...before,
    input,
    output,
    cache_read: cacheRead,
    cache_write: scaled(before?.cache_write, before?.input, input),
    ...(tiers === undefined ? {} : { tiers }),
  };

  // The feed's window can be the lab's rounded up (1048576 for a 1M window),
  // so it only ever lowers the limit, and output is capped to fit.
  const context = existing.limit?.context;
  let limit = authored.limit;
  if (context !== undefined && model.context_window !== null && model.context_window < context) {
    const outputLimit = existing.limit?.output;
    limit = {
      ...authored.limit,
      context: model.context_window,
      ...(outputLimit !== undefined && outputLimit > model.context_window ? { output: model.context_window } : {}),
    } as typeof authored.limit;
  }

  return {
    ...preserved,
    cost,
    ...(limit === undefined ? {} : { limit }),
  } as SyncedModel;
}
