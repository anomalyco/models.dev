import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import {
  factorBaseModel,
  resolveCanonicalBaseModel,
  resolveModelMetadataBaseModel,
} from "./openrouter.js";

// Experiential Labs exposes a public, unauthenticated model catalog, so no
// API key is needed or used for this sync.
const API_ENDPOINT = "https://api.experientiallabs.ai/api/models?limit=1000";

// Keep this for slugs that cannot be derived from a lab filename.
// Family prefixes, version-dot slugs, unique filenames, and deployment
// suffixes are resolved automatically by resolveExperientiallabsBaseModel.
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
    default_provider_ids: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

const ExperientialResponse = z
  .object({
    models: z.array(ExperientialEntry),
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
      `${ids.length} Experiential Labs models returned by the API were not created because they could not be mapped exactly to models.dev canonical metadata. `
        + "Existing models and canonical matches are still updated from API-authoritative fields.",
      `Skipped slugs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Experiential Labs request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // Text chat models with at least one usable serving rung. Skips the Jev
    // decisions API (a native surface, not OpenAI-compatible chat) and
    // non-text output lanes (embeddings, image, audio, video).
    return ExperientialResponse.parse(raw).models.filter((entry) => {
      const model = entry.model;
      if (model.slug.startsWith("jev-")) return false;
      if (!(model.output_modalities ?? []).includes("text")) return false;
      return orderedUsableRungs(entry).length > 0;
    });
  },
  translateModel(entry, context) {
    const model = entry.model;
    const existing = context.existing(model.slug);
    const baseModel = existing?.base_model ?? resolveExperientiallabsBaseModel(model.slug, model.icon);
    // A model with no existing file and no canonical match cannot be created.
    if (existing === undefined && baseModel === undefined) return undefined;
    const built = buildExperientiallabsModel(entry, existing, baseModel);
    // A model with no usable context window cannot produce a valid TOML
    // (limit.context is required), so skip it rather than fail the whole sync.
    if (built === undefined) return undefined;
    return {
      id: model.slug,
      model: built.model,
      header: built.header,
    };
  },
} satisfies SyncProvider<ExperientialEntry>;

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
  return value >= 0 ? Math.round((value / 1_000_000_000) * 1_000_000) / 1_000_000 : undefined;
}

function nonZeroPrice(value: number | null | undefined) {
  const result = price(value);
  return result !== undefined && result > 0 ? result : undefined;
}

function modalities(values: string[] | null | undefined, fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = (values ?? [])
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

// A rung is usable when it is active, routable, and carries host-managed
// pricing. Customer-managed rungs (e.g. BYO-key azure_openai) report null
// prices and are excluded.
function usableRung(rung: ExperientialRung): boolean {
  return rung.status === "active"
    && rung.routable !== false
    && rung.input_nano_usd_per_million !== null
    && rung.input_nano_usd_per_million !== undefined
    && rung.output_nano_usd_per_million !== null
    && rung.output_nano_usd_per_million !== undefined;
}

// Usable rungs in serving order: the default waterfall (default_provider_ids)
// first, then any remaining usable rungs in catalog order. Pricing and
// capabilities are read from the first rung in this order, which is the
// rung the gateway serves by default.
function orderedUsableRungs(entry: ExperientialEntry): ExperientialRung[] {
  const usable = entry.providers.filter(usableRung);
  const ordered: ExperientialRung[] = [];
  for (const id of entry.default_provider_ids ?? []) {
    const rung = usable.find((candidate) => candidate.id === id);
    if (rung !== undefined && !ordered.includes(rung)) ordered.push(rung);
  }
  for (const rung of usable) {
    if (!ordered.includes(rung)) ordered.push(rung);
  }
  return ordered;
}

// Effort values reported by this model's usable serving rungs in the catalog.
// These are used for two purposes: trimming the lab baseline down to values
// the gateway also accepts, and (when no lab/peer effort baseline exists)
// reporting the values this model's serving rungs document. Rung-reported
// values are always attributed as per-model gateway capability data in the
// header, never presented as lab controls.
function unionEffortValues(rungs: ExperientialRung[]): EffortValue[] {
  const union = new Set<string>();
  for (const rung of rungs) {
    for (const value of rung.capabilities?.supported_reasoning_efforts ?? []) {
      if ((EFFORT_VALUES as string[]).includes(value)) union.add(value);
    }
  }
  return EFFORT_VALUES.filter((value) => union.has(value));
}

// Reasoning controls come from the lab's first-party model definition
// (providers/<lab>/models/<model>.toml), falling back to the canonical
// metadata file. The lab baseline owns which controls exist (toggle, effort,
// budget_tokens) and the wire paths for them; the gateway only narrows the
// effort values.
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

function readCandidate(filePath: string): { text: string; parsed: unknown } | undefined {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  try {
    return { text, parsed: Bun.TOML.parse(text) };
  } catch {
    // Windows checkouts without core.symlinks materialize git symlinks as
    // plain text files containing the link target path. Resolve such
    // stand-ins and read the real file; on Linux readFileSync already
    // follows the symlink, so both platforms see the same content.
    const target = text.trim();
    if (!/[/\\]/.test(target) || !/\.toml$/i.test(target)) return undefined;
    const resolved = path.resolve(path.dirname(filePath), target);
    if (!existsSync(resolved)) return undefined;
    try {
      const resolvedText = readFileSync(resolved, "utf8");
      return { text: resolvedText, parsed: Bun.TOML.parse(resolvedText) };
    } catch {
      return undefined;
    }
  }
}

function readLabControls(baseModel: string, slug: string): LabControls | undefined {
  const [lab, modelID] = baseModel.split("/");
  if (lab === undefined || modelID === undefined) return undefined;
  // Priority: the lab's first-party provider definition, then the canonical
  // metadata file, then relay peers. Lab layers are authoritative — an
  // explicit `reasoning_options = []` authored by the lab means "no caller
  // control" and blocks the peer fallback; peers are only consulted when
  // the lab layers do not state options at all.
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
    {
      filePath: path.join(REPO_ROOT, "models", `${baseModel}.toml`),
      sourcePath: `models/${baseModel}.toml`,
      kind: "lab" as const,
    },
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
    const read = readCandidate(candidate.filePath);
    if (read === undefined) continue;
    const parsed = read.parsed;
    const data = LabReasoning.safeParse(parsed);
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
  const cacheRead = nonZeroPrice(rung.cached_input_nano_usd_per_million);
  const cacheWrite = nonZeroPrice(rung.cache_write_input_nano_usd_per_million);
  const reasoning = nonZeroPrice(rung.reasoning_nano_usd_per_million);
  const threshold = rung.long_context_threshold_tokens;
  const longInput = price(rung.long_context_input_nano_usd_per_million);
  const longOutput = price(rung.long_context_output_nano_usd_per_million);
  const longCacheRead = nonZeroPrice(rung.long_context_cached_input_nano_usd_per_million);
  const tiers = threshold !== undefined
      && threshold !== null
      && longInput !== undefined
      && longOutput !== undefined
    ? [
        {
          tier: { type: "context" as const, size: threshold },
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

// Deployment lanes are stripped to reach the canonical id: context-size lanes
// ("-24k"), version lanes ("-v1-0"), and dated lanes ("-08-2024"). Suffixes
// that mean a DIFFERENT model (fine-tune numbers, "-batch", "-contributor")
// are never stripped so those rows skip instead of mis-resolving.
function stripDeploymentSuffixes(id: string) {
  const out: string[] = [];
  let source = id.replace(/-\d+k$/, "");
  if (source !== id) out.push(source);
  if (/-v\d+(-\d+)?$/.test(source)) {
    const dropPatch = source.replace(/-\d+$/, "");
    if (dropPatch !== source) out.push(dropPatch);
    out.push(source.replace(/-v\d+(-\d+)?$/, ""));
  }
  if (/-\d{4}$/.test(source)) out.push(source.replace(/-\d{4}$/, ""));
  return out;
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
    for (const stripped of stripDeploymentSuffixes(seed)) {
      if (!variants.includes(stripped)) variants.push(stripped);
    }
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

export function buildExperientiallabsModel(
  entry: ExperientialEntry,
  existing: ExistingModel | undefined,
  baseModel = existing?.base_model ?? resolveExperientiallabsBaseModel(entry.model.slug, entry.model.icon),
): { model: SyncedModel; header?: string } | undefined {
  const model = entry.model;
  const rungs = orderedUsableRungs(entry);
  const rung = rungs[0];
  if (rung === undefined) return undefined;
  const params = (model.supported_params ?? {}) as Record<string, unknown>;
  const input = modalities(model.input_modalities, ["text"]);
  const output = modalities(model.output_modalities, ["text"]);
  const attachment = input.some((value) => value !== "text");
  // The lab baseline owns the reasoning flag; gateway rung hints only apply
  // when the lab definition does not state one.
  const lab = baseModel !== undefined ? labControls(baseModel, model.slug) : undefined;
  const hostReasoning = rungs.some((candidate) => candidate.capabilities?.supports_reasoning === true)
    || params.reasoning === true
    || existing?.reasoning === true;
  const reasoning = lab?.reasoning ?? hostReasoning;
  const toolCall = params.tools === true || existing?.tool_call === true;
  const structuredOutput = params.structured_outputs === true || existing?.structured_output === true;
  const temperature = params.temperature === true || existing?.temperature === true;

  // The Experiential Labs chat surface exposes exactly one verified reasoning
  // wire: reasoning_effort (llms.txt; live-tested 2026-10-07 — enable_thinking
  // and the DeepSeek-style thinking object are both translated to
  // reasoning_effort, and thinking_budget is rejected on unqualified routes).
  // Only effort controls are emitted: toggles and budget_tokens from the
  // source are dropped with a note citing that evidence, and source wire
  // comments are never copied because they describe the source's surface.
  // Values come from the lab/peer baseline, trimmed to the effort values the
  // model's serving rungs also report; when the baseline has no effort
  // levels, the rung-reported values are used and attributed as per-model
  // gateway capability data. An explicit [] is written when nothing survives
  // so the runner never resurrects stale options from a previous file state.
  let reasoningOptions: SyncedModel["reasoning_options"] | undefined;
  let header: string | undefined;
  if (reasoning && lab?.options !== undefined && lab.options.length > 0) {
    const hostUnion = unionEffortValues(rungs);
    const droppedControls = lab.options.filter((option) => option.type !== "effort").length;
    const labValues = EFFORT_VALUES.filter((value) =>
      lab.options.some((option) => option.type === "effort" && option.values.includes(value)),
    );
    let values: EffortValue[] = labValues;
    if (labValues.length > 0 && hostUnion.length > 0) {
      const trimmed = labValues.filter((value) => hostUnion.includes(value));
      if (trimmed.length > 0) values = trimmed;
    } else if (labValues.length === 0) {
      values = hostUnion;
    }
    reasoningOptions = values.length > 0 ? [{ type: "effort", values }] : [];
    const headerLines = [
      `# Reasoning controls copied from the ${lab.sourcePath} ${lab.kind === "peer" ? "relay peer" : "lab"} baseline.`,
    ];
    if (values.length > 0) headerLines.push(`# Effort: reasoning_effort = ${values.join("|")}`);
    if (values.length > 0 && labValues.length === 0) {
      headerLines.push(
        "# Effort values reported by this model's serving rungs in the Experiential Labs catalog (per-model capability data); no lab/peer effort baseline exists.",
      );
    }
    if (droppedControls > 0) {
      headerLines.push(
        "# Toggle and budget controls from the source are not emitted: the Experiential Labs OpenAI-compatible chat surface exposes no native on/off or budget request field - enable_thinking and thinking are translated to reasoning_effort and thinking_budget is rejected on unqualified routes (live-tested 2026-10-07; see platform.experientiallabs.ai/llms.txt).",
      );
    }
    if (values.length === 0) {
      headerLines.push(
        "# Reasoning controls: none - the model's serving rungs report no reasoning-effort controls in the Experiential Labs catalog, no lab/peer effort baseline exists, and the chat surface exposes no native on/off or budget field (live-tested 2026-10-07; see platform.experientiallabs.ai/llms.txt).",
      );
    }
    header = headerLines.join("\n") + "\n";
  } else if (reasoning && lab?.options !== undefined && lab.options.length === 0) {
    // The lab itself authors `reasoning_options = []` — record the provenance
    // of the empty set instead of leaving the stamped [] unexplained.
    header = `# Reasoning controls copied from the ${lab.sourcePath} ${lab.kind === "peer" ? "relay peer" : "lab"} baseline: it authors \`reasoning_options = []\` — no caller control is documented.\n`;
  }

  const cost = buildCost(rung, existing);
  const context = model.context_window ?? existing?.limit?.context;
  // No usable context window: cannot build a valid model TOML, so skip.
  if (context === undefined || context === null) return undefined;

  const releaseDate = baseModel === undefined
    ? model.release_date ?? existing?.release_date
    : undefined;
  const lastUpdated = baseModel === undefined
    ? model.release_date ?? existing?.last_updated ?? releaseDate
    : existing?.last_updated ?? releaseDate;
  const limit = {
    context,
    input: model.max_input_tokens ?? existing?.limit?.input,
    output: model.max_output_tokens ?? existing?.limit?.output,
  };
  const values: Partial<SyncedFullModel> = {
    name: model.display_name ?? model.slug,
    description: baseModel === undefined
      ? existing?.description ?? model.description ?? undefined
      : existing?.description,
    family: existing?.family,
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment,
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: temperature || undefined,
    tool_call: toolCall,
    structured_output: structuredOutput || undefined,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  };

  if (baseModel !== undefined) {
    return {
      model: factorBaseModel(baseModel, values, limit, existing?.base_model_omit),
      header,
    };
  }

  if (existing === undefined) return undefined;
  const required = z.object({
    name: z.string(),
    description: z.string(),
    release_date: z.string(),
    last_updated: z.string(),
    open_weights: z.boolean(),
    cost: z.object({ input: z.number(), output: z.number() }),
  }).safeParse(values);
  if (!required.success) {
    throw new Error(`Experiential Labs model ${model.slug} has incomplete local metadata required for sync`);
  }

  return { model: values as SyncedFullModel, header };
}
