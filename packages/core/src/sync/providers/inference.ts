import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, modelMetadata } from "./openrouter.js";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

const API_ENDPOINT = "https://api.inference.net/v1/models";

const TOKENS_PER_PRICING_UNIT = 1_000_000;

const MIN_LIVE_MODELS = 20;

// Namespaced IDs whose namespace differs from the lab directory under models/.
const LAB_NAMESPACE: Record<string, string> = {
  "z-ai": "zhipuai",
};

// Most IDs carry no namespace; the lab is read from the model family prefix.
const LAB_BY_PREFIX: [prefix: string, lab: string][] = [
  ["claude-", "anthropic"],
  ["gpt-", "openai"],
  ["gemini-", "google"],
  ["gemma-", "google"],
  ["deepseek-", "deepseek"],
  ["glm-", "zhipuai"],
  ["kimi-", "moonshotai"],
  ["grok-", "xai"],
  ["qwen", "alibaba"],
  ["llama-", "meta"],
  ["nemotron-", "nvidia"],
];

const InferencePricing = z.object({
  prompt: z.string(),
  completion: z.string(),
  input_cache_read: z.string().optional(),
}).passthrough();

export const InferenceModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  context_length: z.number().int().positive(),
  max_completion_tokens: z.number().int().positive(),
  reasoning_efforts: z.array(z.string()).nonempty().optional(),
  pricing: InferencePricing,
}).passthrough();

export const InferenceResponse = z.object({
  object: z.literal("list"),
  data: z.array(InferenceModel),
}).passthrough();

export type InferenceModel = z.infer<typeof InferenceModel>;

export const inference = {
  id: "inference",
  name: "Inference",
  modelsDir: "providers/inference/models",
  // A create is only skipped when no lab entry exists to base it on.
  missingModelID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Inference models have no lab entry under models/ to base them on: `
        + ids.map((id) => `\`${id}\``).join(", "),
    ];
  },
  async fetchModels() {
    return fetchInferenceModels();
  },
  parseModels(raw) {
    return InferenceResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing !== undefined) return { id: model.id, model: buildInferenceModel(model, existing) };
    const baseModel = labModelID(model.id);
    if (!existsSync(path.join(MODELS_DIR, `${baseModel}.toml`))) return undefined;
    return { id: model.id, model: buildInferenceModel(model, { base_model: baseModel } as ExistingModel) };
  },
} satisfies SyncProvider<InferenceModel>;

export async function fetchInferenceModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Inference models request failed: ${response.status} ${response.statusText}`);
  }
  const parsed = InferenceResponse.parse(await response.json());
  if (parsed.data.length < MIN_LIVE_MODELS) {
    throw new Error(
      `Inference returned ${parsed.data.length} models, below the ${MIN_LIVE_MODELS} needed to`
        + ` distinguish a retirement from a truncated response`,
    );
  }
  return parsed;
}

export function labModelID(id: string): string {
  const lowered = id.toLowerCase();
  const separator = lowered.lastIndexOf("/");
  if (separator !== -1) {
    const namespace = lowered.slice(0, separator);
    return `${LAB_NAMESPACE[namespace] ?? namespace}${lowered.slice(separator)}`;
  }
  const lab = LAB_BY_PREFIX.find(([prefix]) => lowered.startsWith(prefix))?.[1];
  return lab === undefined ? lowered : `${lab}/${lowered}`;
}

// Pricing strings are USD per token; the catalog stores USD per million tokens.
function perMillion(value: string): number {
  return Number((Number(value) * TOKENS_PER_PRICING_UNIT).toFixed(6));
}

// The endpoint is authoritative for price, serving limits, and reasoning
// controls: `reasoning_efforts` is the exact set `reasoning_effort` accepts on
// this host, with `none` turning reasoning off, so it maps to a single effort
// option and never a toggle. Capabilities and modalities stay inherited.
export function buildInferenceModel(model: InferenceModel, existing: ExistingModel): SyncedModel {
  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const inherited = baseModel === undefined ? {} : modelMetadata(baseModel);

  const cost = {
    ...current.cost,
    input: perMillion(model.pricing.prompt),
    output: perMillion(model.pricing.completion),
    ...(model.pricing.input_cache_read === undefined
      ? {}
      : { cache_read: perMillion(model.pricing.input_cache_read) }),
  };

  // Some routes report a completion cap above their context window.
  const limit = {
    ...current.limit,
    context: model.context_length,
    output: Math.min(model.max_completion_tokens, model.context_length),
  };

  const reasons = (current.reasoning ?? inherited.reasoning) === true;
  let reasoning: Pick<SyncedFullModel, "reasoning" | "reasoning_options">;
  if (model.reasoning_efforts !== undefined) {
    reasoning = { reasoning: true, reasoning_options: [{ type: "effort", values: model.reasoning_efforts }] };
  } else if (!reasons) {
    reasoning = { reasoning: false, reasoning_options: undefined };
  } else if (current.reasoning_options !== undefined) {
    reasoning = { reasoning: true, reasoning_options: current.reasoning_options };
  } else {
    throw new MissingReasoningOptionsError(
      model.id,
      `reasoning model (base ${baseModel}) that Inference's /v1/models lists no reasoning_efforts`
        + " for; probe the route and author its reasoning_options by hand",
    );
  }

  const values = { ...current, cost, limit, ...reasoning } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}
