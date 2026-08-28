import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = process.env.OPPER_MODELS_URL ?? "https://api.opper.ai/v3/models?limit=2000";

/**
 * Opper's `maker` field names the lab that built the model; models.dev files
 * lab metadata under its own namespace. Only the spellings that differ need an
 * entry — everything else already matches.
 */
const MAKER_NAMESPACE: Record<string, string> = {
  arcee: "arcee-ai",
  bytedance: "bytedance-seed",
  moonshot: "moonshotai",
  qwen: "alibaba",
  zai: "zhipuai",
};

/** models.dev catalogs chat models; Opper's catalog also carries media, embedding and speech routes. */
const CHAT_TYPE = "llm";

/** The region a route shares with everything else, so it never disambiguates. */
const UNQUALIFIED_REGION = "GLOBAL";

type Modality = "text" | "audio" | "image" | "video" | "pdf";

/**
 * Display names, keyed by route ID and computed once per sync.
 *
 * Opper relays the same model from many hosts, so `name` alone is ambiguous for
 * most of the catalog: fifteen separate routes are called "GLM-5.2". A picker
 * showing fifteen identical rows is unusable, so a shared name is qualified by
 * the host it runs on, and by region when one host serves it in several.
 */
const labels = new Map<string, string>();

const OpperPricing = z
  .object({
    // Every priced Opper route quotes USD per million tokens as an array: one
    // entry for a flat rate, one per band when `thresholds` is set.
    billing_unit: z.string().optional(),
    thresholds: z.array(z.number()).optional(),
    input: z.array(z.number()).optional(),
    output: z.array(z.number()).optional(),
    cached_input: z.array(z.number()).optional(),
    cache_creation: z.array(z.number()).optional(),
    // Distinct from `thresholds`: once the input crosses this many tokens the
    // WHOLE request reprices, rather than only the tokens past the boundary.
    input_surcharge_threshold_tokens: z.number().optional(),
    input_surcharge_multiplier: z.number().optional(),
    output_surcharge_multiplier: z.number().optional(),
  })
  .passthrough();

export const OpperModel = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    name: z.string().min(1),
    /** The routing key shared by every provider's copy of this model. */
    model: z.string().min(1),
    maker: z.string().min(1),
    /** The route's host: an Opper provider slug such as `tensorx` or `azure-zdr`. */
    provider: z.string().min(1),
    provider_display_name: z.string().optional(),
    region: z.string().optional(),
    capabilities: z.array(z.string()).default([]),
    context_window: z.number().int().nonnegative().optional(),
    max_output_tokens: z.number().int().nonnegative().optional(),
    params: z
      .object({
        temperature: z.unknown().optional(),
        reasoning: z
          .object({ supported: z.array(z.string()).optional() })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .optional(),
    pricing: OpperPricing.optional(),
  })
  .passthrough();

export const OpperResponse = z.object({ models: z.array(OpperModel) }).passthrough();

export type OpperModel = z.infer<typeof OpperModel>;

export const opper = {
  id: "opper",
  name: "Opper",
  modelsDir: "providers/opper/models",
  async fetchModels() {
    // No auth: /v3/models is the public catalog, so this sync needs no secret.
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Opper request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const models = OpperResponse.parse(raw).models.filter((model) => model.type === CHAT_TYPE);
    const seen = new Set<string>();
    for (const model of models) {
      if (seen.has(model.id)) throw new Error(`Duplicate Opper model ID: ${model.id}`);
      seen.add(model.id);
    }
    assignLabels(models);
    return models;
  },
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `Skipped ${ids.length} Opper route(s) with no matching \`models/\` entry to point \`base_model\` at: ${ids.join(", ")}`,
    ];
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    // An authored pointer wins: Opper's routing key names a dated snapshot for
    // some routes (claude-haiku-4-5 routes to claude-haiku-4-5-20251001), and a
    // sync should not repoint a base_model a human chose.
    const baseModel = existing?.base_model ?? resolveOpperBaseModel(model);
    if (baseModel === undefined || !usableLimit(model)) {
      // Never delete a hand-authored file just because this resolver cannot
      // reproduce it: preserve what is there and only decline to create new
      // ones. A route that disappears from /v3/models entirely still gets
      // removed by the runner, which is the deletion we do want.
      const authored = context.authored(model.id);
      return authored === undefined ? undefined : { id: model.id, model: authored as SyncedModel };
    }
    return { id: model.id, model: buildOpperModel(model, baseModel, existing) };
  },
} satisfies SyncProvider<OpperModel>;

/**
 * Opper IDs are `<provider>/<provider's own model id>` and carry no lab prefix,
 * so the lab comes from the `maker` field and the model from the routing key
 * rather than from the ID.
 */
