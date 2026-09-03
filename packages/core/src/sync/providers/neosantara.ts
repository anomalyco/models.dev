import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const MODELS_ENDPOINT = "https://api.neosantara.xyz/v1/models";
const PRICING_ENDPOINT = "https://api.neosantara.xyz/v1/public/pricing";
const MIN_CONTEXT_WINDOW = 100_000;
const PROVIDERS_DIR = path.join(process.cwd(), "providers");

const Pricing = z.object({
  currency: z.enum(["USD", "IDR"]),
  prompt: z.number().nonnegative().optional(),
  completion: z.number().nonnegative().optional(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
}).passthrough();

export const NeosantaraModel = z.object({
  id: z.string(),
  object: z.literal("model"),
  created: z.number(),
  owned_by: z.string(),
  description: z.string(),
  context_window: z.number().int().nonnegative().nullable(),
  max_output_tokens: z.number().int().nonnegative().nullable(),
  pricing: Pricing,
  discount: z.number().min(0).max(100).optional(),
  capabilities: z.array(z.string()),
  deprecated: z.boolean(),
  deprecation_alternatives: z.array(z.string()),
}).passthrough();

export const NeosantaraModelsResponse = z.object({
  object: z.literal("list"),
  data: z.array(NeosantaraModel),
}).passthrough();

const PublicPricing = z.object({
  currency: z.enum(["USD", "IDR"]).optional(),
  per_million_tokens: z.object({
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cache_read: z.number().nonnegative().optional(),
    cache_write: z.number().nonnegative().optional(),
  }).optional(),
}).passthrough();

// Only `name` and `raw_pricing` are consumed. Everything else is descriptive and optional so a
// single omission cannot fail the whole catalog sync.
const PublicPricingModel = z.object({
  name: z.string(),
  capabilities: z.array(z.string()).optional(),
  context_window: z.number().int().nonnegative().nullable().optional(),
  description: z.string().optional(),
  raw_pricing: PublicPricing,
}).passthrough();

export const NeosantaraPricingResponse = z.object({
  data: z.array(PublicPricingModel),
  meta: z.object({
    count: z.number().int().nonnegative(),
    updated_at: z.string(),
    exchange_rate: z.object({
      usd_idr: z.number().positive(),
      currency: z.literal("IDR"),
      source: z.string(),
    }),
  }),
}).passthrough();

const NeosantaraCombinedResponse = z.object({
  models: z.unknown(),
  pricing: z.unknown(),
});

export type NeosantaraSourceModel = z.infer<typeof NeosantaraModel> & {
  exchange_rate: number;
};

/**
 * Neosantara serves bare model ids, so the canonical metadata tree resolves most of them on
 * its own and newly launched models are picked up without a code change. Only ids the tree
 * cannot resolve are aliased here (renamed generations, aliases pointing at another model,
 * and vendor-specific suffixes).
 */
const BASE_MODEL_ALIASES: Record<string, string> = {
  "claude-3-haiku": "anthropic/claude-3-haiku-20240307",
  "claude-4.5-opus": "anthropic/claude-opus-4-5",
  "claude-4.5-sonnet": "anthropic/claude-sonnet-4-5",
  "claude-opus-7": "anthropic/claude-opus-4-7",
  "claude-opus-8": "anthropic/claude-opus-4-8",
  "devstral-2": "mistral/devstral-2512",
  // Neosantara routes its coding alias at Grok 4.3.
  "grok-code-fast": "xai/grok-4.3",
  "qwen3-235b-wse": "alibaba/qwen3-235b-a22b-instruct-2507",
};

export function resolveNeosantaraBaseModel(id: string) {
  return BASE_MODEL_ALIASES[id] ?? resolveModelMetadataBaseModel(id);
}

export function mergeNeosantaraCatalogs(
  models: z.infer<typeof NeosantaraModelsResponse>,
  pricing: z.infer<typeof NeosantaraPricingResponse>,
): NeosantaraSourceModel[] {
  const modelPricing = new Map(models.data.map((model) => [model.id, model.pricing] as const));
  const publicPricing = new Map(pricing.data.map((model) => {
    const raw = model.raw_pricing;
    const tokens = raw.per_million_tokens;
    // Cache rates may only be surfaced by /v1/models. Inherit them so publishing does not
    // silently drop cost data, but never across a currency change: the two figures would
    // otherwise be mixed into one scale.
    const fallback = modelPricing.get(model.name);
    const cache = fallback?.currency === raw.currency ? fallback : undefined;
    const normalized =
      raw.currency === undefined || tokens?.input === undefined || tokens.output === undefined
        ? undefined
        : {
            currency: raw.currency,
            prompt: tokens.input,
            completion: tokens.output,
            cache_read: tokens.cache_read ?? cache?.cache_read,
            cache_write: tokens.cache_write ?? cache?.cache_write,
          };
    return [model.name, normalized] as const;
  }));
  return models.data.map((model) => ({
    ...model,
    pricing: publicPricing.get(model.id) ?? model.pricing,
    exchange_rate: pricing.meta.exchange_rate.usd_idr,
  }));
}

type ReasoningControls = NonNullable<SyncedFullModel["reasoning_options"]>;

/**
 * Reasoning controls (AGENTS.md → "Reasoning options").
 *
 * This host is OpenAI-compatible and normalizes reasoning onto a single caller-facing
 * field, `reasoning_effort`, accepting the values below. Upstream-native shapes (thinking
 * budgets, vendor toggles) are handled behind that field and never appear in a caller's
 * request, so the control is always an effort list.
 *
 * The values are read from the canonical tree at sync time rather than hardcoded: the
 * underlying lab entry wins, otherwise the set its same-surface peers agree on, and the
 * result is intersected with what this host accepts — which is why `max` never appears.
 * A model whose lab and peers document no graded level at all has only an on/off choice,
 * which is a toggle. New models therefore need no change here.
 */
const HOST_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

/** A model that reasons with no caller control. */
const ALWAYS_ON = "always-on";
/**
 * A model whose only caller choice is whether to reason at all. The switch is
 * `reasoning_effort`, not a separate field — `reasoning.enabled` on its own is inert — so the
 * control is a toggle and the header below records the mapping.
 */
const ON_OFF_ONLY = "on-off";

const TOGGLE_HEADER = `# Toggle: reasoning_effort = "none" turns reasoning off; any other accepted
# value (or omitting the field) leaves it on. This host has no separate on/off
# field: reasoning.enabled alone does not enable reasoning.
# https://docs.neosantara.xyz
`;

function tomlFilesIn(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) =>
    entry.isDirectory()
      ? tomlFilesIn(path.join(dir, entry.name))
      : entry.name.endsWith(".toml")
        ? [path.join(dir, entry.name)]
        : [],
  );
}

