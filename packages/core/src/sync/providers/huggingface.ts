import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";

import { providerModelToV2 } from "../../model-file-v2.js";
import type { SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://router.huggingface.co/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Hugging Face org prefixes mapped to the canonical metadata prefixes understood
// by resolveCanonicalBaseModel. Anything not listed falls back to a direct lookup.
const CANONICAL_ORG_PREFIXES: Record<string, string> = {
  CohereLabs: "cohere",
  "deepseek-ai": "deepseek",
  google: "google",
  "meta-llama": "meta-llama",
  MiniMaxAI: "minimax",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  Qwen: "qwen",
  "stepfun-ai": "stepfun",
  XiaomiMiMo: "xiaomi",
  "zai-org": "zai",
};

const HuggingFaceProvider = z.object({
  provider: z.string(),
  status: z.string(),
  context_length: z.number().int().positive().optional(),
  pricing: z.object({
    input: z.number(),
    output: z.number(),
  }).passthrough().optional(),
  throughput: z.number().nonnegative().optional(),
  first_token_latency_ms: z.number().nonnegative().optional(),
  is_free: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_structured_output: z.boolean().optional(),
  is_model_author: z.boolean().optional(),
}).passthrough();

export const HuggingFaceModel = z.object({
  id: z.string().min(1),
  created: z.number().optional(),
  owned_by: z.string().optional(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }).passthrough(),
  providers: z.array(HuggingFaceProvider),
}).passthrough();

export const HuggingFaceResponse = z.object({
  data: z.array(HuggingFaceModel),
}).passthrough();

export type HuggingFaceModel = z.infer<typeof HuggingFaceModel>;
export type HuggingFaceProvider = z.infer<typeof HuggingFaceProvider>;

export const huggingface = {
  id: "huggingface",
  name: "Hugging Face",
  modelsDir: "providers/huggingface/models",
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Hugging Face Inference Providers models were not created because their IDs could not be mapped to provider-agnostic metadata, had no live provider, or had no priced provider.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Hugging Face models were absent from the Inference Providers catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const headers = process.env.HF_TOKEN
      ? { Authorization: `Bearer ${process.env.HF_TOKEN}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`Hugging Face models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return HuggingFaceResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (!model.providers.some((provider) => provider.status === "live")) return undefined;

    // Existing files are curated (prices differ per inference provider), so the
    // sync only creates new ones and writes existing files back unchanged.
    const v2 = context.v2?.(model.id);
    if (v2 !== undefined) return { id: model.id, v2 };
    const authored = context.authored(model.id);
    if (authored !== undefined) return { id: model.id, model: authored as SyncedModel };

    const baseModel = resolveHuggingFaceBaseModel(model.id);
    if (baseModel === undefined) return undefined;

    // The router only exposes pricing per inference provider, so a new model with
    // no priced provider cannot be created with a meaningful cost.
    const aggregate = aggregateProviders(model);
    if (aggregate.cost === undefined) return undefined;

    return { id: model.id, v2: buildHuggingFaceModel(model, baseModel, aggregate) };
  },
} satisfies SyncProvider<HuggingFaceModel>;

interface Aggregate {
  cost: { input: number; output: number } | undefined;
  context: number | undefined;
  tools: boolean;
  structuredOutput: boolean;
}

function price(value: number) {
  return Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000_000) / 1_000_000
    : undefined;
}

