import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

// Tinker's docs publish the tables on https://tinker-docs.thinkingmachines.ai/tinker/models/ as JSON:
// models.json lists the base and PEFT models (prices per 1M prefill, cached prefill, sample and train tokens),
// serverless.json the serverless sampling deployments (per 1M input, cached input and output tokens).
// The Tinker API's own model list needs an API key and lists IDs only.
export const MODELS_ENDPOINT = "https://tinker-docs.thinkingmachines.ai/tinker/models.json";
export const SERVERLESS_ENDPOINT = "https://tinker-docs.thinkingmachines.ai/tinker/serverless.json";

const Price = z.string().regex(/^\$\d+(\.\d+)?$/);
const Context = z.string().regex(/^\d+[KM]$/);

const TrainingRow = z.object({
  name: z.string().min(1),
  tinker_id: z.string().min(1),
  context: Context,
  prefill: Price,
  cached_prefill: Price,
  sample: Price,
}).passthrough();

const ServerlessRow = z.object({
  name: z.string().min(1),
  tinker_id: z.string().min(1),
  context: Context,
  input: Price,
  cached_input: Price,
  output: Price,
}).passthrough();

export interface TinkerModel {
  id: string;
  /** Tokens a request can hold when sampling. */
  context: number;
  input: number;
  cacheRead: number;
  output: number;
}

export const thinkingmachines = {
  id: "thinkingmachines",
  name: "Thinking Machines",
  modelsDir: "providers/thinkingmachines/models",
  // Reasoning controls, image support and the lab model each Tinker ID serves are hand-authored from the
  // compatible-API docs; the tables only say "Vision" for models whose images the inference APIs reject.
  skipCreates: true,
  // The tables are docs pages, not a lifecycle API, so a file missing from them is reported, not deleted.
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Tinker models were not created because their base model, reasoning controls and input formats need hand-authored metadata.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} Thinking Machines models are no longer in Tinker's models.json or serverless.json; check whether they were retired.`,
      ...paths.map((path) => `- \`${path}\``),
    ];
  },
  async fetchModels() {
    return fetchTinkerModels();
  },
  parseModels(raw) {
    return parseTinkerModels(raw);
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    // The v1 view reduces MIME types to generic kinds, which can factor a
    // hand-authored format list away against the lab file (Inkling 2's PNG and
    // JPEG against the lab's `image`); keep the override and its list verbatim.
    const modalities = context.v2?.(model.id)?.modalities;
    const built = buildTinkerModel(model, existing);
    return {
      id: model.id,
      model: modalities === undefined ? built : { ...built, modalities: existing.modalities } as SyncedModel,
      v2Set: modalities === undefined ? undefined : { modalities },
    };
  },
} satisfies SyncProvider<TinkerModel>;

export async function fetchTinkerModels(fetcher: typeof fetch = fetch) {
  const [models, serverless] = await Promise.all([MODELS_ENDPOINT, SERVERLESS_ENDPOINT].map(async (url) => {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`Tinker models request failed: ${url} ${response.status} ${response.statusText}`);
    return response.json();
  }));
  return { models, serverless };
}

export function parseTinkerModels(raw: unknown): TinkerModel[] {
  const source = z.object({
    models: z.array(TrainingRow).min(1),
    serverless: z.array(ServerlessRow),
  }).parse(raw);
  const models = [
    ...source.models.map((row) => ({
      id: row.tinker_id,
      context: samplingContext(row.name, row.context),
      input: dollars(row.prefill),
      cacheRead: dollars(row.cached_prefill),
      output: dollars(row.sample),
    })),
    ...source.serverless.map((row) => ({
      id: row.tinker_id,
      context: tokens(row.context),
      input: dollars(row.input),
      cacheRead: dollars(row.cached_input),
      output: dollars(row.output),
    })),
  ];
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) throw new Error(`Tinker lists ${model.id} twice`);
    seen.add(model.id);
  }
  return models;
}

// `context` is the training context. Models that sample past it say so in the
// row name, e.g. "Inkling 2 Mini (64K train / 1M sample)".
function samplingContext(name: string, context: string) {
  const sample = name.match(/\/\s*(\d+[KM]) sample\)/)?.[1];
  return tokens(sample ?? context);
}

// "64K" is 65,536 tokens and "1M" 1,048,576, the windows the IDs name (`:peft:262144` is "256K").
function tokens(value: string) {
  const amount = Number(value.slice(0, -1));
  return amount * (value.endsWith("M") ? 1_048_576 : 1_024);
}

function dollars(value: string) {
  return Number(value.slice(1));
}

// The tables state list prices and the sampling context; everything else in
// the file is hand-authored and kept. An authored output limit above the new
// context is capped by the sync runner.
export function buildTinkerModel(model: TinkerModel, existing: ExistingModel): SyncedModel {
  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const cost = { ...existing.cost, input: model.input, output: model.output, cache_read: model.cacheRead };
  const limit = { ...existing.limit, context: model.context };
  const values = { ...current, cost, limit } as SyncedFullModel;
  return baseModel === undefined ? values : factorBaseModel(baseModel, values, limit, baseModelOmit);
}
