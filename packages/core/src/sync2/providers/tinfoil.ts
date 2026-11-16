// Tinfoil: https://inference.tinfoil.sh/v1/models (public).
// Authoritative: token prices, the context window, whether a model reasons and
// its reasoning_effort values (supported_efforts). The catalog has no output
// limits or modalities, so new models are added by hand. Models with no token
// price, context window or catalog API (tools, TTS, /redact) aren't reported.

import { z } from "zod";

import { fetchJSON } from "../http.js";
import type { Observation, SyncModule } from "../types.js";
import { reasoningControls } from "../units.js";

// Models served only on other routes (e.g. pii-filter on /redact) have no catalog API to list.
const MODEL_APIS = new Set(["/v1/chat/completions", "/v1/responses", "/v1/embeddings"]);

const TinfoilModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  owned_by: z.literal("tinfoil"),
  name: z.string().min(1),
  created: z.number().int().nonnegative(),
  context_window: z.number().int().positive().optional(),
  pricing: z.object({
    inputTokenPricePer1M: z.number().nonnegative(),
    outputTokenPricePer1M: z.number().nonnegative(),
    cachedInputTokenPricePer1M: z.number().nonnegative().optional(),
    requestPrice: z.number().nonnegative().optional(),
  }).passthrough(),
  reasoning: z.boolean(),
  supported_efforts: z.array(z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])).optional(),
  tool_calling: z.boolean(),
  multimodal: z.boolean(),
  type: z.string().min(1),
  endpoints: z.array(z.string()),
}).passthrough();
type TinfoilModel = z.infer<typeof TinfoilModel>;

const TinfoilResponse = z.object({ object: z.literal("list"), data: z.array(TinfoilModel) }).passthrough();

export const tinfoil: SyncModule<unknown> = {
  id: "tinfoil",
  name: "Tinfoil",
  policy: {
    owns: [
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.output.price",
      "limit.context",
      "capabilities.reasoning.supported",
      "capabilities.reasoning.effort",
    ],
    creates: "gap",
    removals: "delete",
  },
  fetch: () => fetchJSON("https://inference.tinfoil.sh/v1/models", { source: "Tinfoil models" }),
  observe: (raw) => TinfoilResponse.parse(raw).data.map(observe),
};

function observe(model: TinfoilModel): Observation {
  const efforts = model.supported_efforts ?? [];
  return {
    id: model.id,
    ...(representable(model) ? {} : { updateOnly: true }),
    cost: {
      text: {
        input: { price: model.pricing.inputTokenPricePer1M, cache: { read: model.pricing.cachedInputTokenPricePer1M ?? null } },
        output: { price: model.pricing.outputTokenPricePer1M },
      },
    },
    limit: { context: model.context_window },
    capabilities: {
      // Without supported_efforts the file's controls stay as they are.
      reasoning: model.reasoning && efforts.length > 0 ? { supported: true, effort: reasoningControls({ effort: efforts }).effort! } : { supported: model.reasoning },
    },
  };
}

function representable(model: TinfoilModel) {
  return model.context_window !== undefined
    && ["chat", "embedding", "safety"].includes(model.type)
    && model.endpoints.some((endpoint) => MODEL_APIS.has(endpoint))
    && (model.pricing.inputTokenPricePer1M > 0 || model.pricing.outputTokenPricePer1M > 0);
}
