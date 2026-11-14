// CrossModel: https://www.crossmodel.ai/api/models (CROSSMODEL_API_KEY
// optional; CROSSMODEL_MODELS_URL overrides it). Authoritative for prices
// (USD micro per 1M, threshold tiers as context bands), context and output
// limits, input and output kinds, the reasoning controls CrossModel exposes,
// structured output and deprecation. A model that caches prompts keeps the
// file's cache kinds, else gets `{ implicit = true }`. A cache read price at or
// above the input price isn't a discount, so neither cache price is written.
// Reasoning support itself comes from the lab. New models are created from the
// lab its vendor names; hidden and dropped models are deleted.

import { z } from "zod";

import { bearer, fetchJSON } from "../http.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://www.crossmodel.ai/api/models";
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"] as const;

const ReasoningCapability = z.object({
  supported: z.boolean().optional(),
  toggle: z.boolean().nullish(),
  effort: z.array(z.enum(REASONING_EFFORTS)).nullish(),
  budget_tokens: z.object({ min: z.number().optional(), max: z.number().optional() }).nullish(),
}).passthrough();

const PriceTier = z.object({
  threshold: z.number().nullable().optional(),
  input_micro_per_1m: z.number().nullable().optional(),
  output_micro_per_1m: z.number().nullable().optional(),
  cache_read_micro_per_1m: z.number().nullable().optional(),
  cache_creation_micro_per_1m: z.number().nullable().optional(),
}).passthrough();
type PriceTier = z.infer<typeof PriceTier>;

const CrossModelModel = z.object({
  id: z.string(),
  vendor_code: z.string(),
  context_window_tokens: z.number().nullable().optional(),
  max_output_tokens: z.number().nullable().optional(),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).optional(),
  capabilities: z.object({
    json: z.boolean().optional(),
    structured_output: z.object({ json_schema: z.boolean().nullish() }).passthrough().nullish(),
    context: z.object({ caching: z.boolean().nullish() }).passthrough().nullish(),
    reasoning: ReasoningCapability.optional(),
  }).passthrough().nullable().optional(),
  status: z.string().optional(),
  identity: z.object({ release_stage: z.string().nullish() }).passthrough().nullish(),
  pricing: z.object({ tiers: z.array(PriceTier).nullable() }).nullable().optional(),
}).passthrough();
type CrossModelModel = z.infer<typeof CrossModelModel>;

const CrossModelResponse = z.object({ data: z.array(CrossModelModel) }).passthrough();

// vendor_code to the lab directory, for new models.
const AUTHOR_BY_VENDOR: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  moonshot: "moonshotai",
  deepseek: "deepseek",
  qwen: "alibaba",
  xiaomi: "xiaomi",
  minimax: "minimax",
  "z-ai": "zhipuai",
  "x-ai": "xai",
  tencent: "tencent",
};

const KINDS = ["text", "audio", "image", "video", "pdf"];

export const crossmodel: SyncModule<unknown> = {
  id: "crossmodel",
  name: "CrossModel",
  policy: {
    owns: [
      { path: "status", merge: "deprecated" },
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "capabilities.structured_output",
      { path: "capabilities.cache.implicit", merge: "seed" },
      "limit.context",
      "limit.output",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      { path: "cost.text.input.overrides", merge: "bands" },
      "cost.text.output.price",
      { path: "cost.text.output.overrides", merge: "bands" },
    ],
    creates: "auto",
    removals: "delete",
    omitLabInput: true,
  },
  fetch: () => {
    const key = process.env.CROSSMODEL_API_KEY;
    return fetchJSON(process.env.CROSSMODEL_MODELS_URL ?? API_ENDPOINT, { source: "CrossModel models", headers: key ? bearer(key) : {} });
  },
  observe: (raw) => CrossModelResponse.parse(raw).data.filter((model) => model.status !== "hidden").map(observe),
};

