import { z } from "zod";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://openrouter.ai/api/v1/models";
const PROVIDERS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "providers");
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const modelFilesByProvider = new Map<string, Set<string>>();
const modelMetadataByID = new Map<string, Record<string, unknown>>();

const CANONICAL_PROVIDER_PREFIXES = {
  anthropic: { provider: "anthropic", metadata: "anthropic" },
  cohere: { provider: "cohere", metadata: "cohere" },
  deepseek: { provider: "deepseek", metadata: "deepseek" },
  google: { provider: "google", metadata: "google" },
  meta: { provider: "llama", metadata: "meta" },
  "meta-llama": { provider: "llama", metadata: "meta" },
  minimax: { provider: "minimax", metadata: "minimax" },
  mistralai: { provider: "mistral", metadata: "mistral" },
  moonshotai: { provider: "moonshotai", metadata: "moonshotai" },
  openai: { provider: "openai", metadata: "openai" },
  "x-ai": { provider: "xai", metadata: "xai" },
  xai: { provider: "xai", metadata: "xai" },
  xiaomi: { provider: "xiaomi", metadata: "xiaomi" },
  zai: { provider: "zai", metadata: "zai" },
  "z-ai": { provider: "zai", metadata: "zai" },
} as const;

export const OpenRouterModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  hugging_face_id: z.string().nullable(),
  knowledge_cutoff: z.string().nullable(),
  context_length: z.number(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    internal_reasoning: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }),
  top_provider: z.object({
    context_length: z.number().nullable(),
    max_completion_tokens: z.number().nullable(),
  }),
  supported_parameters: z.array(z.string()),
});

export const OpenRouterResponse = z.object({
  data: z.array(OpenRouterModel),
}).passthrough();

export type OpenRouterModel = z.infer<typeof OpenRouterModel>;

