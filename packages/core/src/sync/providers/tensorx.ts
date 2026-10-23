import { z } from "zod";
import { describeModel } from "../../describe.js";
import { inferKimiFamily } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.tensorx.ai/v1/model/info";

// TensorX is a LiteLLM-based gateway: GET /v1/model/info reports every served
// model once per backend deployment under one shared model_name. model_info is
// per deployment, so rows are merged deterministically before translation.
// The sync key must be able to see every model: a scoped key would look like a
// mass retirement.
export const TensorXModelInfo = z
  .object({
    mode: z.string().optional(),
    max_input_tokens: z.number().nullable().optional(),
    max_output_tokens: z.number().nullable().optional(),
    max_tokens: z.number().nullable().optional(),
    input_cost_per_token: z.number().nullable().optional(),
    output_cost_per_token: z.number().nullable().optional(),
    cache_read_input_token_cost: z.number().nullable().optional(),
    cache_creation_input_token_cost: z.number().nullable().optional(),
    supports_vision: z.boolean().nullable().optional(),
    supports_pdf_input: z.boolean().nullable().optional(),
    supports_audio_input: z.boolean().nullable().optional(),
    supports_audio_output: z.boolean().nullable().optional(),
    supports_reasoning: z.boolean().nullable().optional(),
    supports_function_calling: z.boolean().nullable().optional(),
    supports_response_schema: z.boolean().nullable().optional(),
    supported_openai_params: z.array(z.string()).optional(),
  })
  .passthrough();

export const TensorXModel = z
  .object({
    model_name: z.string(),
    model_info: TensorXModelInfo,
  })
  .passthrough();

export const TensorXResponse = z
  .object({ data: z.array(TensorXModel) })
  .passthrough();

export type TensorXModelInfo = z.infer<typeof TensorXModelInfo>;
export type TensorXModel = z.infer<typeof TensorXModel>;

// Modes the v1 chat mapping can represent. Everything else (image generation,
// rerank, moderation, ocr, video) is left to hand authoring.
const SYNCED_MODES: Record<string, true> = {
  chat: true,
  completion: true,
  responses: true,
  embedding: true,
};

// Modes that count as "chat rows" for the empty-catalog guard.
const CHAT_MODES: Record<string, true> = { chat: true, completion: true, responses: true };

let mergeConflicts: string[] = [];

