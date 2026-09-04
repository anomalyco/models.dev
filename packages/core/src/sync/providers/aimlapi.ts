import { z } from "zod";

import type { SyncProvider } from "../index.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

// The public catalog needs no key, and `include` is what turns on the pricing
// and modality blocks this sync depends on.
const API_ENDPOINT = "https://api.aimlapi.com/v1/models?include=pricing,modalities";

// Per-model request schema. It is the only place the API states which reasoning
// controls a model actually accepts, so reasoning_options is read from here
// rather than assumed.
const DOCS_ENDPOINT = "https://api.aimlapi.com/docs-json";

// AI/ML API serves one id under several endpoint types — a model can be both a
// chat model and, say, an image model. Only the chat surface belongs here.
const CHAT_COMPLETIONS_TYPE = "openai/chat-completions";

// Values this schema accepts for an "effort" reasoning control. Anything the
// API documents outside this set is dropped rather than coerced.
const EFFORT_VALUES = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]);

const DOCS_CONCURRENCY = 8;

const PricingUnit = z
  .object({
    name: z.string().nullish(),
    content: z.string().nullish(),
    origin: z.string().nullish(),
    price: z.number().nullish(),
    per: z.number().nullish(),
  })
  .passthrough();

const Info = z
  .object({
    contextLength: z.number().int().nonnegative().nullish(),
    outputMax: z.number().int().nonnegative().nullish(),
  })
  .passthrough();

export const AimlapiModel = z
  .object({
    id: z.string().min(1),
    type: z.string().nullish(),
    info: Info.nullish(),
    modalities: z
      .object({
        input: z.array(z.string()).nullish(),
        output: z.array(z.string()).nullish(),
      })
      .passthrough()
      .nullish(),
    pricing: z
      .object({
        units: z.array(PricingUnit).nullish(),
      })
      .passthrough()
      .nullish(),
    /** Attached by fetchModels; not part of the upstream payload. */
    reasoningEffort: z.array(z.string()).nullish(),
  })
  .passthrough();

export const AimlapiResponse = z
  .object({
    data: z.array(AimlapiModel).min(1),
  })
  .passthrough();

export type AimlapiModel = z.infer<typeof AimlapiModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

const MODALITIES = new Set<string>(["text", "audio", "image", "video", "pdf"]);

function normalizeModalities(values: readonly string[] | null | undefined): Modality[] {
  const seen = new Set<Modality>();
  for (const value of values ?? []) {
    const normalized = value.toLowerCase();
    if (MODALITIES.has(normalized)) seen.add(normalized as Modality);
  }
  if (seen.size === 0) seen.add("text");
  return [...seen];
}

/**
 * Ids this host also serves on a non-text surface.
 *
 * The catalog lists an id once per endpoint type, and the chat-surface record of
 * an image model claims text output. Measured 2026-09-04:
 * `google/gemini-2.5-flash-image` appears both as `openai/image-generations`
 * with `output: ["image"]` and as `openai/chat-completions` with
 * `output: ["text"]`; the same holds for the `gemini-3-pro-image` and
 * `gemini-3.1-flash-image` families. Judging a record only by its own modalities
 * therefore admits image generators into a chat catalog.
 *
 * An id this host serves as a media model is not a text-only chat model, whatever
 * its chat record claims. Populated from the whole response before any record is
 * judged, because the answer is not in the record itself.
 */
const mediaOutputIDs = new Set<string>();

function indexMediaOutputs(models: readonly AimlapiModel[]): void {
  mediaOutputIDs.clear();
  for (const model of models) {
    const declared = model.modalities?.output ?? [];
    // `normalizeModalities` treats an empty list as text, so an undeclared
    // record must not be read as evidence of anything.
    if (declared.length === 0) continue;
    if (normalizeModalities(declared).some((modality) => modality !== "text")) {
      mediaOutputIDs.add(model.id);
    }
  }
}

function isChatTextModel(model: AimlapiModel): boolean {
  if (model.type !== CHAT_COMPLETIONS_TYPE) return false;
  // Cross-surface check first: the chat record of a media model does not admit
  // to being one.
  if (mediaOutputIDs.has(model.id)) return false;
  const output = normalizeModalities(model.modalities?.output);
  // A chat model whose output is not purely text is a media model riding the
  // chat protocol, and does not belong in a chat catalog.
  return output.length === 1 && output[0] === "text";
}

/**
 * Lab entry this id is a host for. AI/ML API is an aggregator and authors none
 * of these models, so every entry has to point at the lab file rather than
 * restate it.
 */
function baseModelFor(id: string): string | undefined {
  return resolveModelMetadataBaseModel(id);
}

function baseReasoning(baseModelID: string): boolean {
  try {
    return modelMetadata(baseModelID).reasoning === true;
  } catch {
    return false;
  }
}

/**
 * Prices are quoted as `price` per `per` tokens; models.dev stores dollars per
 * million. The unit discriminator is `origin`, not `measure`: provided is
 * input, generated is output, cached is a cache read. Only text token charges
 * are taken — a model's image or audio units are a different surface.
 */
function perMillion(units: readonly z.infer<typeof PricingUnit>[], origin: string): number | undefined {
  const unit = units.find(
    (candidate) => candidate.name === "token" && candidate.content === "text" && candidate.origin === origin,
  );
  if (!unit || unit.price == null || !unit.per) return undefined;
  return (unit.price / unit.per) * 1_000_000;
}

