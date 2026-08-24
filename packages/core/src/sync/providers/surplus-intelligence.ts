import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, modelMetadata, resolveCanonicalBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.surplusintelligence.ai/v1/models";
const OPENROUTER_MODELS_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "providers",
  "openrouter",
  "models",
);

// Surplus's `provider` field names the lab that built the model. Mapped to
// OpenRouter-shaped prefixes so resolveCanonicalBaseModel's candidate rules
// (Anthropic dot releases, `-fast` aliases, Llama digits, …) can be reused.
const LAB_PREFIXES: Record<string, string> = {
  OpenAI: "openai",
  Alibaba: "qwen",
  "Alibaba Cloud": "qwen",
  Qwen: "qwen",
  Google: "google",
  "Zhipu AI": "zai",
  "Z.ai": "zai",
  Anthropic: "anthropic",
  "Mistral AI": "mistralai",
  DeepSeek: "deepseek",
  Moonshot: "moonshotai",
  MiniMax: "minimax",
  xAI: "x-ai",
  SpaceXAI: "x-ai",
  Meta: "meta-llama",
  NVIDIA: "nvidia",
  Tencent: "tencent",
};

// Surplus IDs that do not resolve mechanically against models/ metadata.
// Keys are normalized IDs (`:web` route suffix and `e2ee-`/`-p` wrappers
// stripped); every target must exist under models/.
const BASE_MODEL_OVERRIDES: Record<string, string> = {
  "qwen3-coder": "alibaba/qwen3-coder-480b-a35b-instruct",
  "qwen3-coder-turbo": "alibaba/qwen3-coder-480b-a35b-instruct",
  "qwen3-235b-a22b-2507": "alibaba/qwen3-235b-a22b-instruct-2507",
  "qwen-2-5-7b": "alibaba/qwen2.5-7b-instruct",
  "mistral-small-3.2-24b-instruct": "mistral/mistral-small-2506",
  "mistral-small-4": "mistral/mistral-small-2603",
  "mistral-large-3": "mistral/mistral-large-2512",
  "devstral-2-123b": "mistral/devstral-2512",
  "ministral-3-3b-instruct": "mistral/ministral-3b-2512",
  "ministral-3-8b-instruct": "mistral/ministral-8b-2512",
  "ministral-3-14b-instruct": "mistral/ministral-14b-2512",
  "nvidia-nemotron-3-super-120b": "nvidia/nemotron-3-super-120b-a12b",
  "nvidia-nemotron-nano-12b-v2": "nvidia/nemotron-nano-12b-v2-vl",
  "gemini-3.1-pro": "google/gemini-3.1-pro-preview",
  "glm-4.7-thinking": "zhipuai/glm-4.7",
  "glm-5.1-non-thinking": "zhipuai/glm-5.1",
  "grok-4.20-beta": "xai/grok-4.20-0309-reasoning",
  "hy3-free": "tencent/hy3",
  "hermes-3-llama-3.1-405b": "nousresearch/hermes-3-llama-3.1-405b",
  "mercury-2": "inception/mercury-2",
  "aion-labs.aion-2-0": "aion-labs/aion-2.0",
};

// Surplus reports a placeholder `created` timestamp (2025-01-01) for its
// marketplace-only routes. Real ship dates for the ones documented elsewhere
// in this repo: Venice house models from providers/venice/models, the Grok
// 4.20 beta from the OpenRouter grok-4.20 entry.
const INLINE_DATES: Record<string, string> = {
  "gemma-4-uncensored": "2026-04-13",
  "venice-uncensored-1.2": "2026-04-01",
  "venice-uncensored-role-play": "2026-02-20",
  "grok-4.20-multi-agent-beta": "2026-03-31",
};

// Marketplace routes with no shared lab identity (uncensored/"heretic"
// finetunes, Venice house models, beta aliases) are written inline; this maps
// the ones whose weights are known to be public.
const INLINE_OPEN_WEIGHTS: Record<string, boolean> = {
  "gemma-4-uncensored": true,
  "glm-4.7-flash-heretic": true,
  "venice-uncensored": true,
  "venice-uncensored-1.2": true,
  "venice-uncensored-role-play": true,
  "e2ee-venice-uncensored-24b-p": true,
  "mistral-large": true,
};

// Maps providers/openrouter/models subdirectories to models/ metadata
// directories so reasoning_options authored for the same canonical model on
// OpenRouter (the established same-surface relay peer) can be mirrored here.
const OPENROUTER_DIR_METADATA: Record<string, string> = {
  "aion-labs": "aion-labs",
  anthropic: "anthropic",
  deepseek: "deepseek",
  google: "google",
  inception: "inception",
  "meta-llama": "meta",
  minimax: "minimax",
  mistralai: "mistral",
  moonshotai: "moonshotai",
  nousresearch: "nousresearch",
  nvidia: "nvidia",
  openai: "openai",
  qwen: "alibaba",
  tencent: "tencent",
  "x-ai": "xai",
  "z-ai": "zhipuai",
  "zai-org": "zhipuai",
};

