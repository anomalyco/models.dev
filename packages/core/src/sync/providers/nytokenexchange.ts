import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

// NY Token Exchange (NYTE) serves TrustedRouter's catalog at its own hostname:
// same keys, balance, model ids and request format, with prompts terminating in
// a hardware-attested gateway. The model list is public and OpenRouter-shaped.
// https://trustedrouter.com/docs#nyte-api
const API_ENDPOINT = "https://api.nytokenexchange.com/v1/models";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// The lab file's own output limit, when it states one.
function labOutputLimit(baseModel: string): number | undefined {
  try {
    const lab = Bun.TOML.parse(fs.readFileSync(path.join(MODELS_DIR, `${baseModel}.toml`), "utf8")) as {
      limit?: { output?: unknown };
    };
    return typeof lab.limit?.output === "number" ? lab.limit.output : undefined;
  } catch {
    return undefined;
  }
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
    open_weights: z.boolean().optional(),
    aliases: z.array(z.string()).optional(),
  }).passthrough(),
}).passthrough();

export const NyteResponse = z.object({ data: z.array(NyteModel) }).passthrough();

export type NyteModel = z.infer<typeof NyteModel>;

export const nytokenexchange = {
  id: "nytokenexchange",
  name: "NY Token Exchange",
  modelsDir: "providers/nytokenexchange/models",
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
    // Chat models a NYTE key can call without extra setup: prepaid, listed, text out.
    // BYOK-only, embedding, image, speech, video and decision models are not chat
    // models in OpenCode's sense, and hidden or internal entries are not offered.
    if (!isOfferedChatModel(model)) return undefined;
    const id = nyteID(model);
    return {
      id,
      model: buildNyteModel(model, context.existing(id), context.authored(id)),
    };
  },
} satisfies SyncProvider<NyteModel>;

function isOfferedChatModel(model: NyteModel) {
  const tr = model.trustedrouter;
  return (
    tr.supports_chat &&
    tr.prepaid_available &&
    tr.internal_only !== true &&
    tr.configuration_hidden !== true &&
    model.architecture.output_modalities.includes("text") &&
    model.supported_parameters.length > 0 &&
    price(model.pricing.prompt) !== undefined &&
    price(model.pricing.completion) !== undefined
  );
}

// TrustedRouter's own routing models (auto, fast, zdr, ...) are published under
// their NYTE names; every `trustedrouter/` id also answers to `nyte/`.
export function nyteID(model: NyteModel) {
  if (!model.id.startsWith("trustedrouter/")) return model.id;
  const alias = `nyte/${model.id.slice("trustedrouter/".length)}`;
  return model.trustedrouter.aliases?.includes(alias) ? alias : model.id;
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

function inferFamily(model: NyteModel, name: string) {
  const kimiFamily = inferKimiFamily(model.id, name);
  if (kimiFamily !== undefined) return kimiFamily;
  const target = `${model.id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") {
        return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      }
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

// The catalog's `reasoning.supported_efforts` lists only efforts the gateway
// honors on every route of the model; publish them in canonical order.
function reasoningOptions(model: NyteModel): SyncedFullModel["reasoning_options"] {
  const efforts = model.reasoning?.supported_efforts.filter((effort) =>
    (EFFORT_ORDER as readonly string[]).includes(effort),
  );
  if (efforts === undefined || efforts.length === 0) return undefined;
  const ordered = EFFORT_ORDER.filter((effort) => efforts.includes(effort));
  return [{ type: "effort", values: [...ordered] }];
}

// The catalog names and describes TrustedRouter's own routing models with the
// TrustedRouter brand; on this provider they are NYTE's.
function rebrand(text: string) {
  return text.replace(/ via TrustedRouter\b/g, "").replace(/\bTrustedRouter\b/g, "NYTE");
}

export function buildNyteModel(
  model: NyteModel,
  existing: ExistingModel | undefined,
  authored?: ExistingModel,
): SyncedModel {
  const params = new Set(model.supported_parameters);
  const name = rebrand(model.name);
  const apiDescription = model.description === undefined
    ? undefined
    : rebrand(model.description.replaceAll(/\s+/g, " ").trim()) || undefined;
  const input = modalities(model.architecture.input_modalities, ["text"]);
  const output = modalities(model.architecture.output_modalities, ["text"]);
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = params.has("reasoning") || params.has("include_reasoning");
  const reasoning_options = reasoning
    ? reasoningOptions(model) ?? existing?.reasoning_options
    : undefined;
  const context = model.top_provider.context_length ?? model.context_length ?? existing?.limit?.context ?? 128_000;
  const family = inferFamily(model, name);
  const familyValue = existing?.family ?? family;
  const attachment = input.some((value) => value !== "text");
  const toolCall = params.has("tools") || params.has("tool_choice");
  const structuredOutput = params.has("structured_outputs");
  const openWeights = model.trustedrouter.open_weights ?? existing?.open_weights ?? false;
  // A routing or orchestration entry (nyte/auto, nyte/fast, panels, ...) bills the
  // model it picks, so a static price would mislead; only plain models carry one.
  const routed = (model.trustedrouter.route_kind ?? "model") !== "model";
  const cost = routed
    ? undefined
    : prompt !== undefined && completion !== undefined
    ? {
        input: prompt,
        output: completion,
        cache_read: price(model.pricing.input_cache_read),
        cache_write: price(model.pricing.input_cache_write),
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;
  // An absent output cap is unknown, not equal to the context window: linked
  // models then inherit the lab's, and only full definitions fall back.
  const outputCap = model.top_provider.max_completion_tokens ?? existing?.limit?.output;
  const limit = { context, input: existing?.limit?.input, output: outputCap ?? context };
  const description = existing?.description ?? apiDescription ?? describeModel({
    id: model.id,
    name,
    family: familyValue,
    reasoning,
    tool_call: toolCall,
    structured_output: structuredOutput,
    open_weights: openWeights,
    limit,
    modalities: { input, output },
  });
  const canonical = existing?.base_model ?? resolveCanonicalBaseModel(model.id);

  if (canonical !== undefined) {
    // Inherit the lab's output cap when the catalog has none; a lab without one
    // needs a value here, and the context window is the only bound we know.
    const linkedOutput = outputCap ?? (labOutputLimit(canonical) === undefined ? context : undefined);
    return factorBaseModel(
      canonical,
      {
        // Linked files inherit the lab's name and description unless a person
        // authored one here; the catalog's are the router's labels, not the model's.
        name: authored?.name,
        description: authored?.description,
        attachment,
        reasoning,
        reasoning_options,
        temperature: params.has("temperature"),
        tool_call: toolCall,
        structured_output: structuredOutput,
        status: existing?.status,
        interleaved: existing?.interleaved,
        limit: { context, output: linkedOutput },
        modalities: { input, output },
        cost,
      },
      { context, output: linkedOutput },
      existing?.base_model === canonical ? existing.base_model_omit : undefined,
    );
  }

  // The catalog carries no release date for TrustedRouter's own routing models;
  // keep the first-synced date rather than inventing one each run.
  const releaseDate = existing?.release_date ?? new Date().toISOString().slice(0, 10);
  return {
    name,
    description,
    family: familyValue,
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment,
    reasoning,
    reasoning_options,
    temperature: params.has("temperature"),
    tool_call: toolCall,
    structured_output: structuredOutput,
    open_weights: openWeights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}
