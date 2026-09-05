import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://router.shengsuanyun.com/api/v1/models";

const Pricing = z.object({
  prompt: z.number().nonnegative().optional(),
  completion: z.number().nonnegative().optional(),
  cache: z.number().nonnegative().optional(),
}).passthrough();

const Architecture = z.object({
  input: z.string().optional(),
  output: z.string().optional(),
}).passthrough();

export const ShengSuanYunModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  context_window: z.number().int().nonnegative().optional(),
  max_tokens: z.number().int().nonnegative().optional(),
  architecture: Architecture.optional(),
  pricing: Pricing.optional(),
}).passthrough();

export const ShengSuanYunResponse = z.object({
  data: z.array(ShengSuanYunModel),
}).passthrough();

export type ShengSuanYunModel = z.infer<typeof ShengSuanYunModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

// ShengSuanYun's org prefixes generally do not match the canonical `models/`
// provider directories used by resolveModelMetadataBaseModel; remap them
// before delegating to the shared resolver.
const PREFIX_REMAP: Record<string, string | undefined> = {
  ali: "alibaba",
  bigmodel: "zhipuai",
  bytedance: "bytedance-seed",
  longcat: "meituan",
};

// Aliases for IDs that resolve to a versioned canonical file rather than the
// bare name (mirrors the pattern in nano-gpt.ts's BASE_MODEL_ALIASES).
const BASE_MODEL_ALIASES: Record<string, string | undefined> = {
  "anthropic/claude-opus-4": "anthropic/claude-opus-4-0",
  "anthropic/claude-sonnet-4": "anthropic/claude-sonnet-4-0",
};

const VARIANT_SUFFIX = /:thinking$/i;
const STRIP_SUFFIXES = [/-latest$/, /-high$/];

