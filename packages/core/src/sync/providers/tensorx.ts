import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.tensorx.ai/v1/model/info";

// `supported_openai_params` is a static LiteLLM-style list: every catalog entry
// advertises the same params, including `temperature` and `response_format` on
// the Whisper and embedding models. It carries no per-model signal, so nothing
// is derived from it — `temperature` and `structured_output` stay lab metadata.
//
// `supports_*` uses three values: true, false, and null for "not published".
// Only real booleans are authored; null leaves the field to the base model.
const TensorXModelInfo = z.object({
  mode: z.string().nullish(),
  max_input_tokens: z.number().int().nonnegative().nullish(),
  max_output_tokens: z.number().int().nonnegative().nullish(),
  max_tokens: z.number().int().nonnegative().nullish(),
  supports_reasoning: z.boolean().nullish(),
  supports_tool_choice: z.boolean().nullish(),
  supports_function_calling: z.boolean().nullish(),
  supports_vision: z.boolean().nullish(),
  input_cost_per_token: z.number().nonnegative().nullish(),
  output_cost_per_token: z.number().nonnegative().nullish(),
  cache_read_input_token_cost: z.number().nonnegative().nullish(),
  cache_creation_input_token_cost: z.number().nonnegative().nullish(),
}).passthrough();

export const TensorXModel = z.object({
  model_name: z.string().min(1),
  model_info: TensorXModelInfo,
});

export const TensorXResponse = z.object({
  data: z.array(TensorXModel),
});

export type TensorXModel = z.infer<typeof TensorXModel>;

export const tensorx = {
  id: "tensorx",
  name: "TensorX",
  modelsDir: "providers/tensorx/models",
  // /v1/model/info carries no reasoning controls and no side-channel field, so
  // a created reasoner would be published with the runner's fallback
  // `reasoning_options = []` — an assertion of "no caller control" that nothing
  // here backs — and no `interleaved`. New IDs are reported for hand-authoring
  // instead; updates to existing TOMLs are unaffected.
  skipCreates: true,
  preserveBaseModels: false,
  // /v1/model/info returns a per-key view: a key scoped to a model group sees
  // only that group, and chat requests for the rest fail with 403 rather than
  // 404. Absence from the response is therefore not evidence that a model was
  // retired, so local entries are never deleted on the strength of it.
  deleteMissing: false,
  sourceID(model) {
    // Non-chat entries (embeddings, transcription, speech) are out of scope and
    // are dropped silently; only unauthorable chat models get reported.
    return model.model_info.mode === "chat" ? model.model_name : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} TensorX chat models were not created: /v1/model/info publishes no name, description, or release date, and no reasoning controls or side-channel field, so a complete model cannot be authored safely.`,
      `Add the lab entry under \`models/\` and hand-author \`reasoning_options\` / \`interleaved\` against the live API. Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local TensorX models were absent from /v1/model/info and were retained for manual lifecycle review.`,
      `That endpoint is a per-key view, so absence can mean the sync key lacks access rather than the model being retired: ${paths.map((path) => `\`${path}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const apiKey = process.env.TENSORX_API_KEY;
    if (!apiKey) {
      throw new Error("TensorX sync requires TENSORX_API_KEY environment variable");
    }
    const response = await fetch(API_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`TensorX model info request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const models = TensorXResponse.parse(raw).data;
    const seen = new Set<string>();
    return models.filter((model) => {
      if (seen.has(model.model_name)) return false;
      seen.add(model.model_name);
      return true;
    });
  },
  translateModel(model, context) {
    if (model.model_info.mode !== "chat") return undefined;

    const existing = context.existing(model.model_name);
    // A base_model already authored locally wins over re-derivation. With
    // preserveBaseModels false the runner will not put it back, so a resolution
    // miss here (dropped alias, renamed lab entry, ID drift) would otherwise
    // flatten the inherited lab fields into the provider TOML.
    const baseModel = existing?.base_model ?? resolveBaseModel(model.model_name);
    // Nothing in this catalog can stand in for lab metadata — no display name,
    // no description, no release date — so an unknown model is reported for
    // hand-authoring instead of being invented.
    if (baseModel === undefined && existing === undefined) return undefined;

    const built = buildTensorXModel(model, baseModel, existing);
    return built === undefined ? undefined : { id: model.model_name, model: built };
  },
} satisfies SyncProvider<TensorXModel>;