function parseToml(filePath: string) {
  try {
    return Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Project another entry's controls onto this host's single field.
 *
 * An empty set means always-on. A lab-side toggle is `reasoning_effort = none` here, so it
 * joins the effort list rather than staying a separate option — a bare toggle would claim an
 * on/off field this host does not have. Values the host cannot send are dropped.
 */
function hostControls(
  options: unknown,
): string[] | typeof ALWAYS_ON | typeof ON_OFF_ONLY | undefined {
  if (!Array.isArray(options)) return undefined;
  if (options.length === 0) return ALWAYS_ON;

  let toggled = false;
  let accepted: string[] | undefined;
  for (const option of options) {
    if (typeof option !== "object" || option === null) continue;
    const type = (option as { type?: unknown }).type;
    if (type === "toggle") toggled = true;
    if (type !== "effort") continue;
    const values = (option as { values?: unknown }).values;
    if (!Array.isArray(values)) continue;
    const usable = values.filter(
      (value): value is string => typeof value === "string" && HOST_EFFORTS.has(value),
    );
    if (usable.length > 0) accepted = usable;
  }

  if (accepted === undefined) return toggled ? ON_OFF_ONLY : undefined;
  return toggled && !accepted.includes("none") ? ["none", ...accepted] : accepted;
}

let controlIndex: { lab: Map<string, ReturnType<typeof hostControls>>; peers: Map<string, ReturnType<typeof hostControls>> } | undefined;

/** Index every other provider's controls: the model's own lab, then peer consensus. */
function indexControls() {
  if (controlIndex !== undefined) return controlIndex;

  const lab = new Map<string, ReturnType<typeof hostControls>>();
  const tally = new Map<string, Map<string, number>>();
  const shapes = new Map<string, Map<string, ReturnType<typeof hostControls>>>();

  for (const file of tomlFilesIn(PROVIDERS_DIR)) {
    if (file.startsWith(path.join(PROVIDERS_DIR, "neosantara"))) continue;
    const toml = parseToml(file);
    if (toml === undefined) continue;
    const controls = hostControls(toml.reasoning_options);

    // A lab's own directory is authoritative, wherever the file sits inside it.
    const owner = path.relative(PROVIDERS_DIR, file).split(path.sep)[0];
    const name = path.basename(file, ".toml");
    if (owner !== undefined && !lab.has(`${owner}/${name}`)) lab.set(`${owner}/${name}`, controls);

    const base = toml.base_model;
    if (typeof base !== "string" || controls === undefined) continue;
    const key = typeof controls === "string" ? controls : controls.join(",");
    const counts = tally.get(base) ?? new Map<string, number>();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    tally.set(base, counts);
    const seen = shapes.get(base) ?? new Map();
    seen.set(key, controls);
    shapes.set(base, seen);
  }

  const peers = new Map<string, ReturnType<typeof hostControls>>();
  for (const [base, counts] of tally) {
    const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (best !== undefined) peers.set(base, shapes.get(base)?.get(best[0]));
  }

  controlIndex = { lab, peers };
  return controlIndex;
}

/**
 * Reasoning controls (AGENTS.md → "Reasoning options").
 *
 * This host is OpenAI-compatible and normalizes reasoning onto one caller-facing field,
 * `reasoning_effort`. Upstream-native shapes never reach a caller, so controls are read from
 * the canonical tree at sync time instead of being listed here: the model's own lab entry
 * wins, otherwise the shape its peers agree on. New models need no change here.
 */
/** A toggle control must carry a leading comment naming the field it refers to. */
export function neosantaraReasoningHeader(controls: ReasoningControls) {
  return controls.some((option) => option.type === "toggle") ? TOGGLE_HEADER : undefined;
}

export function neosantaraReasoningControls(id: string, baseModel: string): ReasoningControls {
  const { lab, peers } = indexControls();
  const [owner, ...rest] = baseModel.split("/");
  const name = rest.at(-1) ?? "";
  // A dated snapshot such as `-0813` shares its lab entry with the undated model.
  const candidates = [name, name.replace(/-\d{4,}$/, "")];
  const key = candidates.map((candidate) => `${owner}/${candidate}`).find((k) => lab.has(k));
  const derived = key === undefined ? peers.get(baseModel) : lab.get(key);

  if (derived === undefined || derived === ALWAYS_ON) return [];
  if (derived === ON_OFF_ONLY) return [{ type: "toggle" }];
  return [{ type: "effort", values: derived as never }];
}


/** Image models are priced per image and carry no context window, so they skip the token filters. */
function isImageModel(model: NeosantaraSourceModel) {
  return model.capabilities.includes("image_generation");
}

/** Display names for ids whose canonical entry is a different model (see BASE_MODEL_ALIASES). */
const NAME_OVERRIDES: Record<string, string> = {
  "grok-code-fast": "Grok Code Fast",
};

/** Models this host publishes at all, regardless of whether we can translate them yet. */
export function meetsNeosantaraPublicFilter(model: NeosantaraSourceModel) {
  return (
    isImageModel(model) ||
    (model.context_window !== null &&
      model.context_window >= MIN_CONTEXT_WINDOW &&
      model.capabilities.includes("function_calling"))
  );
}

export function shouldSyncNeosantaraModel(model: NeosantaraSourceModel) {
  if (model.deprecated || resolveNeosantaraBaseModel(model.id) === undefined) return false;
  if (!meetsNeosantaraPublicFilter(model)) return false;
  if (isImageModel(model)) return true;
  // Skip rather than throw: one missing catalog field must cost a single model, not the run.
  if (model.pricing.prompt === undefined || model.pricing.completion === undefined) return false;
  return true;
}

function effectiveUsd(value: number | undefined, model: NeosantaraSourceModel) {
  if (value === undefined) return undefined;
  const usd = model.pricing.currency === "IDR" ? value / model.exchange_rate : value;
  const discount = model.discount === undefined ? 1 : (100 - model.discount) / 100;
  return Math.round(usd * discount * 1_000_000) / 1_000_000;
}

/** Input modalities this host accepts, derived from the advertised understanding capabilities. */
export function neosantaraInputModalities(capabilities: string[]) {
  return [
    "text" as const,
    ...(capabilities.includes("vision") ? (["image"] as const) : []),
    ...(capabilities.includes("video_understanding") ? (["video"] as const) : []),
  ];
}

export function buildNeosantaraModel(
  model: NeosantaraSourceModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const baseModel = resolveNeosantaraBaseModel(model.id);
  if (baseModel === undefined) {
    throw new Error(`No canonical base model mapping for Neosantara model '${model.id}'`);
  }

  const limit = {
    context: model.context_window ?? undefined,
  };

  // models.dev has no per-image cost field, so per-image pricing is left unpublished and
  // every other trait is inherited from the canonical lab entry.
  if (isImageModel(model)) {
    return factorBaseModel(
      baseModel,
      { status: model.deprecated ? "deprecated" : existing?.status },
      limit,
      existing?.base_model === baseModel ? existing.base_model_omit : undefined,
    );
  }

  const reasoning = model.capabilities.includes("reasoning");
  const inputCost = effectiveUsd(model.pricing.prompt, model);
  const outputCost = effectiveUsd(model.pricing.completion, model);
  if (inputCost === undefined || outputCost === undefined) {
    throw new Error(`Missing token pricing for Neosantara model '${model.id}'`);
  }
  const cost = {
    input: inputCost,
    output: outputCost,
    cache_read: effectiveUsd(model.pricing.cache_read, model),
    cache_write: effectiveUsd(model.pricing.cache_write, model),
  };

  return factorBaseModel(
    baseModel,
    {
      name: NAME_OVERRIDES[model.id],
      reasoning,
      reasoning_options: reasoning ? neosantaraReasoningControls(model.id, baseModel) : undefined,
      attachment: model.capabilities.includes("vision"),
      tool_call: true,
      structured_output: model.capabilities.includes("json_mode"),
      modalities: {
        input: neosantaraInputModalities(model.capabilities),
        output: ["text"],
      },
      status: model.deprecated ? "deprecated" : existing?.status,
      limit,
      cost,
    },
    limit,
    existing?.base_model === baseModel ? existing.base_model_omit : undefined,
  );
}

async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Neosantara request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export const neosantara = {
  id: "neosantara",
  name: "Neosantara",
  modelsDir: "providers/neosantara/models",
  authoritativeHeaders: true,
  sourceID(model) {
    if (model.deprecated) return undefined;
    // Report anything the public filter accepts but translateModel skipped, whether the cause is
    // a missing canonical entry, unusable upstream pricing, or controls that still need review.
    return meetsNeosantaraPublicFilter(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Neosantara models were not created because they lack a canonical \`models/\` entry to inherit, because the Neosantara catalog reported no usable token pricing, or because their reasoning controls still need review against this host's request schema.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
      "Add a `models/<provider>/<model>.toml` entry (and, for reasoning models, a reviewed control set) to include them in the next sync.",
    ];
  },
  async fetchModels() {
    const [models, pricing] = await Promise.all([
      fetchJson(MODELS_ENDPOINT),
      fetchJson(PRICING_ENDPOINT),
    ]);
    return { models, pricing };
  },
  parseModels(raw) {
    const combined = NeosantaraCombinedResponse.parse(raw);
    return mergeNeosantaraCatalogs(
      NeosantaraModelsResponse.parse(combined.models),
      NeosantaraPricingResponse.parse(combined.pricing),
    );
  },
  translateModel(model, context) {
    if (!shouldSyncNeosantaraModel(model)) return undefined;
    return {
      id: model.id,
      model: buildNeosantaraModel(model, context.existing(model.id)),
      header: model.capabilities.includes("reasoning")
        ? neosantaraReasoningHeader(
            neosantaraReasoningControls(model.id, resolveNeosantaraBaseModel(model.id) ?? ""),
          )
        : undefined,
    };
  },
} satisfies SyncProvider<NeosantaraSourceModel>;