export const shengsuanyun = {
  id: "shengsuanyun",
  name: "ShengSuanYun",
  modelsDir: "providers/shengsuanyun/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`ShengSuanYun models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return ShengSuanYunResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildShengSuanYunModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<ShengSuanYunModel>;

export function buildShengSuanYunModel(
  model: ShengSuanYunModel,
  existing: ExistingModel | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const name = existing?.name ?? cleanName(model.name);
  const hasInputArchitecture = Boolean(model.architecture?.input);
  const hasOutputArchitecture = Boolean(model.architecture?.output);
  const input = normalizeModalities(model.architecture?.input);
  const output = normalizeModalities(model.architecture?.output);
  const attachment = input.some((value) => value !== "text");
  const baseModel = existing?.base_model ?? resolveShengSuanYunBaseModel(model.id);

  const context = model.context_window ?? existing?.limit?.context ?? 0;
  const output_limit = model.max_tokens ?? existing?.limit?.output ?? 0;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: output_limit,
  };

  const prompt = model.pricing?.prompt;
  const completion = model.pricing?.completion;
  const cache = model.pricing?.cache;
  const cost = prompt !== undefined && completion !== undefined
    ? {
        input: prompt/6.7,
        output: completion/6.7,
        cache_read: cache !== undefined && cache > 0 ? cache/6.7 : undefined,
      }
    : existing?.cost;

  const reasoningOptions = getReasoningOptions(model.id);
  const reasoning = reasoningOptions ? true : false;
  if (baseModel !== undefined) {
    return factorBaseModel(
      baseModel,
      {
        name: existing?.name,
        description: existing?.description,
        attachment: hasInputArchitecture ? attachment : existing?.attachment,
        reasoning: reasoning,
        reasoning_options: reasoningOptions? existing?.reasoning_options : undefined,
        status: existing?.status,
        interleaved: existing?.interleaved,
        limit,
        modalities: {
          input: hasInputArchitecture ? input : undefined,
          output: hasOutputArchitecture ? output : undefined,
        },
        cost,
      },
      limit,
      existing?.base_model_omit,
    );
  }

  // The API exposes reasoning only via the `:thinking` ID suffix and gives no
  // signal at all for tool_call/structured_output; tool_call defaults to true
  // (the common case for chat-completions-shaped relays) and structured_output
  // is left unset rather than guessed either way.
  const family = existing?.family ?? inferFamily(model.id, name);
  const toolCall = existing?.tool_call ?? true;

  return {
    name,
    description: existing?.description ?? describeModel({
      id: model.id,
      name,
      family,
      reasoning,
      tool_call: toolCall,
      structured_output: existing?.structured_output,
      open_weights: existing?.open_weights ?? false,
      limit,
      modalities: { input, output },
    }),
    family,
    release_date: existing?.release_date ?? today,
    last_updated: existing?.last_updated ?? today,
    attachment,
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: existing?.temperature ?? true,
    tool_call: toolCall,
    structured_output: existing?.structured_output,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

export function resolveShengSuanYunBaseModel(fullId: string): string | undefined {
  const alias = BASE_MODEL_ALIASES[fullId];
  if (alias !== undefined) return alias;

  const stripped = fullId.replace(VARIANT_SUFFIX, "");
  if (stripped !== fullId) {
    const strippedAlias = BASE_MODEL_ALIASES[stripped];
    if (strippedAlias !== undefined) return strippedAlias;
  }

  const [org, ...rest] = stripped.split("/");
  const modelPart = rest.join("/");
  const remapped = org === undefined ? undefined : PREFIX_REMAP[org];

  if (remapped !== undefined) {
    const candidates = org === "bytedance"
      ? bytedanceCandidates(modelPart)
      : suffixCandidates(modelPart);
    for (const candidate of candidates) {
      const resolved = resolveModelMetadataBaseModel(`${remapped}/${candidate}`);
      if (resolved !== undefined) return resolved;
    }
  }

  for (const candidate of suffixCandidates(stripped)) {
    const resolved = resolveModelMetadataBaseModel(candidate);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

// ShengSuanYun's ByteDance IDs use "doubao-seed-<version>" while the
// canonical bytedance-seed/ files use "seed-<version>" with an inconsistent
// dash/dot separator for the version number (e.g. "seed-2.0-pro" vs
// "seed-1-6"), so both forms are tried.
function bytedanceCandidates(modelPart: string): string[] {
  const match = modelPart.match(/^doubao-seed-(.+)$/);
  if (match === null) return [];
  const rest = match[1]!;
  const dot = rest.replace(/^(\d+)-(\d+)/, "$1.$2");
  const dash = rest.replace(/^(\d+)\.(\d+)/, "$1-$2");
  return [...new Set([`seed-${rest}`, `seed-${dot}`, `seed-${dash}`])];
}

function suffixCandidates(modelPart: string): string[] {
  const candidates = [modelPart];
  for (const suffix of STRIP_SUFFIXES) {
    if (suffix.test(modelPart)) candidates.push(modelPart.replace(suffix, ""));
  }
  return candidates;
}

// Strip zero-width spaces and parenthetical promo/annotation text (e.g.
// "Qwen3.7-Max（限时5折）" -> "Qwen3.7-Max") that ShengSuanYun's display
// names sometimes carry.
function cleanName(name: string): string {
  return name
    .replaceAll("​", "")
    .replaceAll(/[（(][^）)]*[）)]/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function normalizeModalities(value: string | undefined): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const parts = (value ?? "text").split("+").map((part) => part.toLowerCase());
  const result = parts.filter((part): part is Modality => allowed.has(part as Modality));
  return [...new Set(result.length > 0 ? result : ["text"] as Modality[])];
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

type ReasoningOption =
  | { type: "toggle" }
  | { type: "effort"; values: ("none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" | null)[] }
  | { type: "budget_tokens"; max?: number; min?: number };

function getReasoningOptions(id: string): ReasoningOption[] | undefined {
  const exist: Record<string, ReasoningOption[]> = {
    "deepseek/deepseek-v4": [
      { type: "toggle" },
      { type: "effort", values: ["none", "low", "high", "max"] }
    ],
    "deepseek/deepseek-v3": [
      { type: "toggle" },
      { type: "effort", values: ["none", "low", "high", "max"] }
    ],
    "openai/gpt-5.": [
      {
        type: "effort",
        values: ["none", "low", "medium", "high", "xhigh", "max"]
      }
    ],
    "ali/qwen3": [{ type: "toggle" }, { type: "budget_tokens" }],
    "bigmodel/glm-4.7": [{ type: "toggle" }],
    "bigmodel/glm-5": [{ type: "toggle" }],
    "moonshot/kimi": [
      {
        type: "effort",
        values: ["low", "high", "max"]
      }
    ],
    "openai/o": [{ type: "effort", values: ["low", "medium", "high"] }],
    "anthropic/claude": [
      { type: "budget_tokens", "min": 1024 },
      {
        type: "effort",
        values: ["none", "low", "medium", "high", "xhigh", "max"]
      }
    ]
  };

  for (const key in exist) {
    if (id.startsWith(key)) {
      return exist[key];
    }
  }
  return undefined;
}

