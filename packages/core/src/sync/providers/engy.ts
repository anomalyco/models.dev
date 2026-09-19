import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.engy.ai/v1/models";

const Pricing = z
  .object({
    prompt: z.union([z.string(), z.number()]).optional(),
    completion: z.union([z.string(), z.number()]).optional(),
    input_cache_read: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export const EngyModel = z
  .object({
    id: z.string(),
    created: z.number().optional(),
    pricing: Pricing.optional(),
    context_length: z.number().optional(),
    max_model_len: z.number().optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
  })
  .passthrough();

export const EngyResponse = z.object({ data: z.array(EngyModel) }).passthrough();

export type EngyModel = z.infer<typeof EngyModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

export const engy = {
  id: "engy",
  name: "engy",
  modelsDir: "providers/engy/models",
  // The public list omits the input/output split, so a created file would ship
  // limit.output = 0. Unseen ids are reported for a human to author.
  skipCreates: true,
  trackMissingModels: true,
  // The list is unauthenticated and an empty `data` passes the schema; one
  // truncated 200 must not delete the hand-measured files.
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} engy models have no local catalog file and were not created because the public list omits the input/output split; author them after measuring the cap: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local engy models are missing from the public list and were retained; a human removes retired models: ${paths.map((path) => `\`${path}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`engy models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return EngyResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildEngyModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<EngyModel>;

export function buildEngyModel(model: EngyModel, existing: ExistingModel | undefined): SyncedModel {
  // An absent modality list means "not reported", not text-only.
  const input = model.input_modalities === undefined
    ? (existing?.modalities?.input ?? ["text"])
    : normalizeModalities(model.input_modalities);
  const output = model.output_modalities === undefined
    ? (existing?.modalities?.output ?? ["text"])
    : normalizeModalities(model.output_modalities);

  // A non-positive window is a bad row, not a smaller window.
  const apiContext = model.context_length ?? model.max_model_len ?? 0;
  const context = apiContext > 0 ? apiContext : existing?.limit?.context ?? 0;
  const limit = {
    context,
    // engy's context is max_input + max_output, so the split stays hand-authored.
    input: existing?.limit?.input,
    output: existing?.limit?.output ?? 0,
  };

  const cost =
    model.pricing?.prompt !== undefined && model.pricing?.completion !== undefined
      ? {
          ...existing?.cost,
          input: perMillion(model.pricing.prompt),
          output: perMillion(model.pricing.completion),
          cache_read:
            model.pricing.input_cache_read === undefined
              ? existing?.cost?.cache_read
              : perMillion(model.pricing.input_cache_read),
        }
      : existing?.cost;

  const values = {
    name: existing?.name ?? model.id,
    description: existing?.description,
    family: existing?.family,
    release_date: existing?.release_date,
    last_updated: existing?.last_updated,
    attachment: input.some((value) => value !== "text"),
    reasoning: existing?.reasoning,
    temperature: existing?.temperature,
    tool_call: existing?.tool_call,
    structured_output: existing?.structured_output,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
    provider: existing?.provider,
    experimental: existing?.experimental,
  } as Parameters<typeof factorBaseModel>[1];

  // An authored pointer wins: a resolver miss (absent or ambiguous slug) must
  // not de-factor a committed file.
  const baseModel = existing?.base_model ?? resolveModelMetadataBaseModel(model.id);
  return baseModel === undefined
    ? (values as SyncedModel)
    : factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
}

// Wire prices are per-token USD strings. Two of them pick up float error when
// multiplied to per-1M (0.00000068 * 1e6), so round to micro-dollars.
function perMillion(value: string | number): number {
  return Math.round(Number(value) * 1_000_000 * 1e6) / 1e6;
}

function normalizeModalities(values: string[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .filter((value): value is Modality => allowed.has(value as Modality));
  const unique = [...new Set(result)];
  if (unique.length === 0) return ["text"];
  // Wire order is arbitrary; sort so a rewrite for any other reason keeps catalogue order.
  const order: Modality[] = ["text", "image", "audio", "video", "pdf"];
  return unique.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
