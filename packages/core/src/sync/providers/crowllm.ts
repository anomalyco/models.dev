import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const ENDPOINT_MODELS = "https://crowllm.com/v1/models";
const ENDPOINT_PRICING = "https://crowllm.com/api/pricing";

export const CrowLLMModelsResponse = z
  .object({
    data: z.array(z.object({ id: z.string() }).passthrough()),
  })
  .passthrough();

/**
 * One row per priced model. The gateway bills prompt tokens at `model_ratio`
 * and completions at `model_ratio * completion_ratio`, in units where the
 * listed USD-per-1M-token price is `ratio * 2` (the gateway's quota unit).
 */
export const CrowLLMPricingRow = z
  .object({
    model_name: z.string(),
    model_ratio: z.number(),
    completion_ratio: z.number(),
    cache_ratio: z.number().optional(),
    quota_type: z.number().optional(),
  })
  .passthrough();

export const CrowLLMPricingResponse = z
  .object({
    data: z.array(CrowLLMPricingRow),
  })
  .passthrough();

export type CrowLLMPricingRow = z.infer<typeof CrowLLMPricingRow>;

export type CrowLLMModel = {
  id: string;
  pricing?: CrowLLMPricingRow;
};

export const crowllm = {
  id: "crowllm",
  name: "CrowLLM",
  modelsDir: "providers/crowllm/models",
  // The gateway serves 170+ ids across many labs. This module only keeps the
  // prices of the ids that already have an authored file in sync; it never
  // creates new entries from the gateway's own catalog.
  skipCreates: true,
  trackMissingModels: false,
  // Remote-only removals are left to a human: the catalog rotates faster than
  // the authored set and a silent delete would drop a reviewed file.
  deleteMissing: false,
  async fetchModels() {
    const [modelsResponse, pricingResponse] = await Promise.all([
      fetch(ENDPOINT_MODELS),
      fetch(ENDPOINT_PRICING),
    ]);
    if (!modelsResponse.ok) {
      throw new Error(`CrowLLM models request failed: ${modelsResponse.status} ${modelsResponse.statusText}`);
    }
    if (!pricingResponse.ok) {
      throw new Error(`CrowLLM pricing request failed: ${pricingResponse.status} ${pricingResponse.statusText}`);
    }
    const ids = CrowLLMModelsResponse.parse(await modelsResponse.json()).data.map((model) => model.id);
    // Per-token rows only; the gateway also lists per-call rows (`quota_type: 1`)
    // that cannot be expressed as a per-token cost.
    const pricing = new Map(
      CrowLLMPricingResponse.parse(await pricingResponse.json())
        .data.filter((row) => (row.quota_type ?? 0) === 0)
        .map((row) => [row.model_name, row] as const),
    );
    return ids.map((id): CrowLLMModel => ({ id, pricing: pricing.get(id) }));
  },
  parseModels(raw) {
    return raw as CrowLLMModel[];
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    // No reviewed local file for this id: skip rather than seed an entry from
    // gateway-only data (no display name, no lab mapping).
    if (authored === undefined) return undefined;
    const cost = costFor(model.pricing);
    return {
      id: model.id,
      model: (cost ? { ...authored, cost: { ...authored.cost, ...cost } } : authored) as SyncedModel,
    };
  },
} satisfies SyncProvider<CrowLLMModel>;

function costFor(row: CrowLLMPricingRow | undefined): Partial<ExistingModel["cost"]> | undefined {
  if (row === undefined) return undefined;
  const input = usdPerMillion(row.model_ratio);
  const output = usdPerMillion(row.model_ratio * row.completion_ratio);
  const cache_read = row.cache_ratio === undefined ? undefined : usdPerMillion(row.model_ratio * row.cache_ratio);
  return {
    input,
    output,
    ...(cache_read === undefined ? {} : { cache_read }),
  };
}

function usdPerMillion(ratio: number): number {
  return Math.round(ratio * 2 * 1_000_000) / 1_000_000;
}
