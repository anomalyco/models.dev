import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { readProviderModel } from "../../translate.js";
import {
  factorBaseModel,
  modelMetadata,
  resolveCanonicalBaseModel,
  resolveModelMetadataBaseModel,
} from "./openrouter.js";

// Experiential Labs exposes a public, unauthenticated model catalog, so no
// API key is needed or used for this sync.
const API_ENDPOINT = "https://api.experientiallabs.ai/api/models";

// Keep this for slugs that cannot be derived from a lab filename.
// Family prefixes, version-dot slugs, and unique filenames are resolved
// automatically by resolveExperientiallabsBaseModel.
const CANONICAL_BASE_MODELS: Record<string, string> = {
  "grok-4.20": "xai/grok-4.20-0309-reasoning",
  "grok-4.20-non-reasoning": "xai/grok-4.20-0309-non-reasoning",
};

// The catalog's `icon` field names the upstream lab for ~1/4 of the rows.
// Mapped to the models.dev canonical prefix used by resolveCanonicalBaseModel.
const ICON_LAB: Record<string, string> = {
  openai: "openai",
  zai: "z-ai",
  qwen: "qwen",
  anthropic: "anthropic",
  amazon: "amazon",
  google: "google",
  mistral: "mistralai",
  deepseek: "deepseek",
  tencent: "tencent",
  meta: "meta",
  moonshot: "moonshotai",
  xai: "xai",
  xiaomi: "xiaomi",
  cohere: "cohere",
  inclusionai: "inclusionai",
  nvidia: "nvidia",
  sakana: "sakana",
  thinkingmachines: "thinkingmachines",
  bytedance: "bytedance-seed",
  minimax: "minimax",
  microsoft: "microsoft",
  ibm: "ibm",
  upstage: "upstage",
  writer: "writer",
  typesafe: "typesafe",
  poolside: "poolside",
  meituan: "meituan",
  ai21: "ai21",
};

const ExperientialCapabilities = z
  .object({
    supports_reasoning: z.boolean().nullable().optional(),
    supported_reasoning_efforts: z.array(z.string()).nullable().optional(),
    supports_temperature: z.boolean().nullable().optional(),
    supports_tools: z.boolean().nullable().optional(),
    supports_structured_output: z.boolean().nullable().optional(),
    supports_logprobs: z.boolean().nullable().optional(),
    supports_embeddings: z.boolean().nullable().optional(),
  })
  .passthrough();

// A "rung" is one upstream serving route for a model. Prices are nano-USD per
// million tokens; only host-managed rungs carry pricing.
const ExperientialRung = z
  .object({
    id: z.string().optional(),
    provider: z.string().optional(),
    billing_source: z.string(),
    input_nano_usd_per_million: z.number().nullable().optional(),
    cached_input_nano_usd_per_million: z.number().nullable().optional(),
    cache_write_input_nano_usd_per_million: z.number().nullable().optional(),
    output_nano_usd_per_million: z.number().nullable().optional(),
    reasoning_nano_usd_per_million: z.number().nullable().optional(),
    long_context_threshold_tokens: z.number().nullable().optional(),
    long_context_input_nano_usd_per_million: z.number().nullable().optional(),
    long_context_cached_input_nano_usd_per_million: z.number().nullable().optional(),
    long_context_output_nano_usd_per_million: z.number().nullable().optional(),
    capabilities: ExperientialCapabilities.nullable().optional(),
    status: z.string().optional(),
    routable: z.boolean().nullable().optional(),
  })
  .passthrough();