export const openrouter = {
  id: "openrouter",
  name: "OpenRouter",
  modelsDir: "providers/openrouter/models",
  async fetchModels() {
    const headers = process.env.OPENROUTER_API_KEY
      ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return OpenRouterResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildOpenRouterModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<OpenRouterModel>;

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
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

function inferFamily(model: OpenRouterModel, name: string) {
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

export function buildOpenRouterModel(model: OpenRouterModel, existing: ExistingModel | undefined): SyncedModel {
  const params = new Set(model.supported_parameters);
  const name = model.name.replace(/^[^:]+:\s+/, "");
  const input = modalities(model.architecture.input_modalities, ["text"]);
  const output = modalities(model.architecture.output_modalities, ["text"]);
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = params.has("reasoning") || params.has("include_reasoning");
  const context = model.top_provider.context_length ?? model.context_length;
  const family = inferFamily(model, name);
  const releaseDate = dateFromTimestamp(model.created);
  const familyValue = existing?.family === "o" && family !== "o"
    ? family
    : (existing?.family ?? family);
  const attachment = input.some((value) => value !== "text");
  const toolCall = params.has("tools") || params.has("tool_choice");
  const structuredOutput = params.has("structured_outputs");
  const knowledge = model.knowledge_cutoff?.slice(0, 10) ?? existing?.knowledge;
  const openWeights = Boolean(model.hugging_face_id);
  const cost = prompt !== undefined && completion !== undefined
    ? {
        input: prompt,
        output: completion,
        reasoning: reasoning ? price(model.pricing.internal_reasoning) : undefined,
        cache_read: price(model.pricing.input_cache_read),
        cache_write: price(model.pricing.input_cache_write),
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: model.top_provider.max_completion_tokens ?? existing?.limit?.output ?? context,
  };
  const canonical = resolveCanonicalModel(model.id);

  if (canonical !== undefined) {
    return {
      base_model: canonical.from,
      base_model_omit: baseModelOmit(canonical.from, limit),
      ...baseModelRuntimeOverrides(canonical.from, {
        name: model.id.endsWith(":free") ? name : undefined,
        attachment,
        reasoning,
      }),
      temperature: params.has("temperature"),
      tool_call: toolCall,
      structured_output: structuredOutput,
      status: existing?.status,
      interleaved: existing?.interleaved,
      cost,
      limit,
      modalities: { input, output },
    };
  }

  return {
    name,
    family: familyValue,
    release_date: releaseDate,
    last_updated: releaseDate,
    attachment,
    reasoning,
    temperature: params.has("temperature"),
    tool_call: toolCall,
    structured_output: structuredOutput,
    knowledge,
    open_weights: openWeights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

function resolveCanonicalModel(openrouterID: string) {
  const [prefix, ...modelParts] = openrouterID.split("/");
  if (prefix === undefined || modelParts.length === 0) return undefined;
  if (openrouterID.startsWith("~/") || prefix.startsWith("~")) return undefined;

  const canonical = CANONICAL_PROVIDER_PREFIXES[prefix as keyof typeof CANONICAL_PROVIDER_PREFIXES];
  if (canonical === undefined) return undefined;

  const modelID = modelParts.join("/").replace(/:free$/, "");
  const candidates = canonicalCandidates(canonical.provider, modelID);
  const match = candidates.find((candidate) => {
    return canonicalModelExists(canonical.provider, candidate) &&
      modelMetadataExists(canonical.metadata, candidate);
  });

  return match === undefined
    ? undefined
    : {
        from: `${canonical.metadata}/${match}`,
        provider: canonical.provider,
        modelID: match,
      };
}

function canonicalModelExists(provider: string, modelID: string) {
  let files = modelFilesByProvider.get(provider);
  if (files === undefined) {
    try {
      files = new Set(readdirSync(path.join(PROVIDERS_DIR, provider, "models")));
    } catch {
      files = new Set();
    }
    modelFilesByProvider.set(provider, files);
  }
  return files.has(`${modelID}.toml`);
}

function modelMetadataExists(provider: string, modelID: string) {
  return existsSync(path.join(MODELS_DIR, provider, `${modelID}.toml"));
}

function baseModelOmit(
  modelID: string,
  limit: SyncedFullModel["limit"],
) {
  const metadata = modelMetadata(modelID);
  const omit: string[] = [];
  const baseLimit = metadata.limit;
  if (
    baseLimit !== undefined &&
    baseLimit !== null &&
    typeof baseLimit === "object" &&
    !Array.isArray(baseLimit) &&
    (baseLimit as Record<string, unknown>).input !== undefined &&
    limit.input === undefined
  ) {
    omit.push("limit.input");
  }

  return omit.length > 0 ? omit : undefined;
}

function baseModelRuntimeOverrides(
  modelID: string,
  values: Pick<SyncedFullModel, "name" | "attachment" | "reasoning">,
) {
  const metadata = modelMetadata(modelID);
  return Object.fromEntries(
    Object.entries(values).filter(([key, value]) => value !== undefined && metadata[key] !== value),
  );
}

function modelMetadata(modelID: string) {
  let metadata = modelMetadataByID.get(modelID);
  if (metadata === undefined) {
    const filePath = path.join(MODELS_DIR, `${modelID}.toml`);
    metadata = Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    modelMetadataByID.set(modelID, metadata);
  }
  return metadata;
}

function canonicalCandidates(provider: string, modelID: string) {
  const candidates = [modelID];

  if (provider === "anthropic") {
    candidates.push(modelID.replace(/(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)/, "$1-$2"));
    candidates.push(modelID.replace(/^claude-3\.5-/, "claude-3-5-"));
  }

  if (provider === "llama") {
    candidates.push(modelID.replace(/^llama-(\d+)-(\d+)/, "llama-$1.$2"));
    candidates.push(modelID.replace(/^llama-(4)-(maverick|scout)$/, "llama-$1-$2-17b"));
  }

  if (provider === "mistral") {
    candidates.push(modelID.replace(/-latest$/, ""));
  }

  if (provider === "minimax") {
    candidates.push(modelID.replace(/^minimax-m/, "MiniMax-M"));
  }

  return [...new Set(candidates)];
}
