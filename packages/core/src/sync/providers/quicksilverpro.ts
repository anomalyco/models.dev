import { z } from "zod";

import type { ExistingModel, SyncedModel, SyncProvider } from "../index.js";

const API_ENDPOINT = "https://quicksilverpro.io/pricing.json";

export const QuickSilverProModel = z.object({
  id: z.string().min(1),
  lifecycle: z.enum(["active", "deprecated"]),
  pricing_unit: z.string(),
  capabilities: z.array(z.string()),
  context_tokens: z.number().int().positive().nullable(),
  max_output_tokens: z.number().int().positive().nullable(),
  input_per_1m: z.number().finite().nonnegative().optional(),
  output_per_1m: z.number().finite().nonnegative().optional(),
  cached_input_per_1m: z.number().finite().nonnegative().optional(),
  cache_read_per_1m: z.number().finite().nonnegative().optional(),
  cache_write_1h_per_1m: z.number().finite().nonnegative().optional(),
  cache_write_per_1m: z.number().finite().nonnegative().optional(),
}).passthrough().superRefine((model, ctx) => {
  if (isTextModel(model) && (model.input_per_1m === undefined || model.output_per_1m === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Missing token prices for ${model.id}` });
  }
});

export const QuickSilverProResponse = z.object({
  currency: z.literal("USD"),
  models: z.array(QuickSilverProModel).nonempty("empty catalog"),
}).passthrough().superRefine(({ models }, ctx) => {
  if (new Set(models.map((model) => model.id.toLowerCase())).size !== models.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate model IDs" });
  }
});

export type QuickSilverProModel = z.infer<typeof QuickSilverProModel>;

function isTextModel(model: { pricing_unit: string; capabilities: string[] }) {
  return model.pricing_unit === "tokens" && model.capabilities.includes("text_output");
}

// Follow Obscurify's update-only pattern: the public feed has prices and limits,
// but no per-route reasoning controls or exact MIME formats for safe creates.
// Missing rows are retained for manual review; a partial public response must
// not retire a route. Explicit lifecycle=deprecated is authoritative.
export const quicksilverpro = {
  id: "quicksilverpro",
  name: "QuickSilver Pro",
  modelsDir: "providers/quicksilverpro/models",
  skipCreates: true,
  trackMissingModels: false,
  deleteMissing: false,
  sourceID(model) {
    return isTextModel(model) ? model.id : undefined;
  },
  missingNotice(paths) {
    return paths.map((file) => `QuickSilver Pro pricing.json no longer lists ${file}; review for manual removal.`);
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `QuickSilver Pro models need hand-authored lab mappings, reasoning controls and MIME formats: ${ids.join(", ")}`,
    ];
  },
  fetchModels() {
    return fetchQuickSilverProModels();
  },
  parseModels(raw) {
    return QuickSilverProResponse.parse(raw).models;
  },
  translateModel(model, context) {
    if (!isTextModel(model)) return undefined;
    const authored = context.authored(model.id);
    const existing = context.existing(model.id);
    if (authored === undefined || existing === undefined) return undefined;
    // Preserve exact MIME lists: the runner's v1 view loses format information.
    const current = context.v2?.(model.id) as {
      modalities?: unknown;
      cost?: { text?: { input?: { cache?: { write?: number | Record<string, number> } } } };
    } | undefined;
    const modalities = current?.modalities;
    const authoredWrite = current?.cost?.text?.input?.cache?.write;
    // Patch each published TTL independently. Missing prices are not removals,
    // and a changed 5m rate must never rescale an authored 1h rate.
    const write = typeof authoredWrite === "object" || model.cache_write_1h_per_1m !== undefined
      ? {
          ...(typeof authoredWrite === "object" ? authoredWrite :
            authoredWrite === undefined ? {} : { "5m": authoredWrite }),
          ...(model.cache_write_per_1m === undefined ? {} : { "5m": model.cache_write_per_1m }),
          ...(model.cache_write_1h_per_1m === undefined ? {} : { "1h": model.cache_write_1h_per_1m }),
        }
      : model.cache_write_per_1m ?? authoredWrite;
    return {
      id: model.id,
      model: buildQuickSilverProModel(model, authored, existing),
      v2Set: {
        ...(modalities === undefined ? {} : { modalities }),
        ...(write === undefined ? {} : { "cost.text.input.cache.write": write }),
      },
    };
  },
} satisfies SyncProvider<QuickSilverProModel>;

export async function fetchQuickSilverProModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`QuickSilver Pro catalog request failed: ${response.status} ${response.statusText}`);
  }
  return QuickSilverProResponse.parse(await response.json());
}

export function buildQuickSilverProModel(
  model: QuickSilverProModel,
  authored: ExistingModel,
  existing: ExistingModel,
): SyncedModel {
  if (existing.limit?.context === undefined || existing.limit.output === undefined) {
    throw new Error(`QuickSilver Pro model ${model.id} needs authored or inherited limits before sync`);
  }
  const { id: _id, ...preserved } = authored;
  const limit = { ...authored.limit };
  // Gateway catalog values may be rounded up. Only lower a resolved cap;
  // never reintroduce GPT-5.6 Sol's unverified 131072 over the lab's 128000.
  // Previously sourced host overrides (e.g. Kimi) survive until lowered.
  const context = Math.min(existing.limit.context, model.context_tokens ?? Infinity);
  if (context < existing.limit.context) limit.context = context;
  const output = Math.min(existing.limit.output, model.max_output_tokens ?? Infinity, context);
  if (output < existing.limit.output) limit.output = output;
  if (existing.limit?.input !== undefined && existing.limit.input > context) limit.input = context;

  return {
    ...preserved,
    ...(model.lifecycle === "deprecated" ? { status: "deprecated" } : {}),
    cost: {
      ...authored.cost,
      input: model.input_per_1m!,
      output: model.output_per_1m!,
      cache_read: model.cache_read_per_1m ?? model.cached_input_per_1m ?? authored.cost?.cache_read,
      cache_write: model.cache_write_per_1m ?? authored.cost?.cache_write,
    },
    ...(Object.keys(limit).length === 0 ? {} : { limit }),
  } as SyncedModel;
}
