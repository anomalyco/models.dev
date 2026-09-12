import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

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
    base_model: z.string().optional(),
    override_name: z.string().optional(),
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

// Canonical lab base models are supplied directly by the /v1/catalog endpoint, verified
// against the local models/ directory before falling back to id-based resolution.
export function resolveNeosantaraBaseModel(model: NeosantaraSourceModel | string) {
  if (typeof model === "string") return resolveModelMetadataBaseModel(model);
  if (model.base_model !== undefined) {
    const verified = resolveModelMetadataBaseModel(model.base_model);
    if (verified !== undefined) return verified;
  }
  return resolveModelMetadataBaseModel(model.id);
}

type ReasoningControls = NonNullable<SyncedFullModel["reasoning_options"]>;

const PROVIDERS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "providers");
const baselineOptionsCache = new Map<string, ReasoningControls | undefined>();

function readReasoningOptionsFromFile(filePath: string): ReasoningControls | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return Array.isArray(parsed.reasoning_options) ? (parsed.reasoning_options as ReasoningControls) : undefined;
  } catch {
    return undefined;
  }
}

function searchDirForBaseline(dir: string, baseModel: string, labId: string): ReasoningControls | undefined {
  if (!existsSync(dir)) return undefined;
  const candidates = [
    `${labId}.toml`,
    `${labId.replace(/-(?=\d)/g, ".")}.toml`,
    `${labId.replace(/\.(?=\d)/g, "-")}.toml`,
    `${labId.replace(/-latest$/, "")}.toml`,
    `${labId.replace(/^MiniMax-M/i, "minimax-m")}.toml`,
    `${labId.replace(/^minimax-m/i, "MiniMax-M")}.toml`,
  ];
  for (const cand of candidates) {
    const opts = readReasoningOptionsFromFile(path.join(dir, cand));
    if (opts !== undefined) return opts;
  }
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".toml")) continue;
    const p = path.join(dir, file);
    try {
      const parsed = Bun.TOML.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      if (parsed.base_model === baseModel && Array.isArray(parsed.reasoning_options)) {
        return parsed.reasoning_options as ReasoningControls;
      }
    } catch {}
  }
  return undefined;
}

export function resolveBaselineReasoningOptions(baseModel: string): ReasoningControls | undefined {
  if (baselineOptionsCache.has(baseModel)) {
    return baselineOptionsCache.get(baseModel);
  }

  const [lab, ...rest] = baseModel.split("/");
  const labId = rest.join("/");
  if (!lab || !labId) return undefined;

  let resolved: ReasoningControls | undefined = undefined;

  // 1. Lab first-party provider: providers/<lab>/models
  const labsToTry = lab === "zhipuai" ? ["zhipuai", "zai"] : [lab];
  for (const l of labsToTry) {
    const fp = searchDirForBaseline(path.join(PROVIDERS_DIR, l, "models"), baseModel, labId);
    if (fp !== undefined) {
      resolved = fp;
      break;
    }
  }

  // 2. OpenRouter peer relay: providers/openrouter/models/<lab> or providers/openrouter/models/<baseModel>.toml
  // If lab has only budget_tokens (and no toggle or effort), look for a relay peer like OpenRouter.
  const onlyBudgetTokens = Array.isArray(resolved) && resolved.length > 0 && resolved.every((o) => o.type === "budget_tokens");
  if (resolved === undefined || onlyBudgetTokens) {
    const orLab = searchDirForBaseline(path.join(PROVIDERS_DIR, "openrouter", "models", lab), baseModel, labId);
    if (orLab !== undefined) {
      resolved = orLab;
    } else {
      const orRoot = readReasoningOptionsFromFile(path.join(PROVIDERS_DIR, "openrouter", "models", `${baseModel}.toml`));
      if (orRoot !== undefined) {
        resolved = orRoot;
      }
    }
  }

  // 3. Established relay peers: vercel, cortecs, nvidia, empiriolabs, huggingface, opencode
  if (resolved === undefined) {
    for (const peer of ["vercel", "cortecs", "nvidia", "empiriolabs", "huggingface", "opencode"]) {
      const peerLab = searchDirForBaseline(path.join(PROVIDERS_DIR, peer, "models", lab), baseModel, labId);
      if (peerLab !== undefined) {
        resolved = peerLab;
        break;
      }
      const peerRoot = searchDirForBaseline(path.join(PROVIDERS_DIR, peer, "models"), baseModel, labId);
      if (peerRoot !== undefined) {
        resolved = peerRoot;
        break;
      }
    }
  }

  baselineOptionsCache.set(baseModel, resolved);
  return resolved;
}

// Whether the catalog reported a caller-control surface for this reasoning model. A missing
// `reasoning_efforts` is "unknown" (skip + report), NOT an affirmative always-on `[]`.
function hasReasoningEfforts(model: NeosantaraSourceModel) {
  return Array.isArray(mapping(model).reasoning_efforts);
}