function positive(value: number | null | undefined): number | undefined {
  return value != null && value > 0 ? value : undefined;
}

/**
 * Reads the documented `reasoning_effort` enum for one model. Returns undefined
 * when the docs do not describe the control, which is treated as "cannot state
 * it" rather than "the model has none".
 */
async function fetchReasoningEffort(id: string): Promise<string[] | undefined> {
  const url = `${DOCS_ENDPOINT}?model=${encodeURIComponent(id)}&endpoint=${encodeURIComponent(CHAT_COMPLETIONS_TYPE)}`;
  let payload: unknown;
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    payload = await response.json();
  } catch {
    return undefined;
  }

  const found = findReasoningEffortEnum(payload);
  if (found === undefined) return undefined;

  const values = found.filter((value) => EFFORT_VALUES.has(value));
  return values.length > 0 ? values : undefined;
}

function findReasoningEffortEnum(node: unknown): string[] | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findReasoningEffortEnum(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;

  const record = node as Record<string, unknown>;
  const effort = record["reasoning_effort"];
  if (effort !== null && typeof effort === "object") {
    const values = (effort as Record<string, unknown>)["enum"];
    if (Array.isArray(values) && values.every((value) => typeof value === "string")) {
      return values as string[];
    }
  }

  for (const value of Object.values(record)) {
    const found = findReasoningEffortEnum(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function attachReasoningEffort(models: AimlapiModel[]): Promise<void> {
  // Only models whose lab entry says they reason need the control documented,
  // and only those are worth a request.
  const pending = models.filter((model) => {
    if (!isChatTextModel(model)) return false;
    const base = baseModelFor(model.id);
    return base !== undefined && baseReasoning(base);
  });

  let cursor = 0;
  const workers = Array.from({ length: Math.min(DOCS_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const model = pending[cursor++];
      if (model === undefined) return;
      model.reasoningEffort = await fetchReasoningEffort(model.id);
    }
  });
  await Promise.all(workers);
}

export const aimlapi = {
  id: "aimlapi",
  name: "AI/ML API",
  modelsDir: "providers/aimlapi/models",
  // The catalog turns over quickly and lists far more than the chat surface, so
  // a local model missing from one response is not proof that it is gone.
  deleteMissing: false,
  sourceID(model) {
    return isChatTextModel(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} AI/ML API chat models were skipped because this repository has no lab entry to point \`base_model\` at, or because the API does not document the reasoning control a reasoning model requires.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local AI/ML API models were absent from the catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`AI/ML API request failed: ${response.status} ${response.statusText}`);
    }
    const raw = await response.json();
    const parsed = AimlapiResponse.parse(raw);
    indexMediaOutputs(parsed.data);
    await attachReasoningEffort(parsed.data);
    return parsed;
  },
  parseModels(raw) {
    const models = AimlapiResponse.parse(raw).data;
    // Replays parse a cached payload without going through fetchModels.
    indexMediaOutputs(models);
    return models;
  },
  translateModel(model, context) {
    if (!isChatTextModel(model)) return undefined;

    const existing = context.existing(model.id);

    // AI/ML API hosts other people's models, so the entry must reference the
    // lab file instead of duplicating it. Without a lab entry to point at there
    // is nothing correct to write: inlining the metadata is what this schema
    // forbids, and authoring the lab file would mean sourcing capability data
    // the catalog does not publish.
    const base = existing?.base_model ?? baseModelFor(model.id);
    if (base === undefined) return undefined;

    // Required whenever the base model reasons. Only the API's own request
    // schema can say which values it takes, so a model whose docs stay silent
    // is skipped rather than given an invented control.
    let reasoningOptions: Array<{ type: "effort"; values: string[] }> | undefined;
    if (baseReasoning(base)) {
      const values = model.reasoningEffort ?? undefined;
      if (values === undefined || values.length === 0) return undefined;
      reasoningOptions = [{ type: "effort", values }];
    }

    const units = model.pricing?.units ?? [];
    const info = model.info ?? {};
    const contextLimit = positive(info.contextLength);
    const outputLimit = positive(info.outputMax);
    // Only what the catalog actually publishes. It reports a context window and
    // an output cap but no input cap, and equating the input cap with the whole
    // context would overwrite the lab's correct split (e.g. 272k in + 128k out
    // within a 400k window) with a wrong number.
    const limit =
      contextLimit === undefined && outputLimit === undefined
        ? undefined
        : { context: contextLimit, output: outputLimit };

    // Everything else — the capability flags, description, dates, modalities —
    // is the lab's to state and is inherited. factorBaseModel drops whatever
    // matches the base, so the file carries only what is genuinely ours.
    return {
      id: model.id,
      model: factorBaseModel(
        base,
        {
          cost: {
            input: perMillion(units, "provided") ?? existing?.cost?.input,
            output: perMillion(units, "generated") ?? existing?.cost?.output,
            cache_read: perMillion(units, "cached") ?? existing?.cost?.cache_read,
          },
          reasoning_options: reasoningOptions,
          limit,
        },
        limit,
        existing?.base_model === base ? existing?.base_model_omit : undefined,
      ),
    };
  },
} satisfies SyncProvider<AimlapiModel>;
