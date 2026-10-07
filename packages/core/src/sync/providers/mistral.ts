import { z } from "zod";

import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_BASE = "https://api.mistral.ai/v1";
const EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// Mistral rejects an unsupported effort with the model's accepted values, but
// silently accepts the value on some models (zai-glm-5-2). "minimal" is the
// least likely value to be supported, so it gives the most useful rejection.
const PROBE_EFFORT = "minimal";
// /v1/models still serves these rows with `deprecation: null`, but Mistral's
// model docs list them as deprecated or retired:
// https://github.com/mistralai/platform-docs-public/tree/main/src/schema/models/models
const DEPRECATED_IDS = new Set([
  // Leanstral 1.5 (leanstral-1-5.ts): deprecated 2026-09-29, retired 2026-09-30.
  "labs-leanstral-1-5-1",
  // Z.ai GLM 5.2 (zai-glm-5-2.ts): deprecated 2026-09-29, retires 2026-10-31.
  "glm-5-2",
  "zai-glm-5-2",
  // Magistral Medium 1.2 (magistral-medium-1-2-25-09.ts): deprecated 2026-05-22, retired 2026-07-31.
  "magistral-medium-latest",
]);

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

export type MistralModel = z.infer<typeof MistralModel> & {
  /**
   * reasoning_effort values Mistral reports as accepted, from a rejected probe
   * request. [] means the API refuses reasoning_effort; undefined means the
   * probe could not determine the set.
   */
  reasoning_efforts?: string[];
};

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
    return parseMistralModels(raw);
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
  const response = await fetcher(`${API_BASE}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`Mistral models request failed: ${response.status} ${response.statusText}`);
  }
  const models = MistralResponse.parse(await response.json());

  // Aliases share their canonical model's controls, so probe each model once.
  const names = [...new Set(
    models.data
      .filter((model) => model.capabilities.completion_chat && model.capabilities.reasoning)
      .map((model) => model.name),
  )];
  const efforts: Record<string, string[] | null> = {};
  for (const name of names) {
    efforts[name] = await probeReasoningEfforts(name, key, fetcher) ?? null;
  }
  return { ...models, reasoning_efforts: efforts };
}

export function parseMistralModels(raw: unknown): MistralModel[] {
  const efforts = z.record(z.array(z.string()).nullable()).optional()
    .parse((raw as { reasoning_efforts?: unknown } | null)?.reasoning_efforts) ?? {};
  return MistralResponse.parse(raw).data.map((model) => ({
    ...model,
    reasoning_efforts: efforts[model.name] ?? undefined,
  }));
}

async function probeReasoningEfforts(model: string, key: string, fetcher: typeof fetch) {
  try {
    const response = await fetcher(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: PROBE_EFFORT,
        max_tokens: 1,
      }),
    });
    if (response.ok) return undefined;
    const body = await response.json() as { message?: unknown };
    return typeof body.message === "string" ? parseSupportedEfforts(body.message) : undefined;
  } catch (error) {
    console.warn(`Mistral reasoning_effort probe failed for ${model}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** Reads the accepted values from Mistral's reasoning_effort rejection. */
export function parseSupportedEfforts(message: string): string[] | undefined {
  if (/reasoning_effort is not enabled/i.test(message)) return [];
  const list = message.split(/supported values|must be one of/i)[1];
  if (list === undefined) return undefined;
  const values = new Set([...list.matchAll(/'([a-z]+)'/g)].map((match) => match[1]!));
  const known = EFFORT_VALUES.filter((value) => values.has(value));
  return known.length === values.size && known.length > 0 ? known : undefined;
}

function authoredEfforts(existing: ExistingModel): string[] {
  const values = (existing.reasoning_options ?? [])
    .flatMap((option) => option.type === "effort" ? option.values : [])
    .map((value) => String(value));
  const rank = (value: string) => {
    const index = EFFORT_VALUES.indexOf(value as typeof EFFORT_VALUES[number]);
    return index === -1 ? EFFORT_VALUES.length : index;
  };
  return [...new Set(values)].sort((a, b) => rank(a) - rank(b));
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
  if (model.capabilities.reasoning && model.reasoning_efforts !== undefined) {
    const authored = authoredEfforts(existing);
    if (authored.join() !== model.reasoning_efforts.join()) {
      throw new MissingReasoningOptionsError(
        model.id,
        `Mistral accepts reasoning_effort [${model.reasoning_efforts.join(", ")}] for ${model.name}, but the authored reasoning_options effort values are [${authored.join(", ")}]`,
      );
    }
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
    status: model.deprecation !== null || DEPRECATED_IDS.has(model.id)
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
