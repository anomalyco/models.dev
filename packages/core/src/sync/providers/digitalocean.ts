import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const MODELS_API = "https://api.digitalocean.com/v2/gen-ai/models?per_page=200";
const PRICING_API = "https://www.digitalocean.com/api/static-content/v1/products";

export const DigitalOceanModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lifecycle_status: z.string(),
  type: z.string().optional(),
  thinking: z.boolean().optional(),
  context_window: z.union([z.number(), z.string()]).optional(),
  modalities: z.object({
    input: z.array(z.string()).optional(),
    output: z.array(z.string()).optional(),
  }).optional(),
  settings: z.array(z.object({
    name: z.string(),
    max: z.number().optional(),
    default_value: z.number().optional(),
  })).optional(),
  created_at: z.string().optional(),
}).passthrough();

const DigitalOceanModelsResponse = z.object({
  models: z.array(DigitalOceanModel),
  links: z.object({
    pages: z.object({
      next: z.string().nullable().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const PricingEntry = z.object({
  name: z.string(),
  slug: z.string(),
  model: z.string(),
  prompt_tokens: z.string().optional(),
  price: z.object({ rate: z.number() }),
}).passthrough();

const DigitalOceanPricingResponse = z.object({
  gradient: z.object({ models: z.array(PricingEntry) }),
}).passthrough();

const DigitalOceanResponse = z.object({
  models: z.array(DigitalOceanModel),
  pricing: z.array(PricingEntry),
});

export type DigitalOceanModel = z.infer<typeof DigitalOceanModel>;
type PricingEntry = z.infer<typeof PricingEntry>;

interface ModelPricing {
  input?: number;
  output?: number;
  inputOver200k?: number;
  outputOver200k?: number;
}

export interface DigitalOceanSourceModel extends DigitalOceanModel {
  pricing?: ModelPricing;
}

const PRICING_NAME_OVERRIDES: Record<string, string> = {
  "claude sonnet 4.6": "anthropic-claude-4.6-sonnet",
  "claude sonnet 4.5": "anthropic-claude-4.5-sonnet",
  "claude sonnet 4": "anthropic-claude-sonnet-4",
  "claude haiku 4.5": "anthropic-claude-haiku-4.5",
  "claude opus 4.6": "anthropic-claude-opus-4.6",
  "claude opus 4.5": "anthropic-claude-opus-4.5",
  "claude opus 4.1": "anthropic-claude-4.1-opus",
  "claude opus 4": "anthropic-claude-opus-4",
  "gpt-5.4": "openai-gpt-5.4",
  "gpt-5.4 mini": "openai-gpt-5.4-mini",
  "gpt-5.4 nano": "openai-gpt-5.4-nano",
  "gpt-5.4 pro": "openai-gpt-5.4-pro",
  "gpt-5.3-codex": "openai-gpt-5.3-codex",
  "gpt-5.2": "openai-gpt-5.2",
  "gpt-5.2 pro": "openai-gpt-5.2-pro",
  "gpt-5.1-codex-max": "openai-gpt-5.1-codex-max",
  "gpt-5": "openai-gpt-5",
  "gpt-5 mini": "openai-gpt-5-mini",
  "gpt-5 nano": "openai-gpt-5-nano",
  "gpt-4.1": "openai-gpt-4.1",
  "gpt image 1": "openai-gpt-image-1",
  "gpt image 1.5": "openai-gpt-image-1.5",
  "gpt-oss-120b": "openai-gpt-oss-120b",
  "gpt-oss-20b": "openai-gpt-oss-20b",
  "gpt-4o": "openai-gpt-4o",
  "gpt-4o mini": "openai-gpt-4o-mini",
  o1: "openai-o1",
  "o3-mini": "openai-o3-mini",
  "deepseek r1 distill llama 70b": "deepseek-r1-distill-llama-70b",
  "llama 3.3 70b": "llama3.3-70b-instruct",
  "qwen3-32b": "alibaba-qwen3-32b",
  "minimax m2.5": "minimax-m2.5",
  "kimi k2.5": "kimi-k2.5",
  "nvidia nemotron 3 super 120b": "nvidia-nemotron-3-super-120b",
  "glm 5": "glm-5",
};

export const digitalocean = {
  id: "digitalocean",
  name: "DigitalOcean",
  modelsDir: "providers/digitalocean/models",
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} DigitalOcean text models could not be translated because required metadata was unavailable.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local DigitalOcean models were outside the managed text-model catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.DIGITALOCEAN_API_TOKEN || process.env.DIGITALOCEAN_ACCESS_TOKEN;
    if (!key) {
      throw new Error("DigitalOcean sync requires DIGITALOCEAN_API_TOKEN or DIGITALOCEAN_ACCESS_TOKEN");
    }
    return fetchDigitalOceanModels(key);
  },
  parseModels(raw) {
    return parseDigitalOceanModels(raw);
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const contextWindow = number(model.context_window);
    const outputLimit = model.settings?.find((setting) => setting.name === "max_tokens")?.max;
    if (model.pricing?.input === undefined || model.pricing.output === undefined) return undefined;
    if (
      existing === undefined
      && (
        contextWindow === undefined
        || contextWindow <= 0
        || outputLimit === undefined
        || outputLimit <= 0
      )
    ) return undefined;
    const baseModel = existing === undefined
      ? resolveDigitalOceanBaseModel(model.id)
      : existing.base_model;
    return {
      id: model.id,
      model: buildDigitalOceanModel(model, existing, baseModel),
    };
  },
} satisfies SyncProvider<DigitalOceanSourceModel>;

export async function fetchDigitalOceanModels(key: string, fetcher: typeof fetch = fetch) {
  const [models, pricingResponse] = await Promise.all([
    fetchAllDigitalOceanModels(key, fetcher),
    fetcher(PRICING_API, {
      headers: { "User-Agent": "models.dev/digitalocean-sync" },
    }),
  ]);

  if (!pricingResponse.ok) {
    throw new Error(`DigitalOcean pricing request failed: ${pricingResponse.status} ${pricingResponse.statusText}`);
  }

  const pricing = DigitalOceanPricingResponse.parse(await pricingResponse.json()).gradient.models;
  return { models, pricing };
}

async function fetchAllDigitalOceanModels(key: string, fetcher: typeof fetch) {
  const models: DigitalOceanModel[] = [];
  const visited = new Set<string>();
  let url: string | undefined = MODELS_API;

  while (url !== undefined) {
    if (visited.has(url)) throw new Error(`DigitalOcean models pagination repeated URL: ${url}`);
    visited.add(url);

    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`DigitalOcean models request failed: ${response.status} ${response.statusText}`);
    }

    const page = DigitalOceanModelsResponse.parse(await response.json());
    models.push(...page.models);
    const next = page.links?.pages?.next;
    url = next ? new URL(next, url).toString() : undefined;
  }
  return models;
}

export function parseDigitalOceanModels(raw: unknown): DigitalOceanSourceModel[] {
  const response = DigitalOceanResponse.parse(raw);
  const pricing = buildPricingMap(response.pricing, response.models);
  return response.models
    .filter(isManagedTextModel)
    .map((model) => ({ ...model, pricing: pricing.get(model.id) }));
}

function isManagedTextModel(model: DigitalOceanModel) {
  const output = normalizeModalities(model.modalities?.output ?? [], []);
  return output.includes("text") && model.type !== "embedding" && model.type !== "reranking";
}

function pricingName(value: string) {
  return value
    .replace(/\s+(input|output)\s+tokens$/i, "")
    .replace(/\s*\(public preview\)\s*/i, " ")
    .trim()
    .toLowerCase();
}

function normalizedName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function buildPricingMap(entries: PricingEntry[], models: DigitalOceanModel[]) {
  const names = new Map<string, string[]>();
  for (const model of models) {
    const key = normalizedName(model.name);
    names.set(key, [...names.get(key) ?? [], model.id]);
  }

  const result = new Map<string, ModelPricing>();
  for (const entry of entries) {
    const name = pricingName(entry.name);
    const matches = names.get(normalizedName(name)) ?? [];
    const id = PRICING_NAME_OVERRIDES[name] ?? (matches.length === 1 ? matches[0] : undefined);
    if (id === undefined) continue;

    const price = Math.round(entry.price.rate * 10_000) / 10_000;
    const current = result.get(id) ?? {};
    const input = /\sinput\s+tokens$/i.test(entry.name);
    const over200k = entry.prompt_tokens === ">200k";
    if (input && over200k) current.inputOver200k = price;
    else if (!input && over200k) current.outputOver200k = price;
    else if (input) current.input = price;
    else current.output = price;
    result.set(id, current);
  }
  return result;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function normalizeModalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const normalized = values
    .map((value) => value.toLowerCase())
    .map((value) => value === "code" ? "text" : value)
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(normalized.length > 0 ? normalized : fallback)];
}

function number(value: string | number | undefined) {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function inferFamily(id: string, name: string) {
  const kimi = inferKimiFamily(id, name);
  if (kimi !== undefined) return kimi;
  const target = `${id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => target.includes(family.toLowerCase()));
}

function cost(model: DigitalOceanSourceModel, existing: ExistingModel | undefined) {
  const input = model.pricing?.input ?? existing?.cost?.input;
  const output = model.pricing?.output ?? existing?.cost?.output;
  if (input === undefined || output === undefined) return existing?.cost;

  const existingTiers = existing?.cost?.tiers ?? [];
  const longContext = existingTiers.find((tier) =>
    (tier.tier.type === undefined || tier.tier.type === "context") && tier.tier.size >= 200_000
  );
  const hasLongContextPricing = model.pricing?.inputOver200k !== undefined
    && model.pricing.outputOver200k !== undefined;
  const tiers = hasLongContextPricing
    ? [
        ...existingTiers.filter((tier) => tier !== longContext),
        {
          tier: { type: "context" as const, size: longContext?.tier.size ?? 200_000 },
          input: model.pricing!.inputOver200k!,
          output: model.pricing!.outputOver200k!,
          reasoning: longContext?.reasoning,
          cache_read: longContext?.cache_read,
          cache_write: longContext?.cache_write,
        },
      ]
    : existingTiers;

  return {
    input,
    output,
    reasoning: existing?.cost?.reasoning,
    cache_read: existing?.cost?.cache_read,
    cache_write: existing?.cost?.cache_write,
    input_audio: existing?.cost?.input_audio,
    output_audio: existing?.cost?.output_audio,
    tiers: tiers.length > 0 ? tiers : undefined,
  };
}

export function buildDigitalOceanModel(
  model: DigitalOceanSourceModel,
  existing: ExistingModel | undefined,
  baseModel = existing === undefined ? resolveDigitalOceanBaseModel(model.id) : existing.base_model,
): SyncedModel {
  const input = normalizeModalities(
    model.modalities?.input ?? [],
    existing?.modalities?.input ?? ["text"],
  );
  const output = normalizeModalities(
    model.modalities?.output ?? [],
    existing?.modalities?.output ?? ["text"],
  );
  const context = number(model.context_window) ?? existing?.limit?.context ?? 0;
  const maxTokens = model.settings?.find((setting) => setting.name === "max_tokens")?.max;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: maxTokens ?? existing?.limit?.output ?? 0,
  };
  const textOutput = output.includes("text") && !output.includes("image") && !output.includes("video");
  const reasoning = existing?.reasoning ?? (textOutput && (model.thinking ?? false));
  const releaseDate = existing?.release_date ?? model.created_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const values: Partial<SyncedFullModel> = {
    name: model.name,
    description: existing?.description ?? describeModel({
      id: model.id,
      name: model.name,
      family: existing?.family ?? inferFamily(model.id, model.name),
      reasoning,
      tool_call: existing?.tool_call ?? textOutput,
      structured_output: existing?.structured_output,
      open_weights: existing?.open_weights ?? false,
      limit,
      modalities: { input, output },
    }),
    family: existing?.family ?? inferFamily(model.id, model.name),
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment: existing?.attachment ?? input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: existing?.reasoning_options,
    temperature: existing?.temperature ?? true,
    tool_call: existing?.tool_call ?? textOutput,
    structured_output: existing?.structured_output,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status: model.lifecycle_status === "end_of_life"
      ? "deprecated"
      : existing?.status === "deprecated" ? undefined : existing?.status,
    interleaved: existing?.interleaved,
    cost: cost(model, existing),
    limit,
    modalities: { input, output },
    provider: existing?.provider,
    experimental: existing?.experimental,
  };

  if (baseModel !== undefined) {
    return factorBaseModel(baseModel, {
      name: model.name,
      description: existing?.description,
      attachment: input.some((value) => value !== "text"),
      reasoning: model.thinking ?? existing?.reasoning,
      reasoning_options: existing?.reasoning_options,
      temperature: existing?.temperature,
      tool_call: existing?.tool_call,
      structured_output: existing?.structured_output,
      status: model.lifecycle_status === "end_of_life"
        ? "deprecated"
        : existing?.status === "deprecated" ? undefined : existing?.status,
      interleaved: existing?.interleaved,
      cost: cost(model, existing),
      limit,
      modalities: { input, output },
      provider: existing?.provider,
      experimental: existing?.experimental,
    }, limit, existing?.base_model_omit);
  }

  const required = z.object({
    name: z.string(),
    description: z.string(),
    release_date: z.string(),
    last_updated: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    tool_call: z.boolean(),
    open_weights: z.boolean(),
    cost: z.object({ input: z.number(), output: z.number() }),
    limit: z.object({ context: z.number().nonnegative(), output: z.number().nonnegative() }),
    modalities: z.object({ input: z.array(z.string()).min(1), output: z.array(z.string()).min(1) }),
  }).safeParse(values);
  if (!required.success) {
    throw new Error(`DigitalOcean model ${model.id} has incomplete metadata required for sync`);
  }
  return values as SyncedFullModel;
}

export function resolveDigitalOceanBaseModel(id: string) {
  const candidates: string[] = [];
  if (id.startsWith("openai-")) candidates.push(`openai/${id.slice("openai-".length)}`);
  if (id.startsWith("deepseek-")) {
    candidates.push(`deepseek/${id}`);
    candidates.push(`deepseek/${id.replace(/^deepseek-4-/, "deepseek-v4-")}`);
  }
  if (id.startsWith("glm-")) candidates.push(`zai/${id}`);
  if (id.startsWith("kimi-")) candidates.push(`moonshotai/${id}`);
  if (id.startsWith("minimax-")) candidates.push(`minimax/${id}`);
  if (id.startsWith("nvidia-")) candidates.push(`nvidia/${id.slice("nvidia-".length)}`);
  if (id.startsWith("alibaba-")) candidates.push(`qwen/${id.slice("alibaba-".length)}`);
  if (id.startsWith("qwen")) candidates.push(`qwen/${id}`);
  if (id.startsWith("llama")) candidates.push(`meta/${id}`);
  if (id.startsWith("mistral") || id.startsWith("ministral")) candidates.push(`mistralai/${id}`);

  const anthropic = id.match(/^anthropic-claude-(\d+(?:\.\d+)?)-(opus|sonnet|haiku)$/);
  if (anthropic !== null) {
    candidates.push(`anthropic/claude-${anthropic[2]}-${anthropic[1]}`);
  }
  if (id.startsWith("anthropic-")) candidates.push(`anthropic/${id.slice("anthropic-".length)}`);

  for (const candidate of candidates) {
    const resolved = resolveCanonicalBaseModel(candidate);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}
