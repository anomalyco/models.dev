import { z } from "zod";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

// Neosantara serves a models.dev / LLM Gateway shaped catalog at this single public endpoint.
const CATALOG_ENDPOINT = "https://api.neosantara.xyz/v1/catalog";
const MIN_CONTEXT_WINDOW = 100_000;

// Accepted reasoning_effort enum; efforts from the catalog are intersected with it defensively.
const HOST_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const HOST_EFFORT_SET: ReadonlySet<string> = new Set(HOST_EFFORTS);

const CatalogProvider = z
  .object({
    providerId: z.string().optional(),
    vision: z.boolean().optional(),
    tools: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    reasoning_efforts: z.array(z.string()).optional(),
    has_toggle: z.boolean().optional(),
  })
  .passthrough();

// Per-token USD strings; "0" is a real price for free models (kept), unknown for cache/reasoning.
const CatalogPricing = z
  .object({
    prompt: z.string().optional(),
    completion: z.string().optional(),
    internal_reasoning: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  })
  .passthrough();

export const NeosantaraModel = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    display_name: z.string().optional(),
    created: z.number().optional(),
    description: z.string().optional(),
    family: z.string().optional(),
    architecture: z.object({
      input_modalities: z.array(z.string()),
      output_modalities: z.array(z.string()),
    }),
    context_length: z.number().int().nonnegative().optional(),
    pricing: CatalogPricing,
    supported_parameters: z.array(z.string()).optional(),
    structured_outputs: z.boolean().optional(),
    providers: z.array(CatalogProvider).min(1),
    deprecated: z.boolean().optional(),
  })
  .passthrough();

export const NeosantaraCatalogResponse = z
  .object({ data: z.array(NeosantaraModel) })
  .passthrough();

export type NeosantaraSourceModel = z.infer<typeof NeosantaraModel>;

// One mapping per model carries this host's capability flags and reasoning efforts.
function mapping(model: NeosantaraSourceModel) {
  return model.providers[0];
}

// Only ids the canonical tree cannot resolve are aliased (renamed generations, coding aliases).
const BASE_MODEL_ALIASES: Record<string, string> = {
  "claude-3-haiku": "anthropic/claude-3-haiku-20240307",
  "claude-4.5-opus": "anthropic/claude-opus-4-5",
  "claude-4.5-sonnet": "anthropic/claude-sonnet-4-5",
  "devstral-2": "mistral/devstral-2512",
  "grok-code-fast": "xai/grok-4.3",
  "qwen3-235b-wse": "alibaba/qwen3-235b-a22b-instruct-2507",
};

export function resolveNeosantaraBaseModel(id: string) {
  return BASE_MODEL_ALIASES[id] ?? resolveModelMetadataBaseModel(id);
}

// Display names for ids whose canonical entry is a different model (see BASE_MODEL_ALIASES).
const NAME_OVERRIDES: Record<string, string> = {
  "grok-code-fast": "Grok Code Fast",
};

type ReasoningControls = NonNullable<SyncedFullModel["reasoning_options"]>;

// Toggle controls carry a leading wire comment naming the off value (AGENTS.md requirement).
const TOGGLE_HEADER = `# Toggle: reasoning_effort = "none" turns thinking off; any other accepted
# value turns it on. https://docs.neosantara.xyz/en/capability/reasoning
`;

// Whether the catalog reported a caller-control surface for this reasoning model. A missing
// `reasoning_efforts` is "unknown" (skip + report), NOT an affirmative always-on `[]`.
function hasReasoningEfforts(model: NeosantaraSourceModel) {
  return Array.isArray(mapping(model).reasoning_efforts);
}

// The catalog reports each model's real reasoning surface (resolved host-side from the model's
// models.dev lab entry): [] = always-on (no caller control), ["none"] = on/off toggle, otherwise
// the graded effort levels. When a model's lab entry exposes toggle + graded effort (e.g. Sonnet 5),
// the host reports `has_toggle: true`, authoring `toggle` alongside the graded effort ladder.
export function neosantaraReasoningControls(
  model: NeosantaraSourceModel,
  _existing?: ExistingModel,
): ReasoningControls {
  const map = mapping(model);
  const efforts = (map.reasoning_efforts ?? []).filter((effort) =>
    HOST_EFFORT_SET.has(effort),
  );
  if (efforts.length === 0) return [];
  if (efforts.length === 1 && efforts[0] === "none") return [{ type: "toggle" }];

  const hasToggle = map.has_toggle === true;
  const graded = efforts.filter((effort) => effort !== "none");

  if (hasToggle) {
    if (graded.length > 0) {
      return [
        { type: "toggle" },
        { type: "effort", values: graded as never },
      ];
    }
    return [{ type: "toggle" }];
  }

  return [{ type: "effort", values: efforts as never }];
}

// A toggle needs its wire comment; effort/always-on models carry none.
export function neosantaraReasoningHeader(controls: ReasoningControls | undefined) {
  return controls?.some((option) => option.type === "toggle") ? TOGGLE_HEADER : undefined;
}