export function resolveOpperBaseModel(model: OpperModel) {
  const namespace = MAKER_NAMESPACE[model.maker] ?? model.maker;
  return (
    resolveModelMetadataBaseModel(`${namespace}/${model.model}`) ??
    resolveModelMetadataBaseModel(model.model)
  );
}

function usableLimit(model: OpperModel) {
  return (model.context_window ?? 0) > 0;
}

/**
 * Qualification ladder, least to most specific. The last rung is the route ID,
 * which is unique by construction, so a label always exists.
 */
const LABEL_RUNGS: Array<(model: OpperModel) => string> = [
  (model) => model.name,
  (model) => qualify(model, model.provider_display_name),
  (model) => qualify(model, host(model), region(model)),
  (model) => qualify(model, model.provider),
  (model) => qualify(model, model.id),
];

/**
 * Give every route a label that is unique within the provider, adding only as
 * much qualification as it takes: the bare name where nothing else claims it,
 * then the host, then host and region, then the raw provider slug — Opper
 * serves some models from two slugs that share a display name and region, one
 * of them zero-data-retention.
 */
export function assignLabels(models: OpperModel[]) {
  labels.clear();
  for (const rung of LABEL_RUNGS) {
    const counts = countBy(models, rung);
    for (const model of models) {
      if (labels.has(model.id)) continue;
      const label = rung(model);
      if (counts.get(label) === 1) labels.set(model.id, label);
    }
    if (labels.size === models.length) break;
  }
  return labels;
}

function qualify(model: OpperModel, ...parts: Array<string | undefined>) {
  const qualifiers = parts.filter((part): part is string => part !== undefined && part !== "");
  return qualifiers.length === 0 ? model.name : `${model.name} (${qualifiers.join(", ")})`;
}

function host(model: OpperModel) {
  return model.provider_display_name;
}

/** A route with no region of its own needs no region in its label. */
function region(model: OpperModel) {
  const value = model.region?.toUpperCase();
  return value === undefined || value === UNQUALIFIED_REGION ? undefined : value;
}