export const SurplusModel = z
  .object({
    id: z.string(),
    name: z.string(),
    created: z.number(),
    context_length: z.number(),
    architecture: z
      .object({
        input_modalities: z.array(z.string()).default(["text"]),
        output_modalities: z.array(z.string()).default(["text"]),
      })
      .passthrough(),
    top_provider: z
      .object({
        context_length: z.number().nullish(),
        max_completion_tokens: z.number().nullish(),
      })
      .passthrough()
      .nullish(),
    supported_parameters: z.array(z.string()).default([]),
    supported_features: z.array(z.string()).default([]),
    provider: z.string().optional(),
  })
  .passthrough();

export const SurplusResponse = z
  .object({
    data: z.array(SurplusModel),
  })
  .passthrough();

export type SurplusModel = z.infer<typeof SurplusModel>;

export const surplusIntelligence = {
  id: "surplus-intelligence",
  name: "Surplus Intelligence",
  modelsDir: "providers/surplus-intelligence/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Surplus Intelligence request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // The marketplace also lists image/video/music/TTS/STT services priced
    // per request or per media unit; those cannot be represented by the
    // token-cost schema and are intentionally out of catalog scope. Text
    // chat models all report a real context window.
    return SurplusResponse.parse(raw).data.filter(
      (model) => model.context_length > 0 && model.architecture.output_modalities.includes("text"),
    );
  },
  translateModel(model, context) {
    const translated = buildSurplusModel(model, context.existing(model.id));
    return {
      id: model.id,
      model: translated,
      header: translated.reasoning_options?.some((option) => option.type === "toggle")
        ? TOGGLE_HEADER
        : undefined,
    };
  },
} satisfies SyncProvider<SurplusModel>;

// Surplus forwards request parameters to the winning seller unchanged, so
// reasoning controls use the OpenRouter-style surface advertised in
// supported_parameters and mirror the canonical model's peer entry.
const TOGGLE_HEADER = [
  "# Toggle: reasoning.enabled true|false (OpenRouter-style `reasoning` object,",
  "# forwarded to the seller unchanged); effort: reasoning_effort.",
  "# Controls mirror the same canonical model's OpenRouter entry.",
  "",
].join("\n");