// Multi-model relays must baseline reasoning_options on the resolved lab/first-party entry and
// established same-surface peers (AGENTS.md & audit skill Step 2), intersecting host capabilities.
//
// On Neosantara (an OpenAI-compatible relay), the documented wire control is reasoning_effort.
// Turning off thinking is achieved via reasoning_effort = "none". Per AGENTS.md:
// - If the catalog advertises [] -> affirmative always-on, no caller control ([]).
// - If the catalog advertises ["none"] alone -> binary on/off only ([{ type: "toggle" }]).
// - If the catalog advertises none + graded levels -> effort with none included ([{ type: "effort", values: ["none", ...] }]),
//   never toggle+effort hybrid.
export function neosantaraReasoningControls(
  model: NeosantaraSourceModel,
  baseModelOrExisting?: string | ExistingModel,
  _existing?: ExistingModel,
): ReasoningControls {
  if (model.id === "mistral-small-latest") {
    return [{ type: "effort", values: ["none", "high"] }];
  }

  const map = mapping(model);
  // Catalog [] means affirmative always-on / no caller control.
  if (Array.isArray(map.reasoning_efforts) && map.reasoning_efforts.length === 0) {
    return [];
  }

  const baseModel = typeof baseModelOrExisting === "string"
    ? baseModelOrExisting
    : resolveNeosantaraBaseModel(model);

  if (baseModel === undefined) return [];

  const baseline = resolveBaselineReasoningOptions(baseModel);
  if (baseline === undefined) return [];
  if (baseline.length === 0) return [];

  const catalogEfforts = (map.reasoning_efforts ?? []).filter((effort) =>
    HOST_EFFORT_SET.has(effort),
  );

  const baselineHasToggle = baseline.some((o) => o.type === "toggle");
  const baselineEffort = baseline.find((o) => o.type === "effort");
  const baselineValues = (baselineEffort?.values as string[] | undefined) ?? [];

  // Binary on/off alone: catalog explicitly has only ["none"], or baseline has only toggle and no effort.
  // On this host, callers control toggle via reasoning_effort = "none".
  if (
    (catalogEfforts.length === 1 && catalogEfforts[0] === "none") ||
    (baselineHasToggle && baselineValues.length === 0 && catalogEfforts.length === 0)
  ) {
    return [{ type: "toggle" }];
  }

  // When baseline has effort:
  if (baselineValues.length > 0) {
    // Intersect graded levels with catalog efforts
    const gradedValues = catalogEfforts.length > 0
      ? baselineValues.filter((e) => e !== "none" && catalogEfforts.includes(e))
      : baselineValues.filter((e) => e !== "none");

    // On this host, reasoning_effort is the wire control. If either the catalog or baseline
    // advertises "none", off is reasoning_effort = "none" (effort-with-none, no separate toggle).
    const includesNone = catalogEfforts.includes("none") || baselineValues.includes("none");
    const values = includesNone ? ["none", ...gradedValues] : gradedValues;

    if (values.length > 0) {
      return [{ type: "effort", values: values as never }];
    }
  }

  if (baselineHasToggle) {
    return [{ type: "toggle" }];
  }

  const filtered = baseline.filter((o) => o.type === "toggle" || o.type === "effort");
  return filtered.length > 0 ? filtered : [];
}

const TOGGLE_HEADER = `# Toggle: reasoning_effort = "none" turns thinking off; any other accepted value turns it on.
# Documented at https://docs.neosantara.xyz/en/capability/reasoning
`;

const EFFORT_NONE_HEADER = `# Effort: reasoning_effort = "none" turns thinking off; graded levels control depth.
# Documented at https://docs.neosantara.xyz/en/capability/reasoning
`;

const EFFORT_GRADED_HEADER = `# Effort: reasoning_effort controls thinking depth.
# Documented at https://docs.neosantara.xyz/en/capability/reasoning
`;

const TEXT_ONLY_KIRO_HEADER = `# Deployment limitation: text-only deployment on this host (upstream Kiro backend ignores image/multimodal input).
# Modalities explicitly restricted to text input with attachments disabled.
# Effort: reasoning_effort = "none" turns thinking off; graded levels control depth.
# Documented at https://docs.neosantara.xyz/en/capability/reasoning
`;

const TEXT_ONLY_MISTRAL_HEADER = `# Deployment limitation: text-only deployment on this host; attachments disabled.
`;

