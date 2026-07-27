import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

// Public Requesty router catalog. Rich enough for authoritative cost, limits,
// and capability flags. Do not send REQUESTY_API_KEY here — authenticated
// responses are user-specific routing policies, not the shared public catalog.
const API_ENDPOINT = "https://router.requesty.ai/v1/models";

// First-path host/reseller prefixes. After stripping, the remainder is resolved
// against models/ metadata (possibly with a lab alias on the next segment).
const HOST_PREFIXES = new Set([
  "azure",
  "bedrock",
  "coding",
  "deepinfra",
  "doubleword",
  "fireworks",
  "groq",
  "inceptron",
  "nebius",
  "novita",
  "openai-responses",
  "parasail",
  "sference",
  "tensorx",
  "vertex",
]);

// Lab prefixes that differ from models.dev metadata namespaces.
const LAB_ALIASES: Record<string, string> = {
  minimaxi: "minimax",
  moonshot: "moonshotai",
  "x-ai": "xai",
  zai: "zhipuai",
  "zai-org": "zhipuai",
  "z-ai": "zhipuai",
  mistralai: "mistral",
  Qwen: "alibaba",
  qwen: "alibaba",
  "meta-llama": "meta",
  google: "google",
};

export const RequestyModel = z
  .object({
    id: z.string().min(1),
    created: z.number().optional(),
    description: z.string().optional(),
    input_price: z.number().nullish(),
    output_price: z.number().nullish(),
    cached_price: z.number().nullish(),
    caching_price: z.number().nullish(),
    max_output_tokens: z.number().nullish(),
    context_window: z.number().nullish(),
    supports_caching: z.boolean().optional(),
    supports_vision: z.boolean().optional(),
    supports_reasoning: z.boolean().optional(),
    supports_image_generation: z.boolean().optional(),
    supports_tool_calling: z.boolean().optional(),
    supports_output_json_schema: z.boolean().optional(),
    supports_output_json_object: z.boolean().optional(),
    retires_at: z.union([z.string(), z.number()]).nullish(),
    api: z.string().optional(),
  })
  .passthrough();

export const RequestyResponse = z
  .object({
    data: z.array(RequestyModel),
  })
  .passthrough();

export type RequestyModel = z.infer<typeof RequestyModel>;

export const requesty = {
  id: "requesty",
  name: "Requesty",
  modelsDir: "providers/requesty/models",
  async fetchModels() {
    // Intentionally unauthenticated — see API_ENDPOINT comment.
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Requesty request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return RequestyResponse.parse(raw).data.filter((model) => {
      if (model.api !== undefined && model.api !== "chat") return false;
      return true;
    });
  },
  translateModel(model, context) {
    const id = normalizeRequestyID(model.id);
    const existing = context.existing(id);
    if (existing === undefined && isRetired(model)) return undefined;
    const built = buildRequestyModel(model, existing, id);
    if (built === undefined) return undefined;
    return { id, model: built };
  },
} satisfies SyncProvider<RequestyModel>;

// Collapse known parent-path casing drift so macOS/Windows sync stays stable.
// Requesty lists both novita/sao10k/* and novita/Sao10K/*; the lowercase form
// is the majority spelling.
function normalizeRequestyID(id: string) {
  if (id.startsWith("novita/Sao10K/")) {
    return `novita/sao10k/${id.slice("novita/Sao10K/".length)}`;
  }
  return id;
}

function isRetired(model: RequestyModel) {
  const retiresAt = model.retires_at;
  if (retiresAt === undefined || retiresAt === null) return false;
  const timestamp = typeof retiresAt === "number"
    ? (retiresAt > 1e12 ? retiresAt : retiresAt * 1000)
    : Date.parse(retiresAt);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp <= Date.now();
}

function dateFromTimestamp(timestamp: number | undefined) {
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    return new Date().toISOString().slice(0, 10);
  }
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

// Requesty prices are USD per token; catalog uses USD per million tokens.
function price(perToken: number | null | undefined) {
  if (perToken === undefined || perToken === null) return undefined;
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  return Math.round(perToken * 1_000_000_000_000) / 1_000_000;
}

