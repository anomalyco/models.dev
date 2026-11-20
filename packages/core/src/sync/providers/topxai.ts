import { z } from "zod";

import { CostV2, type CacheCostV2, type CostWhenV2 } from "../../schema-v2.js";
import type { SyncProvider } from "../index.js";

const Price = z.number().finite().nonnegative();
const Rates = z.object({
  input: Price,
  output: Price,
  cache_read: Price.optional(),
  cache_write: Price.optional(),
  cache_write_1h: Price.optional(),
});
const ChatPrice = Rates.extend({
  unit: z.literal("per_million_tokens"),
  long_context: Rates.extend({ min_input_tokens: z.number().int().positive() }).optional(),
});
const Pricing = z.object({
  success: z.literal(true),
  pricing_version: z.literal("route-usd-v1"),
  data: z.array(z.object({
    model_name: z.string().min(1),
    supported_endpoint_types: z.array(z.string()).nonempty(),
    auto_route: z.string().min(1),
    route_prices: z.record(z.unknown()),
    context_window: z.number().int().positive().optional(),
    max_output: z.number().int().positive().optional(),
  })).nonempty(),
});
type ChatModel = {
  id: string;
  price: z.infer<typeof ChatPrice>;
  context?: number;
  output?: number;
};

// Keep v2-only cache storage and explicit-cache pricing when updating the host's read/write rates.
function cachePrice(rates: z.infer<typeof Rates>, previous?: CacheCostV2) {
  const cache = { ...previous };
  if (rates.cache_read === undefined) delete cache.read;
  else cache.read = rates.cache_read;
  if (rates.cache_write_1h !== undefined) {
    cache.write = { ...(rates.cache_write !== undefined && { "5m": rates.cache_write }), "1h": rates.cache_write_1h };
  } else if (rates.cache_write !== undefined) cache.write = rates.cache_write;
  else delete cache.write;
  return Object.keys(cache).length > 0 ? cache : undefined;
}

function contextTier<T extends { when: CostWhenV2 }>(
  previous: T[] = [],
  tier: z.infer<typeof ChatPrice>["long_context"],
  prices: (rates: z.infer<typeof Rates>, prior?: T) => Omit<T, "when">,
) {
  // Replace the feed's standalone lower bounds. Preserve unrelated overrides and their ordering.
  const retained = [];
  let written = false;
  for (const prior of previous) {
    const bound = prior.when.context;
    if (Object.keys(prior.when).length !== 1 || !bound || Object.keys(bound).length !== 1 ||
      !("gt" in bound || "gte" in bound)) {
      retained.push(prior);
      continue;
    }
    if (tier && !written) {
      const minimum = tier.min_input_tokens;
      const same = ("gte" in bound && bound.gte === minimum) || ("gt" in bound && bound.gt === minimum - 1);
      retained.push({ ...prices(tier, prior), when: same ? prior.when : { context: { gte: minimum } } });
      written = true;
    }
  }
  if (tier && !written) retained.push({ ...prices(tier), when: { context: { gte: tier.min_input_tokens } } });
  return retained.length > 0 ? retained : undefined;
}

export const topxai = {
  id: "topxai",
  name: "TopxAI",
  modelsDir: "providers/topxai/models",
  skipCreates: true,
  // The unpaginated public feed has no total. A partial nonempty 200 must not delete local files.
  deleteMissing: false,
  sourceID: (row) => row.id,
  missingNotice: (paths) => paths.map((path) => "Verify possible TopxAI retirement: " + path),
  async fetchModels() {
    const res = await fetch("https://api.topxai.xyz/api/pricing");
    if (!res.ok) throw new Error("TopxAI pricing returned HTTP " + res.status);
    return res.json();
  },
  parseModels(raw) {
    const models: ChatModel[] = [];
    const ids = new Set<string>();
    for (const row of Pricing.parse(raw).data) {
      const endpoints = row.supported_endpoint_types;
      if (!endpoints.some((x) => ["openai", "anthropic", "openai-response"].includes(x))) continue;
      // Image generation is also exposed at the Chat Completions URL, billed per image.
      if (endpoints.includes("image-generation") || endpoints.includes("image-edit")) continue;
      const price = ChatPrice.parse(row.route_prices[row.auto_route]);
      const id = row.model_name;
      if (ids.has(id.toLowerCase())) throw new Error("Duplicate TopxAI chat model: " + id);
      ids.add(id.toLowerCase());
      models.push({ id, price, context: row.context_window, output: row.max_output });
    }
    if (!models.length) throw new Error("TopxAI pricing contains no chat models");
    return models;
  },
  translateModel(row, context) {
    const doc = context.v2?.(row.id);
    if (doc === undefined) return undefined; // New IDs need hand-verified API, reasoning and tool metadata.
    const cost = CostV2.parse(doc.cost ?? {});
    const input = cost.text?.input;
    const output = cost.text?.output;
    const tier = row.price.long_context;
    cost.text = {
      input: {
        ...input,
        price: row.price.input,
        cache: cachePrice(row.price, input?.cache),
        overrides: contextTier(input?.overrides, tier, (rates, prior) => ({
          price: rates.input, cache: cachePrice(rates, prior?.cache),
        })),
      },
      output: {
        ...output,
        price: row.price.output,
        overrides: contextTier(output?.overrides, tier, (rates, prior) => ({
          ...prior, price: rates.output,
        })),
      },
    };
    const resolvedLimit = context.existing(row.id)?.limit;
    const limit = { ...(doc.limit as Record<string, unknown> | undefined) };
    if (row.context !== undefined && row.context !== resolvedLimit?.context) limit.context = row.context;
    if (row.output !== undefined && row.output !== resolvedLimit?.output) limit.output = row.output;
    return { id: row.id, v2: { ...doc, ...(Object.keys(limit).length > 0 && { limit }), cost } };
  },
} satisfies SyncProvider<ChatModel>;
