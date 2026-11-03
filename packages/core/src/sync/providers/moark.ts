import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel } from "./openrouter.js";

const ENDPOINT = "https://moark.ai/api/pay/services?type=serverless&status=1&size=1000";

export const MoarkTag = z.object({
  slug: z.string().min(1),
}).passthrough();

export const MoarkOperationSummary = z.object({
  min_input_million_tokens_price: z.number().finite().nonnegative().optional(),
  min_output_million_tokens_price: z.number().finite().nonnegative().optional(),
}).passthrough();

export const MoarkService = z.object({
  ident: z.string().min(1),
  name: z.string().min(1),
  status: z.number().int(),
  tags: z.array(MoarkTag).optional(),
  operation_summary: MoarkOperationSummary.optional(),
}).passthrough();

export type MoarkService = z.infer<typeof MoarkService>;

export function parseMoarkServices(raw: unknown): MoarkService[] {
  const rows = z.object({ total: z.number().int().nonnegative(), items: z.array(MoarkService).nonempty() }).parse(raw).items;
  if (new Set(rows.map((service) => service.ident)).size !== rows.length) {
    throw new Error("Moark returned duplicate model IDs");
  }
  return rows;
}

export async function fetchMoarkServices(fetcher: typeof fetch = fetch) {
  const response = await fetcher(ENDPOINT);
  if (!response.ok) throw new Error(`Moark catalog request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

// Token-priced chat services carry at least one of these capability tags on the
// public catalog. Everything else (image, video, speech, embeddings, OCR,
// moderation, decision models) is not representable as a chat entry here.
export function isChatService(service: MoarkService) {
  const tags = new Set((service.tags ?? []).map((tag) => tag.slug));
  const summary = service.operation_summary;
  return (tags.has("text-generation") || tags.has("code-generation") || tags.has("function_calling"))
    && summary?.min_input_million_tokens_price !== undefined
    && summary.min_output_million_tokens_price !== undefined;
}

export function buildMoarkModel(service: MoarkService, existing: ExistingModel, authored = existing): SyncedModel {
  if (existing.reasoning === true && existing.reasoning_options === undefined) {
    throw new MissingReasoningOptionsError(service.ident, "Moark's chat API exposes no reasoning controls; author reasoning_options before syncing this route");
  }
  const input = service.operation_summary?.min_input_million_tokens_price;
  const output = service.operation_summary?.min_output_million_tokens_price;
  if (input === undefined || output === undefined) {
    throw new Error(`Moark ${service.ident} is missing the input/output prices required for sync`);
  }
  // Only token prices are API-authoritative here. Preserve curated capabilities,
  // reasoning controls, limits, interleaving, dates, and request metadata.
  const cost = { ...existing.cost, input, output };
  const { base_model: baseModel, base_model_omit: omit, ...current } = authored;
  const values = { ...current, cost } as SyncedFullModel;
  return baseModel === undefined ? values : factorBaseModel(baseModel, values, undefined, omit);
}

export const moark = {
  id: "moark",
  name: "Moark",
  modelsDir: "providers/moark/models",
  skipCreates: true,
  trackMissingModels: true,
  // The overseas catalog is a subset of the platform's full catalog. Never delete on absence.
  deleteMissing: false,
  fetchModels: fetchMoarkServices,
  parseModels: parseMoarkServices,
  sourceID(service) {
    return isChatService(service) ? service.ident : undefined;
  },
  translateModel(service, context) {
    if (!isChatService(service)) return undefined;
    const existing = context.existing(service.ident);
    const authored = context.authored(service.ident);
    if (existing === undefined || authored === undefined) return undefined;
    return { id: service.ident, model: buildMoarkModel(service, existing, authored) };
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `New Moark chat models require manual catalog review (missing-model issue fixer): ${ids.join(", ")}`,
    ];
  },
} satisfies SyncProvider<MoarkService>;
