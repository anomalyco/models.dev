import { z } from "zod";

import type { SyncProvider } from "../index.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { buildOpenRouterModel, modelMetadata, resolveModelMetadataBaseModel, type OpenRouterModel } from "./openrouter.js";

// TrustedRouter serves OpenRouter's model ids and catalog shape, so models
// translate through the OpenRouter builder and resolve the same lab bases.
const API_ENDPOINT = "https://api.trustedrouter.com/v1/models";
const ROUTE_PREFIX = "trustedrouter/";

const Efforts = z.array(z.enum(["max", "xhigh", "high", "medium", "low", "minimal", "none"]));

export const TrustedRouterModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  created: z.number(),
  // Embedding, video and decision rows can omit token context and prices.
  context_length: z.number().int().positive().nullish(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }).passthrough(),
  pricing: z.object({
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
  // Published only where every route honors reasoning controls: absent means
  // no caller control, an empty list means on/off without graded efforts.
  reasoning: z.object({
    mandatory: z.boolean(),
    supported_efforts: Efforts.nullable().optional(),
  }).passthrough().optional(),
  trustedrouter: z.object({
    route_kind: z.string().nullish(),
    internal_only: z.boolean().nullish(),
    configuration_hidden: z.boolean().nullish(),
    synthetic_monitor: z.boolean().nullish(),
  }).passthrough().nullish(),
}).passthrough();

export const TrustedRouterResponse = z.object({
  data: z.array(TrustedRouterModel).min(1, "TrustedRouter returned an empty catalog; refusing to remove local models"),
}).passthrough().refine(
  (response) => new Set(response.data.map((model) => model.id)).size === response.data.length,
  "TrustedRouter returned duplicate model IDs",
);

export type TrustedRouterModel = z.infer<typeof TrustedRouterModel>;

// Public, tool-capable text models. Internal, hidden and monitor rows are not
// for customers.
function publicChatModel(model: TrustedRouterModel) {
  const meta = model.trustedrouter;
  if (meta?.internal_only || meta?.configuration_hidden || meta?.synthetic_monitor) return false;
  if (model.context_length == null || model.pricing.prompt === undefined || model.pricing.completion === undefined) return false;
  return model.supported_parameters.includes("tools")
    && model.architecture.input_modalities.includes("text")
    && model.architecture.output_modalities.includes("text");
}

function toOpenRouterShape(model: TrustedRouterModel, baseModel: string): OpenRouterModel {
  // The catalog publishes no output cap, so the lab's output limit stands.
  const labOutput = (modelMetadata(baseModel).limit as { output?: number } | undefined)?.output ?? null;
  const reasoning = model.reasoning === undefined ? undefined : {
    mandatory: model.reasoning.mandatory,
    // OpenRouter reads null as every effort, and an empty list would publish an
    // empty effort control; TrustedRouter's empty or null list means on/off only.
    supported_efforts: model.reasoning.supported_efforts?.length ? model.reasoning.supported_efforts : undefined,
  };
  return {
    id: model.id,
    name: model.name,
    created: model.created,
    hugging_face_id: null,
    knowledge_cutoff: null,
    context_length: model.context_length!,
    architecture: {
      // Lab order (text first), so the MIME mapping below lines up with the v1 list.
      input_modalities: [...model.architecture.input_modalities].sort((a, b) => kindRank(a) - kindRank(b)),
      output_modalities: model.architecture.output_modalities,
    },
    pricing: {
      prompt: model.pricing.prompt!,
      completion: model.pricing.completion!,
      input_cache_read: model.pricing.input_cache_read,
      input_cache_write: model.pricing.input_cache_write,
    },
    top_provider: {
      context_length: model.top_provider.context_length,
      max_completion_tokens: model.top_provider.max_completion_tokens ?? labOutput,
    },
    supported_parameters: model.supported_parameters,
    reasoning,
  };
}