function countBy<T>(items: T[], key: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

export function buildOpperModel(
  model: OpperModel,
  baseModel: string,
  existing: ExistingModel | undefined,
): SyncedModel {
  const capabilities = new Set(model.capabilities);
  // Opper relays the lab's weights, so what the model can do is the lab entry's
  // claim to make. Opper's catalog records a capability once it has been
  // verified for a route, which makes its absence silence rather than a denial —
  // it declares PDF input on none of the OpenAI routes that demonstrably accept
  // it. So capabilities here only ever widen the base, never narrow it.
  const base = baseModalities(baseModel);
  const input = union(base.input, inputModalities(capabilities));
  const output = union(
    base.output,
    capabilities.has("image_generation") ? ["text", "image"] : ["text"],
  );
  const context = model.context_window ?? 0;
  const limit = {
    context,
    // An unstated output cap is not a claim that the whole window can be
    // generated, so an authored figure is preferred before falling back to it.
    output: model.max_output_tokens
      ? Math.min(model.max_output_tokens, context)
      : existing?.limit?.output ?? context,
  };
  // `reasoning` and `thinking` are independent flags on an Opper route: some
  // models emit reasoning tokens without exposing a thinking control and some
  // do the reverse, so a reasoner is any route showing either, or an effort
  // ladder under params.
  const reasoning =
    capabilities.has("reasoning") ||
    capabilities.has("thinking") ||
    (model.params?.reasoning ?? undefined) !== undefined;

  return factorBaseModel(
    baseModel,
    {
      name: labels.get(model.id) ?? model.name,
      attachment: widen(input.some((modality) => modality !== "text")),
      reasoning: widen(reasoning),
      // Price, window and the effort ladder are what Opper serves rather than
      // what the lab built, so these do override the base.
      reasoning_options: reasoningOptions(model),
      tool_call: widen(capabilities.has("tools")),
      structured_output: widen(capabilities.has("structured_output")),
      temperature: widen(model.params?.temperature !== undefined),
      // Neither the interleaved-thinking wire field nor a lifecycle status is
      // expressed in /v3/models, so an authored value is the only source.
      interleaved: existing?.interleaved,
      status: existing?.status,
      cost: buildCost(model, existing),
      limit,
      modalities: { input, output },
    },
    limit,
  );
}

/** `false` is indistinguishable from "not recorded yet", so only assert the positive. */
function widen(supported: boolean): true | undefined {
  return supported ? true : undefined;
}

function union(base: Modality[], ours: Modality[]): Modality[] {
  return [...base, ...ours.filter((modality) => !base.includes(modality))];
}

/** The lab entry's own modalities, so an override can add to them but not subtract. */
function baseModalities(baseModel: string): { input: Modality[]; output: Modality[] } {
  try {
    const metadata = modelMetadata(baseModel) as {
      modalities?: { input?: Modality[]; output?: Modality[] };
    };
    return {
      input: metadata.modalities?.input ?? [],
      output: metadata.modalities?.output ?? [],
    };
  } catch {
    return { input: [], output: [] };
  }
}

function inputModalities(capabilities: Set<string>): Modality[] {
  const input: Modality[] = ["text"];
  if (capabilities.has("vision")) input.push("image");
  if (capabilities.has("audio")) input.push("audio");
  if (capabilities.has("video")) input.push("video");
  if (capabilities.has("pdf")) input.push("pdf");
  return input;
}

/**
 * Opper passes `reasoning_effort` through to the upstream model unchanged, so
 * the ladder is whatever that model accepts and there is no toggle or budget
 * control on this surface.
 *
 * A route that states no ladder is stating nothing, not stating "no efforts" —
 * several reasoners with a documented ladder upstream simply have no `params`
 * entry yet. Leaving the field unset lets the runner keep an authored ladder,
 * and stamp the empty set only on a genuinely new file.
 */
function reasoningOptions(model: OpperModel): SyncedFullModel["reasoning_options"] {
  const supported = model.params?.reasoning?.supported;
  if (supported === undefined || supported.length === 0) return undefined;
  return [{ type: "effort", values: [...supported] as never }];
}

function buildCost(
  model: OpperModel,
  existing: ExistingModel | undefined,
): SyncedFullModel["cost"] {
  const pricing = model.pricing;
  const input = pricing?.input?.[0];
  const output = pricing?.output?.[0];
  // A route quoting no price gets no [cost] section rather than a fabricated zero.
  if (pricing === undefined || input === undefined || output === undefined) return undefined;

  return {
    input: round(input),
    output: round(output),
    cache_read: optionalPrice(pricing.cached_input?.[0]),
    cache_write: optionalPrice(pricing.cache_creation?.[0]),
    // Long-context rates are not recorded for every route, so an authored tier
    // stands rather than being dropped for silence.
    tiers: costTiers(pricing) ?? (existing?.cost?.tiers as CostTier[] | undefined),
  };
}

/** A context tier, whichever of Opper's two long-context mechanisms produced it. */
type CostTier = NonNullable<NonNullable<SyncedFullModel["cost"]>["tiers"]>[number];

function costTiers(pricing: z.infer<typeof OpperPricing>): CostTier[] | undefined {
  return bandedTiers(pricing) ?? surchargeTier(pricing);
}

/** `thresholds: [131072]` with `input: [0.05, 0.12]` means band 0 up to the boundary, band 1 past it. */
function bandedTiers(pricing: z.infer<typeof OpperPricing>): CostTier[] | undefined {
  const thresholds = pricing.thresholds;
  if (thresholds === undefined || thresholds.length === 0) return undefined;

  const tiers = thresholds.flatMap((size, index) => {
    const band = index + 1;
    const input = pricing.input?.[band];
    const output = pricing.output?.[band];
    if (input === undefined || output === undefined) return [];
    return [{
      tier: { type: "context" as const, size },
      input: round(input),
      output: round(output),
      cache_read: optionalPrice(pricing.cached_input?.[band]),
      cache_write: optionalPrice(pricing.cache_creation?.[band]),
    }];
  });
  return tiers.length > 0 ? tiers : undefined;
}

/**
 * The full-request surcharge reprices both sides once the input crosses the
 * threshold, so it is a context tier too — just expressed as multipliers.
 * Cache reads and writes are input-side and take the input multiplier, matching
 * how the gateway bills them.
 */
function surchargeTier(pricing: z.infer<typeof OpperPricing>): CostTier[] | undefined {
  const size = pricing.input_surcharge_threshold_tokens;
  const inputMultiplier = pricing.input_surcharge_multiplier;
  const outputMultiplier = pricing.output_surcharge_multiplier;
  const input = pricing.input?.[0];
  const output = pricing.output?.[0];
  if (
    size === undefined || size <= 0 ||
    inputMultiplier === undefined || outputMultiplier === undefined ||
    input === undefined || output === undefined
  ) {
    return undefined;
  }

  return [{
    tier: { type: "context" as const, size },
    input: round(input * inputMultiplier),
    output: round(output * outputMultiplier),
    cache_read: optionalPrice(scale(pricing.cached_input?.[0], inputMultiplier)),
    cache_write: optionalPrice(scale(pricing.cache_creation?.[0], inputMultiplier)),
  }];
}

function scale(price: number | undefined, multiplier: number) {
  return price === undefined ? undefined : price * multiplier;
}

function optionalPrice(price: number | undefined) {
  return price === undefined || price < 0 ? undefined : round(price);
}

/**
 * Prices arrive already denominated per million tokens, but derived rates carry
 * binary-float noise (a cached rate reads 0.029759999999999998), which the TOML
 * writer would emit verbatim.
 */
function round(price: number): number {
  return Math.round(price * 1_000_000) / 1_000_000;
}