// Image models output an image modality, are priced per image, and skip the token filters.
function isImageModel(model: NeosantaraSourceModel) {
  return model.architecture.output_modalities.includes("image");
}

// Per-token USD string -> USD per million tokens. `0` is preserved (free models are real).
function price(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

// Cache/reasoning prices report `0` when unknown; never downgrade to a published zero.
function nonZeroPrice(value: string | undefined): number | undefined {
  const result = price(value);
  return result !== undefined && result > 0 ? result : undefined;
}

const ALLOWED_MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);

function modalities(values: string[]): string[] {
  const mapped = values
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value) => ALLOWED_MODALITIES.has(value));
  return [...new Set(mapped.length > 0 ? mapped : ["text"])];
}

// Image generators, or 100k+ context function-calling text models.
export function meetsNeosantaraPublicFilter(model: NeosantaraSourceModel) {
  return (
    isImageModel(model) ||
    ((model.context_length ?? 0) >= MIN_CONTEXT_WINDOW && mapping(model).tools === true)
  );
}

export function shouldSyncNeosantaraModel(model: NeosantaraSourceModel) {
  if (model.deprecated || resolveNeosantaraBaseModel(model.id) === undefined) return false;
  if (!meetsNeosantaraPublicFilter(model)) return false;
  if (isImageModel(model)) return true;
  // Skip rather than throw: one missing price costs a single model, not the run.
  if (price(model.pricing.prompt) === undefined || price(model.pricing.completion) === undefined) {
    return false;
  }
  // A reasoning model with no reported effort surface is unknown, not always-on: skip it (and
  // report it) rather than stamping `[]`. Explicit `[]` from the catalog is a real always-on set.
  if (mapping(model).reasoning === true && !hasReasoningEfforts(model)) return false;
  return true;
}

export function buildNeosantaraModel(
  model: NeosantaraSourceModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const baseModel = resolveNeosantaraBaseModel(model.id);
  if (baseModel === undefined) {
    throw new Error(`No canonical base model mapping for Neosantara model '${model.id}'`);
  }

  // context_length is 0 for image models; never author limit.context = 0 — inherit the base.
  const limit = { context: model.context_length || undefined };
  const baseModelOmit = existing?.base_model === baseModel ? existing.base_model_omit : undefined;

  // Per-image pricing has no models.dev field, so cost is left unpublished and inherited.
  if (isImageModel(model)) {
    return factorBaseModel(
      baseModel,
      { status: model.deprecated ? "deprecated" : existing?.status },
      limit,
      baseModelOmit,
    );
  }

  const map = mapping(model);
  const reasoning = map.reasoning === true;
  const inputCost = price(model.pricing.prompt);
  const outputCost = price(model.pricing.completion);
  if (inputCost === undefined || outputCost === undefined) {
    throw new Error(`Missing token pricing for Neosantara model '${model.id}'`);
  }

  return factorBaseModel(
    baseModel,
    {
      name: NAME_OVERRIDES[model.id],
      reasoning,
      reasoning_options: reasoning ? neosantaraReasoningControls(model, existing) : undefined,
      interleaved: reasoning ? { field: "reasoning_content" as const } : undefined,
      attachment: map.vision === true,
      tool_call: map.tools === true,
      structured_output: model.structured_outputs === false ? false : undefined,
      modalities: {
        input: modalities(model.architecture.input_modalities),
        output: modalities(model.architecture.output_modalities),
      },
      status: model.deprecated ? "deprecated" : existing?.status,
      limit,
      cost: {
        input: inputCost,
        output: outputCost,
        reasoning: reasoning ? nonZeroPrice(model.pricing.internal_reasoning) : undefined,
        cache_read: nonZeroPrice(model.pricing.input_cache_read),
        cache_write: nonZeroPrice(model.pricing.input_cache_write),
      },
    },
    limit,
    baseModelOmit,
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
    return meetsNeosantaraPublicFilter(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Neosantara models were not created because they lack a canonical \`models/\` entry to inherit, the catalog reported no usable token pricing, or a reasoning model did not report its effort surface.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
      "Add a `models/<provider>/<model>.toml` entry (or an alias in BASE_MODEL_ALIASES) to include them in the next sync.",
    ];
  },
  async fetchModels() {
    return fetchJson(CATALOG_ENDPOINT);
  },
  parseModels(raw) {
    const data = NeosantaraCatalogResponse.parse(raw).data;
    // An empty catalog would delete every model file; fail loudly instead of wiping the provider.
    if (data.length === 0) {
      throw new Error("Neosantara catalog returned no models");
    }
    return data;
  },
  translateModel(model, context) {
    if (!shouldSyncNeosantaraModel(model)) return undefined;
    const translated = buildNeosantaraModel(model, context.existing(model.id));
    return {
      id: model.id,
      model: translated,
      header: neosantaraReasoningHeader(translated.reasoning_options),
    };
  },
} satisfies SyncProvider<NeosantaraSourceModel>;
