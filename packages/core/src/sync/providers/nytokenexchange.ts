import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, modelMetadata, resolveCanonicalBaseModel } from "./openrouter.js";

// NY Token Exchange (NYTE) serves TrustedRouter's catalog at its own hostname:
// same keys, balance, model ids and request format, with prompts terminating in
// a hardware-attested gateway. The model list is public and OpenRouter-shaped.
// https://trustedrouter.com/docs#nyte-api
const API_ENDPOINT = "https://api.nytokenexchange.com/v1/models";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// The lab file's own limits, where it states them.
function labLimit(baseModel: string): { context?: number; output?: number } {
  try {
    const lab = Bun.TOML.parse(fs.readFileSync(path.join(MODELS_DIR, `${baseModel}.toml`), "utf8")) as {
      limit?: { context?: unknown; output?: unknown };
    };
    return {
      context: typeof lab.limit?.context === "number" ? lab.limit.context : undefined,
      output: typeof lab.limit?.output === "number" ? lab.limit.output : undefined,
    };
  } catch {
    return {};
  }
}

// The catalog reports an unknown window as null or 0.
function knownLimit(value: number | null | undefined) {
  return value !== null && value !== undefined && value > 0 ? value : undefined;
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const NyteModel = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  context_length: z.number().nullable(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }).passthrough(),
  pricing: z.object({
    // Media models (speech, video, images) price per unit and omit these.
    prompt: z.string().optional(),
    completion: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }).passthrough(),
  top_provider: z.object({
    context_length: z.number().nullable(),
    max_completion_tokens: z.number().nullable(),
  }).passthrough(),
  supported_parameters: z.array(z.string()),
  // OpenRouter's per-model reasoning metadata, narrowed to what NYTE's gateway honors.
  reasoning: z.object({
    mandatory: z.boolean(),
    supported_efforts: z.array(z.string()),
  }).passthrough().optional(),
  trustedrouter: z.object({
    supports_chat: z.boolean(),
    route_kind: z.string().optional(),
    prepaid_available: z.boolean(),
    internal_only: z.boolean().optional(),
    configuration_hidden: z.boolean().optional(),
  }).passthrough(),
}).passthrough();

export const NyteResponse = z.object({ data: z.array(NyteModel) }).passthrough();

export type NyteModel = z.infer<typeof NyteModel>;

