import { z } from "zod";

import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.mistral.ai/v1/models";

const MistralCapabilities = z.object({
  completion_chat: z.boolean(),
  function_calling: z.boolean(),
  reasoning: z.boolean(),
  vision: z.boolean(),
  audio: z.boolean(),
}).passthrough();

export const MistralModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  capabilities: MistralCapabilities,
  max_context_length: z.number().int().positive(),
  aliases: z.array(z.string()),
  deprecation: z.string().nullable(),
}).passthrough();

export const MistralResponse = z.object({
  object: z.literal("list"),
  data: z.array(MistralModel),
}).passthrough();

export type MistralModel = z.infer<typeof MistralModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

export const mistral = {
  id: "mistral",
  name: "Mistral",
  modelsDir: "providers/mistral/models",
  skipCreates: true,
  // /v1/models is scoped to the API key's workspace and drops retired models,
  // so absence is not a safe removal signal.
  deleteMissing: false,
  sourceID(model) {
    // Every alias is listed as its own row. Report each model once, under the
    // row whose ID is its canonical name, and ignore non-chat surfaces.
    return model.capabilities.completion_chat && model.id === model.name ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Mistral chat models were not created because /v1/models does not expose pricing, output limits, or reasoning controls.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Mistral models are absent from /v1/models and were retained for manual lifecycle review: ${paths.map((file) => `\`${file}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchMistralModels();
  },
  parseModels(raw) {
    return MistralResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (!model.capabilities.completion_chat) {
      // Embedding, OCR, moderation, transcription, and TTS rows carry no
      // chat metadata to sync; keep any authored entry exactly as it is.
      const authored = context.authored(model.id);
      return authored === undefined ? undefined : { id: model.id, model: authored as SyncedModel };
    }
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildMistralModel(model, existing),
    };
  },
} satisfies SyncProvider<MistralModel>;

export async function fetchMistralModels(
  key = process.env.MISTRAL_API_KEY,
  fetcher: typeof fetch = fetch,
) {
  if (key === undefined || key === "") throw new Error("Mistral sync requires MISTRAL_API_KEY");
  const response = await fetcher(API_ENDPOINT, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`Mistral models request failed: ${response.status} ${response.statusText}`);
  }
  return MistralResponse.parse(await response.json());
}

function inputModalities(model: MistralModel, existing: ExistingModel): Modality[] {
  const flags: Array<[Modality, boolean]> = [
    ["image", model.capabilities.vision],
    ["audio", model.capabilities.audio],
  ];
  const input = new Set<Modality>(existing.modalities?.input ?? ["text"]);
  for (const [modality, supported] of flags) {
    if (supported) input.add(modality);
    else input.delete(modality);
  }
  return [...input];
}

/**
 * Updates the fields /v1/models is authoritative for: context window, tool
 * calling, reasoning, image/audio input, and deprecation. Pricing, output
 * limits, reasoning controls, and other metadata stay hand-authored.
 */
export function buildMistralModel(model: MistralModel, existing: ExistingModel): SyncedModel {
  if (existing.limit?.context === undefined) {
    throw new Error(`Mistral model ${model.id} has incomplete local limits required for sync`);
  }
  if (model.capabilities.reasoning && existing.reasoning_options === undefined) {
    throw new MissingReasoningOptionsError(
      model.id,
      "Mistral reports reasoning support, but /v1/models exposes no reasoning controls; author reasoning_options from a live reasoning_effort check",
    );
  }

  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const input = inputModalities(model, existing);
  const limit = { ...existing.limit, context: model.max_context_length };
  const values = {
    ...current,
    attachment: input.some((modality) => modality !== "text"),
    reasoning: model.capabilities.reasoning,
    reasoning_options: model.capabilities.reasoning ? existing.reasoning_options : undefined,
    tool_call: model.capabilities.function_calling,
    status: model.deprecation !== null
      ? "deprecated"
      : existing.status === "deprecated" ? undefined : existing.status,
    limit,
    modalities: {
      input,
      output: existing.modalities?.output ?? ["text"],
    },
  } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}