function buildTensorXModel(
  model: TensorXModel,
  baseModel: string | undefined,
  existing: ExistingModel | undefined,
): SyncedModel | undefined {
  const info = model.model_info;

  const limit = {
    context: info.max_input_tokens ?? info.max_tokens ?? existing?.limit?.context,
    output: info.max_output_tokens ?? existing?.limit?.output,
  };

  const input = perMillion(info.input_cost_per_token) ?? existing?.cost?.input;
  const output = perMillion(info.output_cost_per_token) ?? existing?.cost?.output;
  // Pricing is published only as a complete pair. A base_model file validates
  // against a deepPartial schema, so a half-resolved cost would be written out
  // as real pricing rather than rejected; a full model would abort the sync.
  const cost = input === undefined || output === undefined
    ? existing?.cost
    : {
      ...existing?.cost,
      input,
      output,
      cache_read: perMillion(info.cache_read_input_token_cost) ?? existing?.cost?.cache_read,
      // cache_creation_input_token_cost is null for every model in the catalog,
      // so a null is "not published" rather than "not charged". Keep the
      // authored price; real values publish as soon as TensorX fills it in.
      cache_write: perMillion(info.cache_creation_input_token_cost) ?? existing?.cost?.cache_write,
    };

  // Never bring a brand-new model into the catalog without real pricing.
  if (existing === undefined && cost === undefined) return undefined;

  const toolFlags = [info.supports_tool_choice, info.supports_function_calling]
    .filter((flag) => flag !== null && flag !== undefined);

  // supports_vision is the only modality signal the catalog carries, so
  // `attachment` and `modalities.input` move together. Authoring one without the
  // other would publish `attachment = true` beside a text-only modality list, or
  // `attachment = false` while image input stays inherited. Only `image` is
  // touched — the flag says nothing about video or pdf.
  const vision = info.supports_vision;
  const inheritedInput = existing?.modalities?.input;
  const modalities = vision === null || vision === undefined || inheritedInput === undefined
    ? existing?.modalities
    : {
      ...existing?.modalities,
      input: vision
        ? (inheritedInput.includes("image") ? inheritedInput : [...inheritedInput, "image"])
        : inheritedInput.filter((modality) => modality !== "image"),
    };

  // `existing` is the base-model-resolved view, so factorBaseModel drops every
  // field that still matches the lab entry and keeps only the real deltas.
  const values: Record<string, unknown> = {
    ...existing,
    attachment: vision ?? existing?.attachment,
    reasoning: info.supports_reasoning ?? existing?.reasoning,
    tool_call: toolFlags.length > 0 ? toolFlags.some(Boolean) : existing?.tool_call,
    cost,
    limit,
    modalities,
  };
  delete values.base_model;
  delete values.base_model_omit;

  return baseModel === undefined
    ? values as SyncedFullModel
    : factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
}

// Dated snapshots TensorX serves that have no lab entry of their own.
const BASE_MODEL_ALIASES: Record<string, string | undefined> = {
  "deepseek/deepseek-r1-0528": "deepseek/deepseek-r1",
  "deepseek/deepseek-r1-0625": "deepseek/deepseek-r1",
};

function resolveBaseModel(modelID: string): string | undefined {
  // resolveCanonicalBaseModel owns the org-prefix map and matches metadata
  // filenames case-insensitively, so `minimax/minimax-m3` still resolves to
  // `models/minimax/MiniMax-M3.toml`.
  return resolveCanonicalBaseModel(BASE_MODEL_ALIASES[modelID] ?? modelID);
}

function perMillion(costPerToken: number | null | undefined): number | undefined {
  if (costPerToken === null || costPerToken === undefined) return undefined;
  return Math.round(costPerToken * 1_000_000 * 1e10) / 1e10;
}
