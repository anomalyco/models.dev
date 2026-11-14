// NEAR AI Cloud: https://cloud-api.near.ai/v1/models (public).
// Prices are authoritative. `context_length` is the serving cap only on models
// NEAR AI hosts itself (owned_by = "nearai"); relayed routes report an upstream
// figure, so it is ignored there and only ever lowers the file's value. The
// catalog's capability fields are wrong in both directions, so none are used.
// See sync.md, "NEAR AI Cloud Notes".

import { fetchNearAIModels, NearAIResponse, type NearAIModel } from "../../sync/providers/nearai.js";
import type { Observation, SyncModule } from "../types.js";
import { labCandidates, perMillion, round } from "../units.js";

// Priced per input token only; the cost schema can't describe it.
const IGNORED = new Set(["openai/privacy-filter"]);

const LAB_NAMESPACES: Record<string, string> = {
  qwen: "alibaba",
  "x-ai": "xai",
  "z-ai": "zhipuai",
  "zai-org": "zhipuai",
  "deepseek-ai": "deepseek",
};

export const nearai: SyncModule<unknown> = {
  id: "nearai",
  name: "NEAR AI Cloud",
  policy: {
    owns: [
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.output.price",
      "cost.image.output",
      { path: "limit.context", merge: "min" },
    ],
    creates: "auto",
    removals: "delete",
  },
  fetch: () => fetchNearAIModels(),
  observe(raw) {
    return NearAIResponse.parse(raw).data.filter((model) => !IGNORED.has(model.id)).map(observe);
  },
};

function observe(model: NearAIModel): Observation {
  const image = imagePrice(model);
  const cacheRead = perMillion(model.pricing.input_cache_read);
  return {
    id: model.id,
    base: labCandidates(model.id, LAB_NAMESPACES),
    // An image model is billed per image (pricing.image); its per-token prices aren't what a request costs.
    cost: image !== undefined
      ? { image: { output: { unit: "image", price: image } } }
      : {
        text: {
          input: { price: round(model.pricing.input), ...(cacheRead === undefined ? {} : { cache: { read: cacheRead } }) },
          output: { price: round(model.pricing.output) },
        },
      },
    ...(model.owned_by === "nearai" ? { limit: { context: model.context_length } } : {}),
  };
}

function imagePrice(model: NearAIModel) {
  if (!model.output_modalities.includes("image")) return undefined;
  const price = Number(model.pricing.image);
  return Number.isFinite(price) && price > 0 ? round(price) : undefined;
}
