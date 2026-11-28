import { z } from "zod";

import { ReasoningOption as CatalogReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://usemodellane.com/v1/public/models";

// Prices are integer pico-USD (1e-12 USD) per token: per 1M tokens that is value / 1e6.
const PICO_USD_PER_TOKEN_TO_USD_PER_MILLION = 1_000_000;

const PicoUsd = z.string().regex(/^\d+$/);

export const ModellaneModel = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    contextWindowTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    inputModalities: z.array(z.string()).min(1),
    features: z.array(z.string()).default([]),
    // The levels this model accepts on reasoning_effort / reasoning.effort /
    // output_config.effort; "none" turns reasoning off where listed. Other
    // values are rejected with HTTP 400 unsupported_reasoning_effort.
    reasoningEfforts: z.array(z.string()).optional(),
    pricing: z
      .object({
        inputPicoUsdPerToken: PicoUsd,
        cachedInputPicoUsdPerToken: PicoUsd.optional(),
        outputPicoUsdPerToken: PicoUsd,
      })
      .passthrough(),
  })
  .passthrough();

export const ModellaneResponse = z
  .object({
    models: z.array(ModellaneModel).min(1),
  })
  .passthrough();

export type ModellaneModel = z.infer<typeof ModellaneModel>;

type V1Modality = NonNullable<ExistingModel["modalities"]>["input"][number];
const V1_MODALITIES = new Set<string>(["text", "audio", "image", "video", "pdf"]);

/**
 * Modellane's public catalog lists every model it serves, so it owns the model
 * list, context and output limits, input modalities, reasoning effort levels and
 * token prices. IDs don't
 * name a lab entry, so new models are not created automatically (`skipCreates`):
 * each opens a missing-model issue for its `base_model`, reasoning field and
 * `[api.*]` tables to be authored. Files absent from the catalog are removed.
 */
export const modellane = {
  id: "modellane",
  name: "Modellane",
  modelsDir: "providers/modellane/models",
  skipCreates: true,
  sourceID(model) {
    return model.id;
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`Modellane models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const models = ModellaneResponse.parse(raw).models;
    // A malformed inventory fails before any file is touched.
    const seen = new Set<string>();
    for (const model of models) {
      if (seen.has(model.id)) throw new Error(`Modellane catalog lists ${model.id} twice`);
      seen.add(model.id);
    }
    return models;
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    const existing = context.existing(model.id);
    if (authored === undefined || existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildModellaneModel(model, authored, existing),
    };
  },
} satisfies SyncProvider<ModellaneModel>;

export function picoUsdToPerMillion(value: string): number {
  return Number((Number(value) / PICO_USD_PER_TOKEN_TO_USD_PER_MILLION).toFixed(6));
}

export function modellaneInput(model: ModellaneModel): V1Modality[] {
  const input = model.inputModalities.filter((value): value is V1Modality => V1_MODALITIES.has(value));
  if (!input.includes("text")) throw new Error(`Modellane lists no text input for ${model.id}`);
  return input;
}

type EffortValue = NonNullable<Extract<z.infer<typeof CatalogReasoningOption>, { type: "effort" }>["values"][number]>;
type ReasoningOptions = NonNullable<ExistingModel["reasoning_options"]>;

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];

function isEffort(value: string): value is EffortValue {
  return CatalogReasoningOption.safeParse({ type: "effort", values: [value] }).success;
}

/**
 * Modellane has one reasoning control, an effort level, with "none" as the off
 * switch where a model allows it; there is no separate toggle or token budget.
 * A catalog without the field, or with a level this schema doesn't know yet,
 * keeps the file's authored controls instead of publishing a partial set.
 */
export function modellaneReasoningOptions(
  model: ModellaneModel,
  authored: ExistingModel,
): ReasoningOptions | undefined {
  const efforts = model.reasoningEfforts;
  if (authored.reasoning !== true || efforts === undefined || !efforts.every(isEffort)) {
    return authored.reasoning_options;
  }
  if (efforts.length === 0) return [];
  const values = [...new Set(efforts)].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return [{ type: "effort", values }] as ReasoningOptions;
}

function sameKinds(a: readonly string[] | undefined, b: readonly string[]) {
  return a !== undefined && a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

export function buildModellaneModel(
  model: ModellaneModel,
  authored: ExistingModel,
  existing: ExistingModel,
): SyncedModel {
  const { id: _authoredID, ...preserved } = authored;

  const cached = model.pricing.cachedInputPicoUsdPerToken;
  const cost = {
    ...authored.cost,
    input: picoUsdToPerMillion(model.pricing.inputPicoUsdPerToken),
    output: picoUsdToPerMillion(model.pricing.outputPicoUsdPerToken),
    cache_read: cached === undefined ? undefined : picoUsdToPerMillion(cached),
  };

  // A value the file inherits from its base_model stays inherited while the
  // catalog agrees with it; otherwise the catalog's value is written.
  const limit = { ...authored.limit } as Record<string, number | undefined>;
  for (const [field, value] of [["context", model.contextWindowTokens], ["output", model.maxOutputTokens]] as const) {
    if (authored.limit?.[field] === undefined && existing.limit?.[field] === value) continue;
    limit[field] = value;
  }

  // Only the input list is synced; the catalog has no output modalities.
  const input = modellaneInput(model);
  const modalities = authored.modalities === undefined && sameKinds(existing.modalities?.input, input)
    ? undefined
    : { input, output: authored.modalities?.output ?? existing.modalities?.output ?? ["text"] };

  const reasoningOptions = modellaneReasoningOptions(model, authored);

  return {
    ...preserved,
    ...(reasoningOptions === undefined ? {} : { reasoning_options: reasoningOptions }),
    cost,
    ...(Object.keys(limit).length === 0 ? {} : { limit }),
    ...(modalities === undefined ? {} : { modalities }),
  } as SyncedModel;
}
