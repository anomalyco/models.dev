import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.bf16.ai/v1/models";

const NonNegativePrice = z.union([z.number(), z.string()]).transform((raw, ctx) => {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    ctx.addIssue({ code: "custom", message: `invalid non-negative price: ${String(raw)}` });
    return z.NEVER;
  }
  return parsed;
});

const BF16PricingUsdPer1M = z.object({
  input: NonNegativePrice,
  output: NonNegativePrice,
  cached_input: NonNegativePrice.optional(),
}).passthrough();

const BF16Meta = z.object({
  family: z.string().optional(),
  modification_method: z.string().optional(),
  status: z.string().optional(),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  supports_reasoning: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_vision: z.boolean().optional(),
  supports_json_schema: z.boolean().optional(),
  pricing_usd_per_1m: BF16PricingUsdPer1M.optional(),
}).passthrough();

export const BF16Model = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  supports_reasoning: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_json_schema: z.boolean().optional(),
  bf16: BF16Meta.optional(),
}).passthrough();

export const BF16Response = z.object({
  object: z.literal("list"),
  data: z.array(BF16Model),
}).passthrough().superRefine((value, ctx) => {
  if (value.data.length === 0) {
    ctx.addIssue({ code: "custom", message: "bf16.ai returned an empty catalog" });
  }
  const seen = new Set<string>();
  for (const item of value.data) {
    if (seen.has(item.id)) {
      ctx.addIssue({ code: "custom", message: `bf16.ai returned duplicate model IDs: ${item.id}` });
    }
    seen.add(item.id);
  }
});

export type BF16Model = z.infer<typeof BF16Model>;

export const bf16 = {
  id: "bf16",
  name: "bf16.ai",
  modelsDir: "providers/bf16/models",
  skipCreates: true,
  sourceID(model) {
    return isRepresentableModel(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} bf16.ai models were not created automatically because base_model and per-surface reasoning effort controls require manual authoring.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchBF16Models();
  },
  parseModels(raw) {
    return BF16Response.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildBF16Model(model, existing),
    };
  },
} satisfies SyncProvider<BF16Model>;

export async function fetchBF16Models(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`bf16.ai models request failed: ${response.status} ${response.statusText}`);
  }
  return BF16Response.parse(await response.json());
}

function isRepresentableModel(model: BF16Model): boolean {
  const meta = model.bf16;
  if (meta?.family === "router" || meta?.modification_method === "smart_router") return false;
  if (meta?.status !== undefined && meta.status !== "active") return false;
  const pricing = meta?.pricing_usd_per_1m;
  const contextWindow = meta?.context_window ?? model.context_window;
  if (pricing === undefined || contextWindow === undefined) return false;
  return pricing.input > 0 || pricing.output > 0;
}

export function buildBF16Model(
  model: BF16Model,
  existing: ExistingModel,
): SyncedModel {
  const meta = model.bf16;
  const pricing = meta?.pricing_usd_per_1m;
  if (pricing === undefined || existing.cost === undefined) {
    throw new Error(`bf16.ai model ${model.id} has incomplete pricing required for sync`);
  }

  const contextWindow = meta?.context_window ?? model.context_window ?? existing.limit?.context;
  const maxOutput = meta?.max_output_tokens ?? model.max_output_tokens ?? existing.limit?.output;
  if (contextWindow === undefined || maxOutput === undefined) {
    throw new Error(`bf16.ai model ${model.id} has incomplete limits required for sync`);
  }

  const reasoning = meta?.supports_reasoning ?? model.supports_reasoning ?? existing.reasoning ?? false;
  if (reasoning && existing.reasoning_options === undefined) {
    throw new Error(`bf16.ai model ${model.id} requires hand-authored reasoning_options; the catalog omits effort lists`);
  }

  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const cost = {
    ...existing.cost,
    input: pricing.input,
    output: pricing.output,
    ...(pricing.cached_input !== undefined ? { cache_read: pricing.cached_input } : {}),
  };
  const limit = {
    ...existing.limit,
    context: contextWindow,
    output: maxOutput,
  };
  const values = {
    ...current,
    reasoning,
    reasoning_options: reasoning ? existing.reasoning_options : undefined,
    tool_call: meta?.supports_tools ?? model.supports_tools ?? existing.tool_call,
    structured_output: meta?.supports_json_schema ?? model.supports_json_schema ?? existing.structured_output,
    cost,
    limit,
  } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}