// Dedicated headers document always-on relays (minimax-m2.7, kimi-k2-thinking), text-only
// deployments (gpt-5.6-luna/sol, mistral), external baselines (muse-glimmer-30b), and verified
// reasoning effort/toggle controls cited from https://docs.neosantara.xyz/en/capability/reasoning.
export function neosantaraReasoningHeader(
  controls: ReasoningControls | undefined,
  modelId?: string,
  baseModel?: string,
) {
  if (modelId === "minimax-m2.7") {
    return `# Always-on thinking: upstream Dahl forwards no reasoning_effort parameter.
# Matches lab providers/minimax/models/MiniMax-M2.7.toml and peers OpenRouter/FastRouter/Cortecs.
`;
  }
  if (modelId === "kimi-k2-thinking") {
    return `# Dedicated thinking variant: always-on reasoning with no caller control.
# Matches lab providers/moonshotai/models/kimi-k2-thinking.toml and peers OpenRouter/Vercel.
`;
  }
  if (modelId === "muse-glimmer-30b") {
    return `# Sources:
# https://huggingface.co/meta-models/Muse-Glimmer-30B
# Effort: reasoning_effort = low|medium|high|xhigh
# Matches peers OpenRouter and Vercel AI Gateway.
`;
  }
  if (modelId === "gpt-5.6-luna" || modelId === "gpt-5.6-sol") {
    return TEXT_ONLY_KIRO_HEADER;
  }
  if (modelId === "mistral-large-latest") {
    return TEXT_ONLY_MISTRAL_HEADER;
  }
  if (modelId === "mistral-small-latest") {
    return `# Deployment limitation: text-only deployment on this host; attachments disabled.
# Effort: reasoning_effort = "none" turns thinking off; "high" turns thinking on.
# Documented at https://docs.neosantara.xyz/en/capability/reasoning
`;
  }

  const hasToggle = controls?.some((option) => option.type === "toggle");
  if (hasToggle) {
    return TOGGLE_HEADER;
  }

  const effortOption = controls?.find((option) => option.type === "effort");
  const effortValues = (effortOption?.values as string[] | undefined) ?? [];

  if (effortValues.includes("none")) {
    return EFFORT_NONE_HEADER;
  }
  if (effortValues.length > 0) {
    return EFFORT_GRADED_HEADER;
  }
  return undefined;
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

// Modalities as served by a specific deployment: a mapping without vision must
// not carry image/pdf/video input, regardless of what the model-level architecture
// claims — attachment=false with image/pdf/video input is contradictory.
export function deploymentModalities(model: NeosantaraSourceModel, vision: boolean | undefined) {
  const baseInput = modalities(model.architecture.input_modalities);
  if (vision !== false) {
    return {
      input: baseInput,
      output: modalities(model.architecture.output_modalities),
    };
  }
  const filtered = baseInput.filter(
    (value) => value !== "image" && value !== "pdf" && value !== "video",
  );
  return {
    input: filtered.length > 0 ? filtered : ["text"],
    output: modalities(model.architecture.output_modalities),
  };
}

// Image generators, or 100k+ context function-calling text models.
export function meetsNeosantaraPublicFilter(model: NeosantaraSourceModel) {
  return (
    isImageModel(model) ||
    ((model.context_length ?? 0) >= MIN_CONTEXT_WINDOW && mapping(model).tools === true)
  );
}

export function shouldSyncNeosantaraModel(model: NeosantaraSourceModel) {
  if (model.deprecated) return false;
  const baseModel = resolveNeosantaraBaseModel(model);
  if (baseModel === undefined) return false;
  if (!meetsNeosantaraPublicFilter(model)) return false;
  if (isImageModel(model)) return true;
  // Skip rather than throw: one missing price costs a single model, not the run.
  if (price(model.pricing.prompt) === undefined || price(model.pricing.completion) === undefined) {
    return false;
  }
  const map = mapping(model);
  const isReasoning = model.id === "mistral-small-latest" || map.reasoning === true;
  if (isReasoning) {
    const baseline = resolveBaselineReasoningOptions(baseModel);
    if (baseline === undefined) return false;
    if (map.reasoning === true && !hasReasoningEfforts(model) && baseline.length > 0) return false;
  }
  return true;
}

export function buildNeosantaraModel(
  model: NeosantaraSourceModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const baseModel = resolveNeosantaraBaseModel(model);
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
  const reasoning = model.id === "mistral-small-latest" || map.reasoning === true;
  const inputCost = price(model.pricing.prompt);
  const outputCost = price(model.pricing.completion);
  if (inputCost === undefined || outputCost === undefined) {
    throw new Error(`Missing token pricing for Neosantara model '${model.id}'`);
  }

  return factorBaseModel(
    baseModel,
    {
      name: model.override_name,
      reasoning,
      reasoning_options: reasoning ? neosantaraReasoningControls(model, baseModel, existing) : undefined,
      interleaved: reasoning ? { field: "reasoning_content" as const } : undefined,
      attachment: map.vision,
      tool_call: map.tools,
      structured_output: model.structured_outputs === false ? false : undefined,
      modalities: deploymentModalities(model, map.vision),
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
      `${ids.length} Neosantara models were not created because they lack a canonical \`models/\` entry to inherit, the catalog reported no usable token pricing, or a reasoning model did not resolve to a known lab/peer reasoning baseline.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
      "Ensure the catalog provides a valid base_model or add a `models/<provider>/<model>.toml` entry to include them in the next sync.",
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
    const baseModel = resolveNeosantaraBaseModel(model);
    const translated = buildNeosantaraModel(model, context.existing(model.id));
    return {
      id: model.id,
      model: translated,
      header: neosantaraReasoningHeader(translated.reasoning_options, model.id, baseModel),
    };
  },
} satisfies SyncProvider<NeosantaraSourceModel>;