const ExperientialModel = z
  .object({
    slug: z.string(),
    display_name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    release_date: z.string().nullable().optional(),
    context_window: z.number().nullable().optional(),
    max_input_tokens: z.number().nullable().optional(),
    max_output_tokens: z.number().nullable().optional(),
    input_modalities: z.array(z.string()).nullable().optional(),
    output_modalities: z.array(z.string()).nullable().optional(),
    supported_params: z.record(z.unknown()).nullable().optional(),
    icon: z.string().nullable().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const ExperientialEntry = z
  .object({
    model: ExperientialModel,
    providers: z.array(ExperientialRung),
    default_provider_ids: z.array(z.string()),
  })
  .passthrough();

const ExperientialResponse = z
  .object({
    models: z.array(ExperientialEntry),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  })
  .passthrough();

export type ExperientialEntry = z.infer<typeof ExperientialEntry>;
export type ExperientialRung = z.infer<typeof ExperientialRung>;

export const experientiallabs = {
  id: "experientiallabs",
  name: "Experiential Labs",
  modelsDir: "providers/experientiallabs/models",
  // The sync generates the wire-path headers for copied reasoning controls,
  // so its header must win over any stale header from a previous run.
  authoritativeHeaders: true,
  sourceID(entry) {
    return entry.model.slug;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Experiential Labs models returned by the API were not created because they need canonical metadata or verified reasoning controls. `
        + "Existing unresolved entries are preserved for manual review.",
      `Skipped slugs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  fetchModels: fetchExperientiallabsModels,
  parseModels(raw) {
    const data = ExperientialResponse.parse(raw);
    const ids = data.models.map((entry) => entry.model.slug);
    if (ids.length === 0 || ids.length !== data.total || new Set(ids).size !== ids.length) {
      throw new Error("Experiential Labs returned an empty, incomplete, or duplicate catalog");
    }
    return data.models;
  },
  missingModelID(entry) {
    return eligible(entry) ? entry.model.slug : undefined;
  },
  trackMissingModels: false,
  translateModel(entry, context) {
    if (!eligible(entry)) return undefined;
    const model = entry.model;
    const existing = context.existing(model.slug);
    const baseModel = existing?.base_model ?? resolveExperientiallabsBaseModel(model.slug, model.icon);
    // A model with no existing file and no canonical match cannot be created.
    if (existing === undefined && baseModel === undefined) return undefined;
    const built = buildExperientiallabsModel(entry, existing, baseModel);
    // Keep unresolved models for manual review instead of inventing controls.
    if (built === undefined) return undefined;
    return {
      id: model.slug,
      model: built.model,
      header: built.header,
    };
  },
} satisfies SyncProvider<ExperientialEntry>;

export async function fetchExperientiallabsModels(fetcher: typeof fetch = fetch) {
  const models: ExperientialEntry[] = [];
  let total: number | undefined;
  while (total === undefined || models.length < total) {
    const response = await fetcher(`${API_ENDPOINT}?limit=1000&offset=${models.length}`);
    if (!response.ok) throw new Error(`Experiential Labs request failed: ${response.status}`);
    const page = ExperientialResponse.parse(await response.json());
    if (page.offset !== models.length || page.models.length === 0 || (total !== undefined && page.total !== total)) {
      throw new Error("Experiential Labs catalog changed or returned an incomplete page; retry the sync");
    }
    total = page.total;
    models.push(...page.models);
  }
  return { models, total, offset: 0, limit: 1000 };
}

function eligible(entry: ExperientialEntry) {
  const rung = orderedUsableRungs(entry)[0];
  return entry.model.status === "active"
    && entry.model.output_modalities?.includes("text") === true
    && rung !== undefined
    && (rung.capabilities?.supports_tools ?? entry.model.supported_params?.tools) === true
    && rung.capabilities?.supports_embeddings !== true;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";
type EffortValue =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "default";

const EFFORT_VALUES: EffortValue[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
];

// Converts nano-USD per million tokens to USD per million tokens.
function price(value: number | null | undefined) {
  if (value === undefined || value === null) return undefined;
  return Number.isFinite(value) && value >= 0 ? value / 1_000_000_000 : undefined;
}

function modalities(values: string[] | null | undefined, fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = (values ?? [])
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

// Only the published default waterfall is callable with an Experiential key.
// Other catalog deployments may require a customer's upstream provider key.
function orderedUsableRungs(entry: ExperientialEntry): ExperientialRung[] {
  return entry.default_provider_ids.flatMap((id) => {
    const rung = entry.providers.find((candidate) => candidate.id === id);
    return rung !== undefined
      && rung.status === "active"
      && rung.routable === true
      && rung.billing_source === "host_managed"
      && price(rung.input_nano_usd_per_million) !== undefined
      && price(rung.output_nano_usd_per_million) !== undefined
      ? [rung] : [];
  });
}

// Read per-host controls through the repository's v2 reader. Canonical lab
// metadata deliberately has no controls and must not hide a relay peer.
const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..", "..", "..");
const PROVIDERS_DIR = path.join(REPO_ROOT, "providers");

const LabReasoningOption = z.union([
  z.object({ type: z.literal("toggle") }).passthrough(),
  z.object({ type: z.literal("effort"), values: z.array(z.string()) }).passthrough(),
  z
    .object({ type: z.literal("budget_tokens"), min: z.number().optional(), max: z.number().optional() })
    .passthrough(),
]);

const LabReasoning = z
  .object({
    reasoning: z.boolean().optional(),
    reasoning_options: z.array(LabReasoningOption).optional(),
  })
  .passthrough();

export type LabReasoningOption = z.infer<typeof LabReasoningOption>;

interface LabControls {
  reasoning?: boolean;
  options?: LabReasoningOption[];
  sourcePath: string;
  kind: "lab" | "peer";
}

const labControlsCache = new Map<string, LabControls | undefined>();

// The cache key includes the catalog slug: peer lookups probe slug-derived
// filename spellings, so two slugs resolving to the same base model can find
// different peer files.
function labControls(baseModel: string, slug: string): LabControls | undefined {
  const cacheKey = `${baseModel}|${slug}`;
  if (!labControlsCache.has(cacheKey)) {
    labControlsCache.set(cacheKey, readLabControls(baseModel, slug));
  }
  return labControlsCache.get(cacheKey);
}

// Relay peers are consulted only when the lab layers state no options at
// all. OpenRouter nests peer models under its own provider ids, Vercel
// nests them under the lab's metadata dir, and Cortecs keeps a flat
// models/ dir; probe all three layouts in a fixed, deterministic order.
const PEER_DIRS = ["openrouter", "vercel", "cortecs"] as const;

// Peer dirs can nest relay models under lab ids that differ from the
// canonical metadata dir for a few labs.
const PEER_DIR_ALIASES: Record<string, string[]> = {
  zhipuai: ["z-ai"],
  alibaba: ["qwen"],
  mistral: ["mistralai"],
};

// A few labs publish their first-party provider files under a dir name that
// differs from the canonical metadata dir.
const FIRST_PARTY_DIR_ALIASES: Record<string, string[]> = {
  "arcee-ai": ["arcee"],
};

function readLabControls(baseModel: string, slug: string): LabControls | undefined {
  const [lab, modelID] = baseModel.split("/");
  if (lab === undefined || modelID === undefined) return undefined;
  // First-party controls take precedence over relay peers, including an
  // explicit empty set. Missing controls do not mean there is no control.
  const labDirs = [...(FIRST_PARTY_DIR_ALIASES[lab] ?? []), lab].filter(
    (dir, index, all) => all.indexOf(dir) === index,
  );
  // Peers name files after the upstream provider id, which can keep
  // deployment suffixes the canonical id drops (nova-2-lite-v1.toml) or use
  // dashes where the canonical id uses dots (seed-2-1-turbo.toml). Probe the
  // canonical id plus the catalog slug and its dot/dash spellings.
  const peerFiles = [
    ...new Set([
      modelID,
      slug,
      applyVersionDots(slug),
      modelID.replace(/\./g, "-"),
      slug.replace(/\./g, "-"),
    ]),
  ];
  const peerDirs = [...(PEER_DIR_ALIASES[lab] ?? []), lab].filter(
    (dir, index, all) => all.indexOf(dir) === index,
  );
  const candidates: Array<{ filePath: string; sourcePath: string; kind: "lab" | "peer" }> = [
    ...labDirs.map((dir) => ({
      filePath: path.join(PROVIDERS_DIR, dir, "models", `${modelID}.toml`),
      sourcePath: `providers/${dir}/models/${modelID}.toml`,
      kind: "lab" as const,
    })),
    ...PEER_DIRS.flatMap((peerDir) => [
      ...peerDirs.flatMap((dir) =>
        peerFiles.map((file) => ({
          filePath: path.join(PROVIDERS_DIR, peerDir, "models", dir, `${file}.toml`),
          sourcePath: `providers/${peerDir}/models/${dir}/${file}.toml`,
          kind: "peer" as const,
        })),
      ),
      ...peerFiles.map((file) => ({
        filePath: path.join(PROVIDERS_DIR, peerDir, "models", `${file}.toml`),
        sourcePath: `providers/${peerDir}/models/${file}.toml`,
        kind: "peer" as const,
      })),
    ]),
  ];
  let reasoningSource: LabControls | undefined;
  let optionsSource: LabControls | undefined;
  for (const candidate of candidates) {
    if (!existsSync(candidate.filePath)) continue;
    const data = LabReasoning.safeParse(readProviderModel(candidate.filePath));
    if (!data.success) continue;
    const controls: LabControls = {
      reasoning: data.data.reasoning,
      options: data.data.reasoning_options,
      sourcePath: candidate.sourcePath,
      kind: candidate.kind,
    };
    if (reasoningSource === undefined && data.data.reasoning !== undefined) reasoningSource = controls;
    if (optionsSource === undefined && data.data.reasoning_options !== undefined) optionsSource = controls;
  }
  const source = optionsSource ?? reasoningSource;
  if (source === undefined) return undefined;
  return {
    reasoning: reasoningSource?.reasoning,
    options: optionsSource?.options,
    sourcePath: source.sourcePath,
    kind: source.kind,
  };
}

function buildCost(
  rung: ExperientialRung,
  existing: ExistingModel | undefined,
): SyncedFullModel["cost"] {
  const input = price(rung.input_nano_usd_per_million);
  const output = price(rung.output_nano_usd_per_million);
  if (input === undefined || output === undefined) return existing?.cost;
  const cacheRead = price(rung.cached_input_nano_usd_per_million);
  const cacheWrite = price(rung.cache_write_input_nano_usd_per_million);
  const reasoning = price(rung.reasoning_nano_usd_per_million);
  const threshold = rung.long_context_threshold_tokens;
  const longInput = price(rung.long_context_input_nano_usd_per_million);
  const longOutput = price(rung.long_context_output_nano_usd_per_million);
  const longCacheRead = price(rung.long_context_cached_input_nano_usd_per_million);
  const tiers = threshold !== undefined
      && threshold !== null
      && Number.isInteger(threshold)
      && threshold > 0
      && longInput !== undefined
      && longOutput !== undefined
    ? [
        {
          // Experiential starts the tier at >= threshold; models.dev uses >.
          tier: { type: "context" as const, size: threshold - 1 },
          input: longInput,
          output: longOutput,
          ...(longCacheRead !== undefined ? { cache_read: longCacheRead } : {}),
        },
      ]
    : [];
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cache_write: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(tiers.length > 0 ? { tiers } : {}),
  };
}

function applyVersionDots(id: string) {
  return id
    .replace(/(\d)p(\d)/, "$1.$2")
    .replace(/^(qwen\d+)-(\d+)/, "$1.$2")
    .replace(/^(seed-\d+)-(\d+)/, "$1.$2")
    .replace(/^(muse-[a-z]+)-(\d+)-(\d+)$/, "$1-$2.$3")
    .replace(/^(glm-\d+)-(\d+)/, "$1.$2")
    .replace(/^(grok-\d+)-(\d+)/, "$1.$2")
    .replace(/^(kimi-k\d+)-(\d+)/, "$1.$2")
    .replace(/^(minimax-m\d+)-(\d+)/, "$1.$2")
    .replace(/^(mimo-v\d+)-(\d+)/, "$1.$2")
    .replace(/^(deepseek-v\d+)-(\d+)/, "$1.$2")
    .replace(/^(step-\d+)-(\d+)/, "$1.$2");
}

function idVariants(id: string) {
  // "meta-llama-3-70b-instruct" resolves against models/meta by dropping the
  // brand prefix; "nous-" is carried along for the same reason.
  const brandless = id.replace(/^(meta|nous)-/, "");
  const seeds = [
    id,
    applyVersionDots(id),
    brandless,
    applyVersionDots(brandless),
  ];
  const variants: string[] = [];
  for (const seed of seeds) {
    if (!variants.includes(seed)) variants.push(seed);
  }
  return variants;
}

function prefixesFor(id: string) {
  if (/^(gpt-|chatgpt-|dall-e-)/.test(id) || /^(o1|o3|o4)(-|$)/.test(id)) return ["openai"];
  if (id.startsWith("claude-")) return ["anthropic"];
  if (id.startsWith("gemini-") || id.startsWith("gemma-")) return ["google"];
  if (id.startsWith("grok-")) return ["xai"];
  if (id.startsWith("kimi-")) return ["moonshotai"];
  if (id.startsWith("glm-")) return ["z-ai"];
  if (id.startsWith("deepseek-")) return ["deepseek"];
  if (id.startsWith("qwen")) return ["qwen"];
  if (id.startsWith("minimax-")) return ["minimax"];
  if (/^(mistral|ministral|mixtral|devstral|codestral|pixtral|magistral)-/.test(id)) return ["mistralai"];
  if (/^(llama-|llama3|meta-llama-|muse-)/.test(id)) return ["meta"];
  if (id.startsWith("nova-") || id.startsWith("titan-")) return ["amazon"];
  if (id.startsWith("nemotron-")) return ["nvidia"];
  if (id.startsWith("phi-")) return ["microsoft"];
  if (id.startsWith("command-") || id.startsWith("cohere-")) return ["cohere"];
  if (id.startsWith("seed-")) return ["bytedance-seed"];
  if (id.startsWith("fugu-")) return ["sakana"];
  if (id.startsWith("step") && !id.startsWith("stepaudio")) return ["stepfun"];
  if (id.startsWith("mimo-")) return ["xiaomi"];
  if (id.startsWith("sonar")) return ["perplexity"];
  if (id.startsWith("ling-")) return ["inclusionai"];
  if (id.startsWith("hunyuan")) return ["tencent"];
  return [];
}

export function resolveExperientiallabsBaseModel(id: string, icon?: string | null) {
  const explicit = CANONICAL_BASE_MODELS[id];
  if (explicit !== undefined) return explicit;

  const iconLab = icon !== undefined && icon !== null ? ICON_LAB[icon] : undefined;
  for (const variant of idVariants(id)) {
    for (const prefix of prefixesFor(variant)) {
      const resolved = resolveCanonicalBaseModel(`${prefix}/${variant}`);
      if (resolved !== undefined) return resolved;
      if (prefix === "google" && !variant.endsWith("-it")) {
        const instruct = resolveCanonicalBaseModel(`${prefix}/${variant}-it`);
        if (instruct !== undefined) return instruct;
      }
    }
    if (iconLab !== undefined) {
      const resolved = resolveCanonicalBaseModel(`${iconLab}/${variant}`);
      if (resolved !== undefined) return resolved;
    }
    const unique = resolveModelMetadataBaseModel(variant);
    if (unique !== undefined) return unique;
  }
  return undefined;
}

// Publish only controls verified both by the lab/peer baseline and by every
// default serving route. Toggle/budget models need explicit host wire mappings;
// leaving their options empty would incorrectly claim there is no caller control.
export function buildExperientiallabsModel(
  entry: ExperientialEntry,
  existing: ExistingModel | undefined,
  baseModel = existing?.base_model ?? resolveExperientiallabsBaseModel(entry.model.slug, entry.model.icon),
): { model: SyncedModel; header: string } | undefined {
  if (baseModel === undefined || !eligible(entry)) return undefined;
  const model = entry.model;
  const rungs = orderedUsableRungs(entry);
  const rung = rungs[0]!;
  const base = modelMetadata(baseModel);
  if (base.type !== undefined && base.type !== "chat") return undefined;
  const lab = labControls(baseModel, model.slug);
  const reasoning = base.reasoning === true;
  let reasoningOptions: SyncedModel["reasoning_options"];
  if (reasoning) {
    if (lab?.options === undefined || lab.options.some((option) => option.type !== "effort")) return undefined;
    const baseline = lab.options.flatMap((option) => option.type === "effort" ? option.values : []);
    const values = EFFORT_VALUES.filter((value) => baseline.includes(value)
      && rungs.every((route) => route.capabilities?.supported_reasoning_efforts?.includes(value)));
    if (baseline.length > 0 && values.length === 0) return undefined;
    // A lab with no control is only safe when the serving routes agree.
    if (baseline.length === 0 && rungs.some((route) => (route.capabilities?.supported_reasoning_efforts?.length ?? 0) > 0)) return undefined;
    reasoningOptions = values.length > 0 ? [{ type: "effort", values }] : [];
  }
  const context = model.context_window;
  const output = model.max_output_tokens;
  if (context === undefined || context === null || context <= 0 || output === undefined || output === null || output <= 0) return undefined;
  const limit = { context, input: model.max_input_tokens ?? undefined, output };
  const input = modalities(model.input_modalities, ["text"]);
  const params = model.supported_params ?? {};
  const values: Partial<SyncedFullModel> = {
    name: model.display_name ?? model.slug,
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: rungs.every((route) => (route.capabilities?.supports_temperature ?? params.temperature) === true),
    tool_call: true,
    structured_output: rungs.every((route) => (route.capabilities?.supports_structured_output ?? params.structured_outputs) === true),
    cost: buildCost(rung, existing),
    limit,
    modalities: { input, output: ["text"] },
  };
  const efforts = reasoningOptions?.flatMap((option) => option.type === "effort" ? option.values : []) ?? [];
  const header = [
    `# Source: https://api.experientiallabs.ai/api/models/${model.slug}`,
    "# List prices in USD per million tokens; temporary promotions are excluded.",
    ...(reasoning ? [`# Reasoning baseline: ${lab!.sourcePath}; restricted to all default serving routes.`] : []),
    ...(efforts.length > 0 ? [`# Effort: top-level reasoning_effort = ${efforts.join("|")}.`] : []),
    "# Host protocol: https://platform.experientiallabs.ai/docs/openai-compatibility",
  ].join("\n") + "\n";
  return { model: factorBaseModel(baseModel, values, limit, existing?.base_model_omit), header };
}
