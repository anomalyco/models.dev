import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://api.naga.ac/v1/models";

const Price = z
  .object({
    meter: z.string(),
    unit: z.string(),
    price: z.string(),
    conditions: z.record(z.unknown()).optional(),
  })
  .passthrough();

const Operation = z
  .object({
    operation: z.string(),
    endpoints: z.array(z.string()),
  })
  .passthrough();

export const NagaAIModel = z
  .object({
    id: z.string().min(1),
    operations: z.array(Operation),
    pricing: z.array(Price),
    deprecates_at: z.number().nullable().optional(),
  })
  .passthrough();

export const NagaAIResponse = z
  .object({
    data: z.array(NagaAIModel),
  })
  .passthrough();

export type NagaAIModel = z.infer<typeof NagaAIModel>;

/**
 * NagaAI's public catalog (no key needed) lists chat, image, video, speech,
 * transcription, embedding and moderation models; only models whose `chat`
 * operation is served on Chat Completions (and so on Responses and Messages) are authored here. The sync updates
 * existing TOMLs only (`skipCreates`) and treats the catalog as authoritative
 * for token prices and deprecation. `base_model`, reasoning controls, limits
 * and modalities stay hand-authored.
 */
export const nagaai = {
  id: "nagaai",
  name: "NagaAI",
  modelsDir: "providers/nagaai/models",
  skipCreates: true,
  trackMissingModels: false,
  deleteMissing: false,
  sourceID(model) {
    return isChat(model) ? model.id : undefined;
  },
  missingNotice(paths) {
    return paths.map(
      (file) => `NagaAI catalog no longer lists ${file}; review for manual deprecation or removal.`,
    );
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`NagaAI request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return NagaAIResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (!isChat(model)) return undefined;
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return {
      id: model.id,
      model: buildNagaAIModel(model, authored),
    };
  },
} satisfies SyncProvider<NagaAIModel>;

function isChat(model: NagaAIModel) {
  return model.operations.some(
    (operation) => operation.operation === "chat" && operation.endpoints.includes("chat.completions"),
  );
}

/** One row per meter, as a decimal string of USD per `unit`; rows with `conditions` price a subset of requests. */
function price(model: NagaAIModel, meter: string) {
  const row = model.pricing.find(
    (entry) =>
      entry.meter === meter &&
      entry.unit === "token" &&
      Object.keys(entry.conditions ?? {}).length === 0,
  );
  if (row === undefined) return undefined;
  const value = Number(row.price);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1_000_000_000_000) / 1_000_000;
}

export function buildNagaAIModel(model: NagaAIModel, authored: ExistingModel): SyncedModel {
  const { id: _authoredID, ...preserved } = authored;
  const input = price(model, "input_token") ?? price(model, "input_text_token");
  const output = price(model, "output_token");
  const cost =
    input !== undefined || output !== undefined
      ? {
          ...authored.cost,
          input: input ?? 0,
          output: output ?? 0,
          cache_read: price(model, "cached_input_token") || undefined,
          input_audio: price(model, "input_audio_token") || undefined,
        }
      : authored.cost;

  // deprecates_at is the announced shutdown time; the model stays callable until then.
  // The catalog is authoritative for it, so a withdrawn date clears the status too.
  const scheduled = typeof model.deprecates_at === "number";
  const status = scheduled
    ? ("deprecated" as const)
    : authored.status === "deprecated"
      ? undefined
      : authored.status;

  return {
    ...preserved,
    cost,
    status,
  } as SyncedModel;
}
