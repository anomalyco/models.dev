import { readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.tokenfactory.nebius.com/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Scoped to the orgs Nebius Token Factory currently hosts; extend as new orgs show up.
// Maps a Nebius org prefix to the provider-agnostic namespace under `models/`.
const NEBIUS_ORG_TO_MODEL_PROVIDER: Record<string, string | undefined> = {
  "meta-llama": "meta",
  Qwen: "alibaba",
  google: "google",
  openai: "openai",
  nvidia: "nvidia",
  "zai-org": "zhipuai",
  moonshotai: "moonshotai",
  MiniMaxAI: "minimax",
  "deepseek-ai": "deepseek",
};

const modelMetadataFilesByProvider = new Map<string, Set<string>>();

const NebiusPricing = z.object({
  prompt: z.string().optional(),
  completion: z.string().optional(),
}).passthrough();

const NebiusArchitecture = z.object({
  modality: z.string(),
  tokenizer: z.string().optional(),
}).passthrough();

export const NebiusModel = z.object({
  id: z.string(),
  name: z.string().optional(),
  created: z.number().optional(),
  context_length: z.number().optional(),
  architecture: NebiusArchitecture.optional(),
  pricing: NebiusPricing.optional(),
  supported_features: z.array(z.string()).optional(),
  supported_sampling_parameters: z.array(z.string()).optional(),
}).passthrough();

export const NebiusResponse = z.object({
  data: z.array(NebiusModel),
}).passthrough();

export type NebiusModel = z.infer<typeof NebiusModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

const KNOWN_MODALITIES = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);

export const nebius = {
  id: "nebius",
  name: "Nebius Token Factory",
  modelsDir: "providers/nebius/models",
  async fetchModels() {
    const key = process.env.NEBIUS_API_KEY;
    if (key === undefined) throw new Error("Nebius sync requires NEBIUS_API_KEY");

    const url = new URL(API_ENDPOINT);
    // `verbose=true` is required for pricing, context length, modality, and feature
    // metadata; the default response only includes bare model IDs.
    url.searchParams.set("verbose", "true");

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      throw new Error(`Nebius models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return NebiusResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildNebiusModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<NebiusModel>;

export function buildNebiusModel(
  model: NebiusModel,
  existing: ExistingModel | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const features = new Set(model.supported_features ?? []);
  const samplingParameters = new Set(model.supported_sampling_parameters ?? []);
  const { input, output } = parseModality(model.architecture?.modality, existing?.modalities);
  const name = modelName(model, existing);
  const attachment = input.some((value) => value !== "text");
  const reasoning = features.has("reasoning");
  const toolCall = features.has("tools");
  const structuredOutput = features.has("structured_outputs");
  // Nebius omits `supported_sampling_parameters` entirely for some model families;
  // an empty list is ambiguous, so fall back to the existing flag in that case.
  const temperature = samplingParameters.size > 0
    ? samplingParameters.has("temperature")
    : existing?.temperature ?? true;
  const context = model.context_length ?? existing?.limit?.context ?? 0;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: existing?.limit?.output,
  };
  const releaseDate = existing?.release_date ?? today;
  const canonical = existing?.base_model ?? resolveCanonicalBaseModel(model.id);

  if (canonical !== undefined) {
    return factorBaseModel(
      canonical,
      {
        name: existing === undefined ? name : undefined,
        attachment,
        reasoning,
        // The API only exposes a boolean `reasoning` capability, not the toggle/effort
        // mechanism, so any reasoning_options are curated by hand and preserved as-is.
        reasoning_options: existing?.reasoning_options,
        temperature,
        tool_call: toolCall,
        structured_output: structuredOutput,
        status: existing?.status,
        interleaved: existing?.interleaved,
        limit,
        modalities: { input, output },
        cost: cost(model, existing),
      },
      limit,
      existing?.base_model === canonical ? existing.base_model_omit : undefined,
    );
  }

  return {
    name,
    family: existing?.family ?? inferFamily(model.id, name),
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? today,
    attachment,
    reasoning,
    reasoning_options: existing?.reasoning_options,
    temperature,
    tool_call: toolCall,
    structured_output: structuredOutput,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? true,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost: cost(model, existing),
    limit: {
      input: limit.input,
      context: limit.context,
      // No authoritative output limit is available without canonical metadata;
      // fall back to the served context length, same as OpenRouter's convention.
      output: limit.output ?? context,
    },
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

function modelName(model: NebiusModel, existing: ExistingModel | undefined) {
  // Nebius occasionally bakes the org prefix into `name` (e.g. "openbmb/MiniCPM-V-4_5");
  // strip any such prefix rather than let it leak into the catalog.
  const raw = model.name ?? existing?.name ?? model.id;
  return raw.split("/").at(-1) ?? raw;
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

function cost(model: NebiusModel, existing: ExistingModel | undefined) {
  const input = price(model.pricing?.prompt);
  const output = price(model.pricing?.completion);
  if (input === undefined || output === undefined) return existing?.cost;

  return {
    input,
    output,
    // Cache pricing is not exposed by the Models API; existing ratios are curated by hand.
    reasoning: existing?.cost?.reasoning,
    cache_read: existing?.cost?.cache_read,
    cache_write: existing?.cost?.cache_write,
    tiers: existing?.cost?.tiers,
  };
}

function parseModality(
  modality: string | undefined,
  fallback: ExistingModel["modalities"],
) {
  const [rawInput, rawOutput] = (modality ?? "text->text").split("->");
  return {
    input: parseModalityPart(rawInput, fallback?.input ?? ["text"]),
    output: parseModalityPart(rawOutput, fallback?.output ?? ["text"]),
  };
}

function parseModalityPart(part: string | undefined, fallback: Modality[]): Modality[] {
  const values = (part ?? "")
    .split("+")
    .map((value) => value.trim().toLowerCase())
    // Nebius reports embedding models as `text->embedding`; the catalog schema has no
    // embedding modality, and embedding models are catalogued as text-in/text-out.
    .map((value) => (value === "embedding" ? "text" : value))
    .filter((value): value is Modality => KNOWN_MODALITIES.has(value as Modality));

  return [...new Set(values.length > 0 ? values : fallback)];
}

function inferFamily(id: string, name: string) {
  const kimiFamily = inferKimiFamily(id, name);
  if (kimiFamily !== undefined) return kimiFamily;

  const target = `${id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

export function resolveCanonicalBaseModel(nebiusID: string): string | undefined {
  const [org, ...modelParts] = nebiusID.split("/");
  if (org === undefined || modelParts.length === 0) return undefined;

  const provider = NEBIUS_ORG_TO_MODEL_PROVIDER[org];
  if (provider === undefined) return undefined;

  const modelID = modelParts.join("/");
  const candidates = [...new Set([modelID, modelID.toLowerCase()])];
  const match = candidates.find((candidate) => modelMetadataExists(provider, candidate));

  return match === undefined ? undefined : `${provider}/${match}`;
}

function modelMetadataExists(provider: string, modelID: string) {
  let files = modelMetadataFilesByProvider.get(provider);
  if (files === undefined) {
    try {
      files = new Set(readdirSync(path.join(MODELS_DIR, provider)));
    } catch {
      files = new Set();
    }
    modelMetadataFilesByProvider.set(provider, files);
  }
  return files.has(`${modelID}.toml`);
}
