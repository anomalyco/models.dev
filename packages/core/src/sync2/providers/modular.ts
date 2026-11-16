// Modular: https://console.modular.com/api/v1/docs/models (public).
// Only prices are authoritative; the context window is rounded display text
// ("1M") and modalities are incomplete. New models carry measured limits and
// reasoning controls, so they are added by hand. A model that leaves the
// public set (unshared, unpriced or gone) is retired. See sync.md, "Modular Notes".

import { fetchModularModels, isPublic, ModularResponse } from "../../sync/providers/modular.js";
import type { SyncModule } from "../types.js";
import { perMillion } from "../units.js";

export const modular: SyncModule<unknown> = {
  id: "modular",
  name: "Modular",
  policy: {
    owns: ["cost.text.input.price", "cost.text.input.cache.read", "cost.text.output.price"],
    creates: "never",
    removals: "delete",
  },
  fetch: () => fetchModularModels(),
  observe(raw) {
    const models = ModularResponse.parse(raw).models.filter(isPublic);
    if (models.length === 0) throw new Error("Modular returned no public models");
    return models.map((model) => {
      const cacheRead = perMillion(model.pricing.cached_input);
      return {
        id: model.gateway_model_id,
        cost: {
          text: {
            // A missing or zero cache price isn't a new free cache, so it is left out (the file keeps its value).
            input: { price: perMillion(model.pricing.input)!, ...(cacheRead ? { cache: { read: cacheRead } } : {}) },
            output: { price: perMillion(model.pricing.output)! },
          },
        },
      };
    });
  },
};