// The router aggregates several inference providers per model and sends traffic to
// the fastest one, so this collapses them into the route a request would actually
// take: pricing and context from the highest-throughput provider, plus capabilities
// advertised by any provider (a caller can always pin a slower provider).
function aggregateProviders(model: HuggingFaceModel): Aggregate {
  const providers = model.providers.filter((provider) => provider.status === "live");

  const byThroughput = (a: HuggingFaceProvider, b: HuggingFaceProvider) =>
    (b.throughput ?? -Infinity) - (a.throughput ?? -Infinity);
  // The provider the router routes to (fastest). Take its price when it reports one;
  // otherwise fall back to the fastest provider that does, so a new model can still
  // be costed.
  const routed = [...providers].sort(byThroughput).at(0);
  const costProvider = routed?.pricing !== undefined
    ? routed
    : [...providers]
        .filter((provider): provider is HuggingFaceProvider & { pricing: { input: number; output: number } } =>
          provider.pricing !== undefined)
        .sort(byThroughput)
        .at(0);
  const input = costProvider?.pricing === undefined ? undefined : price(costProvider.pricing.input);
  const output = costProvider?.pricing === undefined ? undefined : price(costProvider.pricing.output);

  const contexts = providers
    .map((provider) => provider.context_length)
    .filter((value): value is number => value !== undefined);

  return {
    cost: input !== undefined && output !== undefined ? { input, output } : undefined,
    context: routed?.context_length ?? (contexts.length > 0 ? Math.max(...contexts) : undefined),
    tools: providers.some((provider) => provider.supports_tools === true),
    structuredOutput: providers.some((provider) => provider.supports_structured_output === true),
  };
}

const KINDS = ["text", "image", "audio", "video", "pdf"];

// The router lists modality kinds only (text, image). Each kind takes the lab's
// exact MIME types of that kind.
function exactModalities(values: string[], lab: string[]) {
  const kinds = [...new Set(values.map((value) => value.toLowerCase()).filter((value) => KINDS.includes(value)))];
  return kinds.flatMap((kind) => {
    if (kind === "text") return ["text"];
    const mime = kind === "pdf" ? "application/pdf" : kind;
    const exact = lab.filter((item) => item === mime || item.startsWith(`${mime}/`));
    return exact.length > 0 ? exact : [mime];
  });
}

// A new v2 file for a router model that maps to a lab model. Only host data is
// written: price, context, structured output, and modalities when the router
// lists different kinds than the lab. Model facts come from the lab.
export function buildHuggingFaceModel(
  model: HuggingFaceModel,
  baseModel: string,
  aggregate: Aggregate = aggregateProviders(model),
): Record<string, unknown> {
  const lab = labModel(baseModel);
  const labModalities = lab.modalities as { input: string[]; output: string[] };
  const factored = factorBaseModel(baseModel, {
    structured_output: aggregate.structuredOutput || undefined,
    cost: aggregate.cost,
    limit: { context: aggregate.context } as SyncedFullModel["limit"],
  }, { context: aggregate.context });
  const doc = providerModelToV2(factored);

  const input = exactModalities(model.architecture.input_modalities, labModalities.input);
  const output = exactModalities(model.architecture.output_modalities, labModalities.output);
  const kinds = (values: string[]) => [...new Set(values.map((value) => value.split("/")[0]))].sort().join();
  if (input.length > 0 && output.length > 0
    && (kinds(input) !== kinds(labModalities.input) || kinds(output) !== kinds(labModalities.output))) {
    doc.modalities = { input, output };
  }

  // Chat Completions takes tools and reasoning_effort per request, with no
  // per-turn effort or tool-change message.
  const capabilities = (lab.capabilities ?? {}) as { tools?: { supported?: boolean }; reasoning?: { supported?: boolean } };
  const next: Record<string, unknown> = {};
  if (aggregate.tools || (capabilities.tools?.supported ?? lab.tool_call) === true) {
    next.tools = { supported: true, updates: false };
  }
  if ((capabilities.reasoning?.supported ?? lab.reasoning) === true) next.reasoning = { supported: true };
  Object.assign(next, doc.capabilities, { effort_updates: false });
  doc.capabilities = next;
  return doc;
}

function labModel(modelID: string) {
  return Bun.TOML.parse(readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8")) as Record<string, unknown>;
}

export function resolveHuggingFaceBaseModel(id: string) {
  const [prefix, ...parts] = id.split("/");
  if (prefix === undefined || parts.length === 0) return undefined;
  const canonicalPrefix = CANONICAL_ORG_PREFIXES[prefix];
  if (canonicalPrefix === undefined) return resolveCanonicalBaseModel(id);
  return resolveCanonicalBaseModel(`${canonicalPrefix}/${parts.join("/").toLowerCase()}`);
}
