import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// The v2 catalog has a product filter and an explicit serverless invocation ID.
// It is richer than /v1/models, but it is still not an availability probe:
// Together warns that a catalog listing can outlive its serverless route.
// https://docs.together.ai/reference/dmi/supported-models-list
// https://docs.together.ai/docs/deprecations
const API_ENDPOINT = "https://api.together.ai/v2/supported-models";

const Price = z.number().finite().nonnegative();

export const TogetherModel = z.object({
  products: z.array(z.string()),
  serverlessEndpoint: z.string().nullish(),
  pricing: z.object({
    input: Price.nullish(),
    output: Price.nullish(),
    cachedInput: Price.nullish(),
  }).passthrough().nullish(),
}).passthrough();

export const TogetherResponse = z.object({
  object: z.literal("list"),
  data: z.array(TogetherModel),
  next_cursor: z.string().nullish(),
}).passthrough();

export type TogetherModel = z.infer<typeof TogetherModel>;

export const togetherai = {
  id: "togetherai",
  name: "Together AI",
  modelsDir: "providers/togetherai/models",
  // No sync credential has been configured in CI yet. A manual, reviewed sync
  // is useful now; adding an automated run requires a key and a live dry run.
  schedule: false,
  skipCreates: true,
  trackMissingModels: false,
  // A route missing from this catalog may still be served (or redirected).
  // Never remove it without Together's explicit retirement evidence.
  deleteMissing: false,
  sourceID(model) {
    return model.serverlessEndpoint ?? undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [`Together lists ${ids.length} uncurated serverless IDs; review before adding: ${ids.map((id) => `\`${id}\``).join(", ")}`];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [`Together did not list ${paths.length} local IDs as serverless; retained for manual retirement review: ${paths.map((item) => `\`${item}\``).join(", ")}`];
  },
  async fetchModels() {
    const key = process.env.TOGETHER_API_KEY;
    if (!key) throw new Error("Together AI sync requires TOGETHER_API_KEY");
    return fetchTogetherModels(key);
  },
  parseModels(raw) {
    const models = z.array(TogetherModel).parse(raw)
      .filter((model) => model.products.includes("PRODUCT_SERVERLESS") && model.serverlessEndpoint);
    if (models.length === 0) throw new Error("Together returned no serverless endpoint IDs; refusing sync");
    const ids = new Set<string>();
    for (const model of models) {
      const id = model.serverlessEndpoint!;
      if (ids.has(id)) throw new Error(`Together returned duplicate serverless endpoint ID: ${id}`);
      ids.add(id);
    }
    return models;
  },
  translateModel(model, context) {
    const id = model.serverlessEndpoint;
    if (!id) return undefined;
    const authored = context.authored(id);
    if (!authored) return undefined;
    return { id, model: buildTogetherModel(model, authored) };
  },
} satisfies SyncProvider<TogetherModel>;

export async function fetchTogetherModels(key: string, fetcher: typeof fetch = fetch) {
  const models: TogetherModel[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  do {
    const url = new URL(API_ENDPOINT);
    url.searchParams.set("product", "PRODUCT_SERVERLESS");
    url.searchParams.set("limit", "200");
    if (after !== undefined) url.searchParams.set("after", after);
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) throw new Error(`Together models request failed: ${response.status} ${response.statusText}`);
    const page = TogetherResponse.parse(await response.json());
    models.push(...page.data);
    after = page.next_cursor || undefined;
    if (after !== undefined) {
      if (seen.has(after)) throw new Error("Together models pagination repeated a cursor");
      seen.add(after);
    }
  } while (after !== undefined);
  if (models.length === 0) throw new Error("Together returned an empty model catalog; refusing sync");
  return models;
}

export function buildTogetherModel(model: TogetherModel, authored: ExistingModel): SyncedModel {
  const pricing = model.pricing;
  // The v2 prices are USD per million serverless tokens. Omission is not zero:
  // retain the curated rate when a particular price is not in the response.
  // Context length describes underlying weights, not the served window; the
  // catalog does not supply an output cap, reasoning controls, or route state.
  return {
    ...authored,
    cost: {
      ...authored.cost,
      input: pricing?.input ?? authored.cost?.input,
      output: pricing?.output ?? authored.cost?.output,
      cache_read: pricing?.cachedInput ?? authored.cost?.cache_read,
    },
  } as SyncedModel;
}