function nonZeroPrice(perToken: number | null | undefined) {
  const result = price(perToken);
  return result !== undefined && result > 0 ? result : undefined;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function deriveName(id: string) {
  const base = id.split("/").at(-1) ?? id;
  const bare = base.split("@")[0] ?? base;
  const withoutVariant = bare.split(":")[0] ?? bare;
  return withoutVariant
    .replace(/[-_]+/g, " ")
    .replace(/\b([a-z])/g, (char) => char.toUpperCase())
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bGlm\b/g, "GLM")
    .replace(/\bQwen\b/g, "Qwen")
    .trim();
}

function inferFamily(id: string, name: string) {
  const kimiFamily = inferKimiFamily(id, name);
  if (kimiFamily !== undefined) return kimiFamily;

  const target = `${id} ${name}`.toLowerCase();
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

/** Strip regional (@region) and routing (:variant) suffixes for metadata lookup. */
function stripRouteSuffixes(id: string) {
  return id.split("@")[0]!.split(":")[0]!;
}

/**
 * Map a Requesty model id onto a models/ metadata entry when one exists.
 * Tries the raw id, host-stripped forms, and lab alias rewrites.
 */
export function resolveRequestyBaseModel(id: string) {
  const candidates = baseModelCandidates(id);
  for (const candidate of candidates) {
    const resolved = resolveCanonicalBaseModel(candidate);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function baseModelCandidates(id: string) {
  const bare = stripRouteSuffixes(id);
  const parts = bare.split("/");
  const out: string[] = [bare];

  if (parts.length >= 2 && HOST_PREFIXES.has(parts[0]!)) {
    out.push(parts.slice(1).join("/"));
  }

  // deepinfra/Qwen/Foo, novita/minimax/minimax-m2.7, nebius/minimaxi/...
  if (parts.length >= 3) {
    const lab = parts[parts.length - 2]!;
    const model = parts[parts.length - 1]!;
    const aliased = LAB_ALIASES[lab] ?? lab.toLowerCase();
    out.push(`${aliased}/${model}`);
    out.push(`${aliased}/${model.toLowerCase()}`);
  }

  if (parts.length === 2) {
    const [lab, model] = parts as [string, string];
    const aliased = LAB_ALIASES[lab] ?? lab;
    if (aliased !== lab) {
      out.push(`${aliased}/${model}`);
      out.push(`${aliased}/${model.toLowerCase()}`);
    }
    // minimaxi/MiniMax-M2.7 → minimax/minimax-m2.7 style
    out.push(`${aliased}/${model.toLowerCase()}`);
  }

  // bedrock/claude-sonnet-4-6 → anthropic/claude-sonnet-4-6
  if (parts[0] === "bedrock" || parts[0] === "vertex" || parts[0] === "coding") {
    const model = parts.slice(1).join("/");
    if (/^claude/i.test(model)) out.push(`anthropic/${model}`);
    if (/^gemini/i.test(model)) out.push(`google/${model}`);
    if (/^minimax/i.test(model)) out.push(`minimax/${model}`);
    if (/^kimi/i.test(model)) out.push(`moonshotai/${model}`);
    if (/^deepseek/i.test(model)) out.push(`deepseek/${model}`);
  }

  return [...new Set(out)];
}

export function buildRequestyModel(
  model: RequestyModel,
  existing: ExistingModel | undefined,
  id = normalizeRequestyID(model.id),
): SyncedModel | undefined {
  const inputCost = price(model.input_price);
  const outputCost = price(model.output_price);
  const context = (model.context_window !== undefined
      && model.context_window !== null
      && model.context_window > 0)
    ? model.context_window
    : existing?.limit?.context;
  if (context === undefined) return undefined;

  const maxOutput = (model.max_output_tokens !== undefined
      && model.max_output_tokens !== null
      && model.max_output_tokens > 0)
    ? model.max_output_tokens
    : existing?.limit?.output ?? context;

  const limit = {
    context,
    input: existing?.limit?.input,
    output: maxOutput,
  };

  const cost = inputCost !== undefined && outputCost !== undefined
    ? {
        input: inputCost,
        output: outputCost,
        cache_read: model.supports_caching === false
          ? undefined
          : nonZeroPrice(model.cached_price) ?? existing?.cost?.cache_read,
        cache_write: model.supports_caching === false
          ? undefined
          : nonZeroPrice(model.caching_price) ?? existing?.cost?.cache_write,
        reasoning: existing?.cost?.reasoning,
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;

  const reasoning = model.supports_reasoning ?? existing?.reasoning ?? false;
  const toolCall = model.supports_tool_calling ?? existing?.tool_call ?? false;
  const structuredOutput = model.supports_output_json_schema
    ?? existing?.structured_output
    ?? false;
  // Requesty normalizes reasoning_effort (none|min|low|medium|high|max) and
  // decimal budget strings across upstream labs. Prefer curated options when
  // present; otherwise surface the gateway controls for reasoning models.
  // Source: https://docs.requesty.ai/features/reasoning
  const reasoningOptions = existing?.reasoning_options
    ?? (reasoning
      ? [
          { type: "effort" as const, values: ["none", "low", "medium", "high", "max"] as const },
          { type: "budget_tokens" as const },
        ]
      : undefined);

  const inputModalities = new Set<Modality>(["text"]);
  if (model.supports_vision) inputModalities.add("image");
  for (const value of existing?.modalities?.input ?? []) {
    if (value === "text" || value === "audio" || value === "image" || value === "video" || value === "pdf") {
      inputModalities.add(value);
    }
  }
  const outputModalities = new Set<Modality>(["text"]);
  if (model.supports_image_generation) outputModalities.add("image");
  for (const value of existing?.modalities?.output ?? []) {
    if (value === "text" || value === "audio" || value === "image" || value === "video" || value === "pdf") {
      outputModalities.add(value);
    }
  }
  const modalities = {
    input: [...inputModalities],
    output: [...outputModalities],
  };
  const attachment = modalities.input.some((value) => value !== "text")
    || modalities.output.some((value) => value !== "text");

  const name = existing?.name ?? deriveName(id);
  const family = existing?.family ?? inferFamily(id, name);
  const releaseDate = existing?.release_date ?? dateFromTimestamp(model.created);
  const lastUpdated = existing?.last_updated ?? releaseDate;
  const status = isRetired(model)
    ? "deprecated" as const
    : existing?.status === "deprecated"
      ? undefined
      : existing?.status;

  const baseModel = existing?.base_model ?? resolveRequestyBaseModel(id);

  if (baseModel !== undefined) {
    return factorBaseModel(
      baseModel,
      {
        name: existing?.name !== undefined && existing.name !== name ? existing.name : undefined,
        description: existing?.description
          ?? (model.description?.trim() || undefined)
          ?? describeModel({
            id,
            name,
            family,
            reasoning,
            tool_call: toolCall,
            structured_output: structuredOutput,
            open_weights: existing?.open_weights,
            limit,
            modalities,
          }),
        attachment,
        reasoning,
        reasoning_options: reasoningOptions,
        temperature: existing?.temperature,
        tool_call: toolCall,
        structured_output: structuredOutput,
        status,
        interleaved: existing?.interleaved,
        knowledge: existing?.knowledge,
        limit,
        modalities,
        cost,
      },
      limit,
      existing?.base_model === baseModel ? existing.base_model_omit : undefined,
    );
  }

  // Full standalone definition when no models/ metadata match exists.
  if (cost === undefined) return undefined;

  return {
    name,
    description: existing?.description
      ?? (model.description?.trim() || undefined)
      ?? describeModel({
        id,
        name,
        family,
        reasoning,
        tool_call: toolCall,
        structured_output: structuredOutput,
        open_weights: existing?.open_weights ?? false,
        limit,
        modalities,
      }),
    family,
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment,
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: existing?.temperature ?? true,
    tool_call: toolCall,
    structured_output: structuredOutput,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities,
  } satisfies SyncedFullModel;
}