export const nytokenexchange = {
  id: "nytokenexchange",
  name: "NY Token Exchange",
  modelsDir: "providers/nytokenexchange/models",
  // Routing aliases (nyte/auto, nyte/fast, ...) are authored by hand, and a model
  // the catalog stops offering as prepaid chat may return; sync never deletes.
  deleteMissing: false,
  sourceID(model) {
    return isLabModel(model) ? model.id : undefined;
  },
  // A plain model is only skipped when no lab entry exists to base it on.
  missingModelID(model) {
    return isLabModel(model) && resolveCanonicalBaseModel(model.id) === undefined ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} NY Token Exchange models have no lab entry under models/ to base them on: `
        + ids.map((id) => `\`${id}\``).join(", "),
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`NY Token Exchange request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // The catalog can list one model under ids that differ only in case
    // (`zai-org/glm-5.1`, `zai-org/GLM-5.1`); catalog paths are case-insensitive,
    // so keep one, preferring the lowercase spelling.
    const byPath = new Map<string, NyteModel>();
    for (const model of NyteResponse.parse(raw).data) {
      const key = model.id.toLowerCase();
      const kept = byPath.get(key);
      if (kept === undefined || (kept.id !== key && model.id === key)) byPath.set(key, model);
    }
    return [...byPath.values()];
  },
  translateModel(model, context) {
    if (!isLabModel(model)) return undefined;
    const existing = context.existing(model.id);
    const canonical = existing?.base_model ?? resolveCanonicalBaseModel(model.id);
    if (canonical === undefined) return undefined;
    return {
      id: model.id,
      model: buildNyteModel(model, canonical, existing, context.authored(model.id)),
    };
  },
} satisfies SyncProvider<NyteModel>;

// A lab model a NYTE key can call without extra setup: prepaid, listed, chat with
// text out, and a plain model rather than a routing or orchestration entry (those
// bill whatever they pick and are authored by hand). BYOK-only, embedding, image,
// speech, video and decision models are not chat models in OpenCode's sense.
function isLabModel(model: NyteModel) {
  const tr = model.trustedrouter;
  return (
    tr.supports_chat &&
    tr.prepaid_available &&
    tr.internal_only !== true &&
    tr.configuration_hidden !== true &&
    (tr.route_kind ?? "model") === "model" &&
    !model.id.startsWith("trustedrouter/") &&
    // Mixed-case ids (`Qwen/...`, `zai-org/GLM-5.2`) cannot live beside their
    // lowercase spellings on a case-insensitive checkout; only lowercase ids sync.
    model.id === model.id.toLowerCase() &&
    model.architecture.output_modalities.includes("text") &&
    model.supported_parameters.length > 0 &&
    price(model.pricing.prompt) !== undefined &&
    price(model.pricing.completion) !== undefined
  );
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .map((value) => value === "file" ? "pdf" : value)
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

// The catalog's `reasoning` object lists only efforts the gateway honors on every
// route of the model, sent as OpenRouter's `reasoning.effort` ("none" turns
// reasoning off). A mandatory model with no efforts reasons with no caller control.
function reasoningOptions(model: NyteModel): SyncedFullModel["reasoning_options"] {
  if (model.reasoning === undefined) return undefined;
  const efforts = model.reasoning.supported_efforts;
  if (efforts.length === 0) return model.reasoning.mandatory ? [] : undefined;
  const ordered = EFFORT_ORDER.filter((effort) => efforts.includes(effort));
  return ordered.length === 0 ? undefined : [{ type: "effort", values: [...ordered] }];
}

export function buildNyteModel(
  model: NyteModel,
  canonical: string,
  existing: ExistingModel | undefined,
  authored?: ExistingModel,
): SyncedModel {
  const params = new Set(model.supported_parameters);
  const input = modalities(model.architecture.input_modalities, ["text"]);
  const output = modalities(model.architecture.output_modalities, ["text"]);
  // A catalog row that omits the reasoning parameter does not make a reasoning
  // model non-reasoning; the lab's flag stands.
  const reasoning = params.has("reasoning") || params.has("include_reasoning")
    || model.reasoning !== undefined || modelMetadata(canonical).reasoning === true;
  // Publish only controls the gateway states it honors; without them a reasoning
  // model waits for someone to probe the route, and authored controls are kept.
  const reasoning_options = reasoning
    ? reasoningOptions(model) ?? existing?.reasoning_options
    : undefined;
  if (reasoning && reasoning_options === undefined) {
    throw new MissingReasoningOptionsError(
      model.id,
      `reasoning model (base ${canonical}) whose NY Token Exchange catalog row publishes no`
        + " reasoning.supported_efforts; probe the route and author its reasoning_options by hand",
    );
  }
  // Unknown limits are inherited from the lab (stating the lab's value factors
  // it out); only a lab without an output cap needs the context window as one.
  const lab = labLimit(canonical);
  const context = knownLimit(model.top_provider.context_length) ?? knownLimit(model.context_length)
    ?? existing?.limit?.context ?? lab.context ?? 128_000;
  const outputCap = knownLimit(model.top_provider.max_completion_tokens) ?? existing?.limit?.output
    ?? (lab.output === undefined ? context : undefined);
  const prompt = price(model.pricing.prompt)!;
  // A cached read priced above an uncached one is a catalog error; omit it.
  const cacheRead = price(model.pricing.input_cache_read);
  return factorBaseModel(
    canonical,
    {
      // Linked files inherit the lab's name and description unless a person
      // authored one here; the catalog's are the router's labels, not the model's.
      name: authored?.name,
      description: authored?.description,
      attachment: input.some((value) => value !== "text"),
      reasoning,
      reasoning_options,
      temperature: params.has("temperature"),
      tool_call: params.has("tools") || params.has("tool_choice"),
      structured_output: params.has("structured_outputs"),
      status: existing?.status,
      interleaved: existing?.interleaved,
      limit: { context, output: outputCap },
      modalities: { input, output },
      cost: {
        input: prompt,
        output: price(model.pricing.completion)!,
        cache_read: cacheRead !== undefined && cacheRead <= prompt ? cacheRead : undefined,
        cache_write: price(model.pricing.input_cache_write),
        tiers: existing?.cost?.tiers,
      },
    },
    { context, output: outputCap },
    existing?.base_model === canonical ? existing.base_model_omit : undefined,
  );
}