function observe(model: CrossModelModel): Observation {
  const capabilities = model.capabilities ?? undefined;
  const structured = capabilities?.json ?? capabilities?.structured_output?.json_schema ?? undefined;
  const context = model.context_window_tokens ?? undefined;
  const base = baseModel(model);
  return {
    id: model.id,
    base: base === undefined ? [] : [base],
    ...(model.identity?.release_stage === "deprecated" ? { status: "deprecated" as const } : {}),
    ...(model.modalities === undefined ? {} : { modalities: { input: kinds(model.modalities.input), output: kinds(model.modalities.output) } }),
    capabilities: {
      ...(reasoning(model) ?? {}),
      ...(structured === undefined ? {} : { structured_output: structured }),
      ...(capabilities?.context?.caching === true ? { cache: { implicit: true } } : {}),
    },
    limit: {
      ...(context === undefined ? {} : { context }),
      ...(model.max_output_tokens == null ? {} : { output: model.max_output_tokens }),
    },
    ...cost(model),
    ...(context === undefined ? {} : { defaults: { limit: { output: context } } }),
  } as Observation;
}

// CrossModel's reasoning controls; a model that lists none keeps the file's.
function reasoning(model: CrossModelModel) {
  const source = model.capabilities?.reasoning;
  if (source === undefined || source.supported === false) return undefined;
  const effort = source.effort != null && source.effort.length > 0
    ? [...source.effort].sort((a, b) => REASONING_EFFORTS.indexOf(a) - REASONING_EFFORTS.indexOf(b))
    : undefined;
  const budget = source.budget_tokens == null
    ? undefined
    : Object.fromEntries(Object.entries({ min: source.budget_tokens.min, max: source.budget_tokens.max }).filter(([, value]) => value !== undefined));
  return {
    reasoning: {
      toggle: source.toggle === true && !effort?.includes("none") ? true : null,
      effort: effort ?? null,
      budget: budget ?? null,
    },
  };
}

// The lowest-threshold tier is the base price; every higher tier is a context band.
function cost(model: CrossModelModel) {
  const tiers = [...(model.pricing?.tiers ?? [])].sort((a, b) => (a.threshold ?? 0) - (b.threshold ?? 0));
  const base = tierCost(tiers[0]);
  if (base === undefined) return {};
  const bands = tiers.slice(1).flatMap((tier) => {
    const prices = tierCost(tier);
    return prices === undefined ? [] : [{ size: tier.threshold ?? 0, ...prices }];
  });
  const cache = (prices: { read?: number; write?: number }) => ({ ...(prices.read === undefined ? {} : { read: prices.read }), ...(prices.write === undefined ? {} : { write: prices.write }) });
  return {
    cost: {
      text: {
        input: {
          price: base.input,
          cache: { read: base.read ?? null, write: base.write ?? null },
          overrides: bands.length === 0 ? null : bands.map((band) => ({
            when: { context: { gt: band.size } },
            price: band.input,
            ...(band.read === undefined && band.write === undefined ? {} : { cache: cache(band) }),
          })),
        },
        output: {
          price: base.output,
          overrides: bands.length === 0 ? null : bands.map((band) => ({ when: { context: { gt: band.size } }, price: band.output })),
        },
      },
    },
  };
}

// One tier's prices. Cache prices only when the read price is a real discount.
function tierCost(tier: PriceTier | undefined) {
  const input = micro(tier?.input_micro_per_1m);
  const output = micro(tier?.output_micro_per_1m);
  if (input === undefined || output === undefined) return undefined;
  const read = positive(micro(tier?.cache_read_micro_per_1m));
  if (read === undefined || read >= input) return { input, output };
  return { input, output, read, write: positive(micro(tier?.cache_creation_micro_per_1m)) };
}

function baseModel(model: CrossModelModel) {
  const author = AUTHOR_BY_VENDOR[model.vendor_code];
  if (author === undefined) return undefined;
  const short = model.id.includes("/") ? model.id.split("/").slice(1).join("/") : model.id;
  // MiniMax lab IDs are TitleCased (minimax/MiniMax-M3).
  return author === "minimax" ? `minimax/${short.replace(/^minimax-m/i, "MiniMax-M")}` : `${author}/${short}`;
}

function micro(value: number | null | undefined) {
  return value == null ? undefined : Math.round(value) / 1_000_000;
}

function positive(value: number | undefined) {
  return value !== undefined && value > 0 ? value : undefined;
}

function kinds(values: string[]) {
  const result = values.map((value) => value.toLowerCase()).map((value) => (value === "file" ? "pdf" : value)).filter((value) => KINDS.includes(value));
  return [...new Set(result.length > 0 ? result : ["text"])].map((value) => (value === "pdf" ? "application/pdf" : value));
}