function buildSurplusModel(model: SurplusModel, existing: ExistingModel | undefined): SyncedModel {
  const params = new Set(model.supported_parameters);
  const features = new Set(model.supported_features);
  const input = modalities(model.architecture.input_modalities, ["text"]);
  const output = modalities(model.architecture.output_modalities, ["text"]);
  const canonical = existing?.base_model ?? resolveSurplusBaseModel(model);
  // Surplus's catalog omits the reasoning feature/params on some lab
  // reasoners (e.g. gpt-oss routes advertise it on the e2ee variants only).
  // A pass-through marketplace cannot strip a lab reasoner, so a missing
  // flag is a catalog gap, not a capability change: never author
  // `reasoning = false` onto a canonical model whose lab entry says true.
  const reasoning =
    features.has("reasoning") ||
    params.has("reasoning") ||
    params.has("include_reasoning") ||
    params.has("reasoning_effort") ||
    (canonical !== undefined && labReasoning(canonical));
  const toolCall = features.has("tools") || params.has("tools") || params.has("tool_choice");
  const structuredOutput = params.has("structured_outputs");
  const attachment = input.some((value) => value !== "text");
  const temperature = params.has("temperature");
  const contextLength = model.context_length;
  const limit = {
    context: contextLength,
    input: existing?.limit?.input,
    output: model.top_provider?.max_completion_tokens ?? existing?.limit?.output ?? contextLength,
  };
  const reasoningOptions = reasoning
    ? (existing?.reasoning_options ?? (canonical === undefined ? undefined : mirroredReasoningOptions(canonical)))
    : undefined;

  if (canonical !== undefined) {
    return factorBaseModel(
      canonical,
      {
        name: model.name,
        attachment,
        reasoning,
        reasoning_options: reasoningOptions,
        temperature,
        tool_call: toolCall,
        structured_output: structuredOutput,
        status: existing?.status,
        interleaved: existing?.interleaved,
        limit,
        modalities: { input, output },
      },
      limit,
      existing?.base_model === canonical ? existing.base_model_omit : undefined,
    );
  }

  const releaseDate = dateFromTimestamp(model.created);
  const family = inferFamily(model.id, model.name);
  return {
    name: model.name,
    description: existing?.description ??
      describeModel({
        id: model.id,
        name: model.name,
        family,
        reasoning,
        tool_call: toolCall,
        structured_output: structuredOutput,
        open_weights: existing?.open_weights ?? INLINE_OPEN_WEIGHTS[model.id] ?? false,
        limit,
        modalities: { input, output },
      }),
    family,
    release_date: existing?.release_date ?? INLINE_DATES[model.id] ?? releaseDate,
    last_updated: existing?.last_updated ?? INLINE_DATES[model.id] ?? releaseDate,
    attachment,
    reasoning,
    reasoning_options: reasoningOptions,
    temperature,
    tool_call: toolCall,
    structured_output: structuredOutput,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? INLINE_OPEN_WEIGHTS[model.id] ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

export function resolveSurplusBaseModel(model: SurplusModel) {
  const routeID = model.id.replace(/:web$/, "");
  const override = BASE_MODEL_OVERRIDES[routeID] ?? BASE_MODEL_OVERRIDES[unwrapE2EE(routeID)];
  if (override !== undefined) return override;

  const prefix = model.provider === undefined ? undefined : LAB_PREFIXES[model.provider];
  for (const candidate of candidateIDs(unwrapE2EE(routeID))) {
    const resolved =
      (prefix === undefined ? undefined : resolveCanonicalBaseModel(`${prefix}/${candidate}`)) ??
      resolveModelMetadataBaseModel(candidate);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function labReasoning(canonical: string) {
  try {
    return modelMetadata(canonical).reasoning === true;
  } catch {
    return false;
  }
}

function unwrapE2EE(id: string) {
  return id.startsWith("e2ee-") ? id.slice("e2ee-".length).replace(/-p$/, "") : id;
}

function candidateIDs(id: string) {
  const candidates = [id];
  // Some Surplus IDs repeat the lab name (`openai-gpt-oss-120b`,
  // `nvidia-nemotron-3-nano-30b-a3b`); canonical files drop it.
  candidates.push(id.replace(/^(?:openai|nvidia)-/, ""));
  for (const base of [...candidates]) {
    if (base.endsWith("-instruct")) candidates.push(base.slice(0, -"-instruct".length));
    if (base.endsWith("-it")) candidates.push(base.slice(0, -"-it".length));
    candidates.push(`${base}-it`);
    candidates.push(`${base}-instruct`);
    // Qwen point releases are dotted in models/ (`qwen3-5-9b` → `qwen3.5-9b`,
    // `qwen-3-7-plus` → `qwen3.7-plus`).
    candidates.push(base.replace(/^qwen-?(\d)[-.](\d)/, "qwen$1.$2"));
    // Generic dashed point release (`grok-build-0-1` → `grok-build-0.1`).
    candidates.push(base.replace(/(\d)-(\d)/g, "$1.$2"));
  }
  return [...new Set(candidates)];
}

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

function inferFamily(id: string, name: string) {
  const kimiFamily = inferKimiFamily(id, name);
  if (kimiFamily !== undefined) return kimiFamily;

  const target = `${id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") {
        return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      }
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

let reasoningOptionsByCanonical: Map<string, SyncedFullModel["reasoning_options"]> | undefined;

// Surplus is a pass-through relay ("the marketplace passes through all
// parameters to the provider unchanged"), so per policy the underlying
// model's controls are copied from the same canonical model as authored on
// OpenRouter, the established peer with the same surface. Models without a
// peer entry fall back to the runner's empty-array default.
function mirroredReasoningOptions(canonical: string) {
  if (reasoningOptionsByCanonical === undefined) {
    reasoningOptionsByCanonical = new Map();
    for (const entry of walkTOMLFiles(OPENROUTER_MODELS_DIR)) {
      let parsed: Record<string, unknown>;
      try {
        parsed = Bun.TOML.parse(readFileSync(entry, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const options = parsed.reasoning_options as SyncedFullModel["reasoning_options"] | undefined;
      if (options === undefined || options.length === 0) continue;
      const key = canonicalKeyForOpenRouterFile(entry, parsed);
      if (key === undefined || reasoningOptionsByCanonical.has(key)) continue;
      reasoningOptionsByCanonical.set(key, options);
    }
  }
  return reasoningOptionsByCanonical.get(canonical);
}

function canonicalKeyForOpenRouterFile(file: string, parsed: Record<string, unknown>) {
  if (typeof parsed.base_model === "string") return parsed.base_model;
  const relative = path.relative(OPENROUTER_MODELS_DIR, file).slice(0, -".toml".length);
  const [dir, ...rest] = relative.split(path.sep);
  if (dir === undefined || rest.length === 0) return undefined;
  const metadataDir = OPENROUTER_DIR_METADATA[dir];
  if (metadataDir === undefined) return undefined;
  return `${metadataDir}/${rest.join("/").replace(/:free$/, "")}`;
}

function walkTOMLFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTOMLFiles(full);
    return entry.name.endsWith(".toml") ? [full] : [];
  });
}