export const trustedrouter = {
  id: "trustedrouter",
  name: "TrustedRouter",
  modelsDir: "providers/trustedrouter/models",
  // Lab bases are resolved per model; the catalog is not a source of lab facts.
  trackMissingModels: false,
  fetchModels: fetchTrustedRouterModels,
  parseModels(raw) {
    return TrustedRouterResponse.parse(raw).data;
  },
  sourceID(model) {
    return model.id.startsWith(ROUTE_PREFIX) || publicChatModel(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `${ids.length} TrustedRouter models were skipped: no lab metadata in models/ to use as base_model, or a TrustedRouter route without an authored file.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  translateModel(model, context) {
    // trustedrouter/* routes (auto, zdr, e2e, ...) are TrustedRouter's own
    // routing aliases with no lab identity: authored files are kept as written,
    // and new routes are left for hand authoring.
    if (model.id.startsWith(ROUTE_PREFIX)) {
      const authored = context.authored(model.id);
      return authored === undefined ? undefined : { id: model.id, model: authored };
    }
    if (!publicChatModel(model)) return undefined;
    const existing = context.existing(model.id);
    const baseModel = existing?.base_model ?? resolveModelMetadataBaseModel(model.id) ?? openRouterBaseModel(model.id);
    if (baseModel === undefined) return undefined;
    const labInput = labMimeList(baseModel);
    return {
      id: model.id,
      model: buildOpenRouterModel(toOpenRouterShape(model, baseModel), existing, baseModel),
      v2Set: { "modalities.input": (current: unknown) => labMimeInput(current, labInput) },
      header: "# Generated by bun models:sync trustedrouter from https://api.trustedrouter.com/v1/models.\n"
        + "# Prices are USD per million tokens; lab facts are inherited via base_model.\n"
        + "# Reasoning controls are TrustedRouter's published `reasoning` object: OpenRouter's efforts for the model,\n"
        + "# narrowed to what the gateway honors on every route (https://trustedrouter.com/docs).\n"
        + "# Mid-conversation: system_updates, effort_updates and tools.updates are unset; TrustedRouter documents none of them.\n",
    };
  },
} satisfies SyncProvider<TrustedRouterModel>;

// Same ids as OpenRouter: when the lab name doesn't resolve directly, reuse the
// base_model OpenRouter's entry for the id already points at.
const OPENROUTER_MODELS = path.join(import.meta.dir, "../../../../../providers/openrouter/models");
function openRouterBaseModel(id: string) {
  const file = path.join(OPENROUTER_MODELS, `${id}.toml`);
  if (!existsSync(file)) return undefined;
  const base = (Bun.TOML.parse(readFileSync(file, "utf8")) as { base_model?: unknown }).base_model;
  return typeof base === "string" ? base : undefined;
}


// The catalog lists generic input kinds (`image`, `pdf`, ...). Use the lab's
// exact MIME entries for each kind TrustedRouter serves, and inherit the lab's
// list when it is the same.
const KIND_PREFIX: Record<string, (mime: string) => boolean> = {
  text: (mime) => mime === "text",
  image: (mime) => mime.startsWith("image"),
  pdf: (mime) => mime === "pdf" || mime === "application/pdf",
  audio: (mime) => mime.startsWith("audio"),
  video: (mime) => mime.startsWith("video"),
};
export function labMimeInput(current: unknown, lab: string[] | undefined) {
  if (!Array.isArray(current) || lab === undefined) return current;
  const kinds = current.filter((value): value is string => typeof value === "string");
  const mapped = lab.filter((mime) => kinds.some((kind) => KIND_PREFIX[kind]?.(mime)));
  const unmatched = kinds.filter((kind) => !lab.some((mime) => KIND_PREFIX[kind]?.(mime)));
  const input = [...mapped, ...unmatched];
  return input.length === lab.length && input.every((value, index) => value === lab[index]) ? undefined : input;
}

const KIND_ORDER = ["text", "image", "pdf", "audio", "video"];
function kindRank(kind: string) {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

// The lab file's own input list, with MIME types (modelMetadata gives v1 kinds).
const LAB_MODELS = path.join(import.meta.dir, "../../../../../models");
function labMimeList(baseModel: string) {
  const file = path.join(LAB_MODELS, `${baseModel}.toml`);
  if (!existsSync(file)) return undefined;
  const lab = Bun.TOML.parse(readFileSync(file, "utf8")) as { modalities?: { input?: unknown } };
  const input = lab.modalities?.input;
  return Array.isArray(input) && input.every((value) => typeof value === "string") ? input as string[] : undefined;
}

export async function fetchTrustedRouterModels(fetcher: typeof fetch = fetch) {
  // The catalog is public; no key is sent.
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`TrustedRouter catalog request failed: ${response.status} ${response.statusText}`);
  }
  return TrustedRouterResponse.parse(await response.json());
}
