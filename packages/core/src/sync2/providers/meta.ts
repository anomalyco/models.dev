// Meta: the public docs at https://dev.meta.ai/docs (models.md, pricing-rate-limits.md
// and each family's page). Token prices and context windows are authoritative;
// everything else is hand-authored. New documented models are added by hand,
// and files the docs drop are kept. Image models are outside this source.
// See sync.md, "Meta Notes".

import { fetchMetaModels, parseMetaModels, type MetaModel } from "../../sync/providers/meta.js";
import { getPath } from "../fields.js";
import type { Observation, SyncModule } from "../types.js";

export const meta: SyncModule<unknown> = {
  id: "meta",
  name: "Meta",
  policy: {
    owns: [
      "limit.context",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.overrides",
      "cost.text.output.price",
      "cost.text.output.overrides",
    ],
    creates: "gap",
    removals: "keep",
  },
  manages: (_id, file) => getPath(file, "api.images") === undefined,
  fetch: () => fetchMetaModels(),
  observe: (raw) => parseMetaModels(raw).map(observe),
};

function observe(model: MetaModel): Observation {
  // Requests over a tier's size are billed at its rates in full.
  const tier = model.cost.tiers?.[0];
  const when = { context: { gt: tier?.tier.size ?? 0 } };
  return {
    id: model.id,
    base: [`meta/${model.id}`],
    limit: { context: model.context },
    cost: {
      text: {
        input: {
          price: model.cost.input,
          cache: { read: model.cost.cache_read },
          // Flat-priced families clear stale tiers.
          overrides: tier ? [{ when, price: tier.input, cache: { read: tier.cache_read } }] : null,
        },
        output: {
          price: model.cost.output,
          overrides: tier ? [{ when, price: tier.output }] : null,
        },
      },
    },
  };
}