export const tensorx = {
  id: "tensorx",
  name: "TensorX",
  modelsDir: "providers/tensorx/models",
  // A model dropping off the API for an hour must not delete the file: the
  // delete would lose hand-authored reasoning controls and wire-path headers,
  // and recreate-on-return then fails on MissingReasoningOptionsError. The
  // parseModels guards still catch an outage; retirements are handled by hand
  // against the sync report's missing notices.
  deleteMissing: false,
  async fetchModels() {
    const headers = process.env.TENSORX_API_KEY
      ? { Authorization: `Bearer ${process.env.TENSORX_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(
        `TensorX request failed: ${response.status} ${response.statusText}. ` +
          "TENSORX_API_KEY must be a TensorX key with access to every served model.",
      );
    }
    return response.json();
  },
  parseModels(raw) {
    mergeConflicts = [];
    const rows = TensorXResponse.parse(raw).data;
    const byID = new Map<string, TensorXModelInfo[]>();
    for (const row of rows) {
      const infos = byID.get(row.model_name) ?? [];
      infos.push(row.model_info);
      byID.set(row.model_name, infos);
    }
    const merged = [...byID.entries()].map(([model_name, infos]) => ({
      model_name,
      model_info: mergeModelInfo(model_name, infos),
    }));
    if (merged.length === 0) {
      throw new Error(
        "TensorX sync: empty model list — refusing to continue (guards the catalog against a scoped key or an outage).",
      );
    }
    const chatRows = merged.filter((m) => CHAT_MODES[m.model_info.mode ?? "chat"] === true).length;
    if (chatRows === 0) {
      throw new Error(
        `TensorX sync: ${merged.length} models fetched but none in a chat mode — refusing to continue (guards the catalog against a scoped key or an outage).`,
      );
    }
    return merged;
  },
  sourceNotices() {
    return mergeConflicts;
  },
  sourceID(model) {
    return model.model_name;
  },
  translateModel(model, context) {
    const id = model.model_name;
    const existing = context.existing(id);

    // Transcription, speech, and any other non-chat modes carry no chat
    // metadata on the gateway. Keep any authored entry exactly as it is;
    // create nothing.
    const mode = model.model_info.mode ?? "chat";
    if (SYNCED_MODES[mode] !== true) {
      const authored = context.authored(id);
      return authored === undefined ? undefined : { id, model: authored as SyncedModel };
    }

    return {
      id,
      model: buildTensorXModel(model, existing, context.authored(id)),
    };
  },
} satisfies SyncProvider<TensorXModel>;

function minimum(values: Array<number | null | undefined>) {
  const present = values.filter((v): v is number => typeof v === "number");
  return present.length === 0 ? null : Math.min(...present);
}

// Conservative cost merge: publish the highest price any deployment charges,
// so the catalog never under-reports what a request can cost.
function maximum(values: Array<number | null | undefined>) {
  const present = values.filter((v): v is number => typeof v === "number");
  return present.length === 0 ? null : Math.max(...present);
}

// Deployment disagreements are reported, then resolved per flag kind:
// `false` for modality flags (advertise no extra input until the backends
// agree), `null` for capability flags (modifies lab/authored behaviour, so
// restate nothing and keep the authored value downstream).
function booleanMerge(values: Array<boolean | null | undefined>, onConflict: false | null) {
  const present = values.filter((v): v is boolean => typeof v === "boolean");
  if (new Set(present).size === 2) return onConflict;
  return present[0];
}

function mergeModelInfo(id: string, infos: TensorXModelInfo[]): TensorXModelInfo {
  if (infos.length === 1) return infos[0];
  const pick = <K extends keyof TensorXModelInfo>(key: K) =>
    infos.map((info) => info[key]);
  for (const key of [
    "max_input_tokens",
    "max_output_tokens",
    "max_tokens",
    "input_cost_per_token",
    "output_cost_per_token",
    "cache_read_input_token_cost",
    "cache_creation_input_token_cost",
    "supports_vision",
    "supports_pdf_input",
    "supports_audio_input",
    "supports_audio_output",
    "supports_reasoning",
    "supports_function_calling",
    "supports_response_schema",
    "mode",
  ] as const) {
    const values = pick(key).filter((v) => v != null);
    if (new Set(values.map(String)).size > 1) {
      mergeConflicts.push(`${id}: deployments disagree on ${key} (${values.join(" / ")}); synced conservatively`);
    }
  }
  // Deterministic mode: the most frequent value, alphabetical on ties. A row
  // without a mode is a chat row.
  const modes = infos.map((info) => info.mode ?? "chat");
  const counts = new Map<string, number>();
  for (const mode of modes) counts.set(mode, (counts.get(mode) ?? 0) + 1);
  const mode = [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .at(0)?.[0] ?? infos[0].mode;
  return {
    ...infos[0],
    mode,
    max_input_tokens: minimum(pick("max_input_tokens")),
    max_output_tokens: minimum(pick("max_output_tokens")),
    max_tokens: minimum(pick("max_tokens")),
    input_cost_per_token: maximum(pick("input_cost_per_token")),
    output_cost_per_token: maximum(pick("output_cost_per_token")),
    cache_read_input_token_cost: maximum(pick("cache_read_input_token_cost")),
    cache_creation_input_token_cost: maximum(pick("cache_creation_input_token_cost")),
    supports_vision: booleanMerge(pick("supports_vision"), false),
    supports_pdf_input: booleanMerge(pick("supports_pdf_input"), false),
    supports_audio_input: booleanMerge(pick("supports_audio_input"), false),
    supports_audio_output: booleanMerge(pick("supports_audio_output"), false),
    supports_reasoning: booleanMerge(pick("supports_reasoning"), null),
    supports_function_calling: booleanMerge(pick("supports_function_calling"), null),
    supports_response_schema: booleanMerge(pick("supports_response_schema"), null),
    supported_openai_params: [
      ...new Set(pick("supported_openai_params").flatMap((p) => p ?? [])),
    ].sort(),
  };
}

function price(perToken: number | null | undefined) {
  if (perToken === null || perToken === undefined) return undefined;
  return Math.round(perToken * 1_000_000_000_000) / 1_000_000;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

export function buildTensorXModel(
  model: TensorXModel,
  existing: ExistingModel | undefined,
  authored: ExistingModel | undefined,
): SyncedModel {
  const id = model.model_name;
  const info = model.model_info;
  const embedding = info.mode === "embedding";

  const input: Modality[] = ["text"];
  if (info.supports_vision === true) input.push("image");
  if (info.supports_pdf_input === true) input.push("pdf");
  if (info.supports_audio_input === true) input.push("audio");
  const output: Modality[] = ["text"];
  if (info.supports_audio_output === true) output.push("audio");

  const inPrice = price(info.input_cost_per_token);
  const outPrice = price(info.output_cost_per_token);
  const cost = inPrice !== undefined && (outPrice !== undefined || embedding)
    ? {
        input: inPrice,
        output: outPrice ?? 0,
        cache_read: price(info.cache_read_input_token_cost) ?? existing?.cost?.cache_read,
        cache_write: price(info.cache_creation_input_token_cost) ?? existing?.cost?.cache_write,
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;

  const contextLimit = info.max_input_tokens ?? existing?.limit?.context;
  const limit = {
    context: contextLimit,
    input: existing?.limit?.input,
    // max_output_tokens is TensorX's served output cap (their docs derive the
    // per-model output limits from this same API), so it beats the lab card
    // for models served by this gateway.
    output: info.max_output_tokens ?? existing?.limit?.output,
  };

  // A null flag means the gateway does not know; keep the authored value.
  // Embeddings never reason, whatever the gateway claims.
  const reasoning = embedding ? false : (info.supports_reasoning ?? existing?.reasoning);
  const toolCall = embedding ? existing?.tool_call : (info.supports_function_calling ?? existing?.tool_call);
  const temperature = existing?.temperature;
  const structuredOutput = embedding ? existing?.structured_output : (info.supports_response_schema ?? existing?.structured_output);

  // A new model needs researched controls when the flag is true — and when it
  // is unknown (null), because the lab card would then supply reasoning: true
  // and the sync would publish it with no caller control. Embeddings never
  // reason, so they are exempt.
  if (!embedding && reasoning !== false && existing?.reasoning_options === undefined) {
    throw new MissingReasoningOptionsError(
      id,
      "TensorX reasoning controls vary per model; author them before creating this model",
    );
  }

  const canonical = existing?.base_model ?? authored?.base_model ?? resolveCanonicalBaseModel(id);

  if (canonical !== undefined) {
    return factorBaseModel(
      canonical,
      {
        type: embedding ? ("embedding" as const) : existing?.type,
        reasoning,
        reasoning_options: reasoning === true ? existing?.reasoning_options : undefined,
        temperature,
        tool_call: toolCall,
        structured_output: structuredOutput,
        status: existing?.status,
        interleaved: existing?.interleaved,
        limit,
        cost,
        // Modalities come from the lab card: it lists union supertypes with
        // MIME detail the gateway's boolean flags cannot reproduce.
        modalities: undefined,
      },
      limit,
      existing?.base_model === canonical ? existing.base_model_omit : undefined,
    );
  }

  const name = existing?.name ?? id.split("/").pop() ?? id;
  const family = existing?.family ?? inferKimiFamily(id, name);
  const releaseDate = existing?.release_date ?? new Date().toISOString().slice(0, 10);
  // Authored modalities always win: the lab-derived lists carry MIME types
  // (and video) that the gateway's boolean flags cannot reproduce. The
  // flag-derived list is only for a brand-new model with nothing authored.
  const modalities = existing?.modalities
    ?? (input.length > 1 || output.length > 1
      ? { input, output }
      : { input: ["text" as Modality], output: ["text" as Modality] });

  return {
    type: embedding ? ("embedding" as const) : existing?.type,
    name,
    description: existing?.description ?? describeModel({
      id,
      name,
      family,
      reasoning: reasoning ?? false,
      tool_call: toolCall ?? false,
      structured_output: structuredOutput,
      open_weights: existing?.open_weights ?? false,
      limit,
      modalities,
    }),
    family,
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment: modalities.input.length > 1,
    reasoning,
    reasoning_options: undefined,
    temperature,
    tool_call: toolCall,
    structured_output: structuredOutput,
    status: existing?.status,
    interleaved: existing?.interleaved,
    open_weights: existing?.open_weights ?? false,
    cost,
    limit,
    modalities,
  } satisfies SyncedFullModel;
}
