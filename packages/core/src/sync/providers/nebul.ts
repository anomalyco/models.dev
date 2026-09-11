import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.inference.nebul.io/model/info";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Served org prefix -> models/ metadata namespace (HF org names differ from catalog labs).
const ORG_TO_MODEL_PROVIDER: Record<string, string | undefined> = {
  "deepseek-ai": "deepseek",
  google: "google",
  "meta-models": "meta",
  mistralai: "mistral",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  openai: "openai",
  Qwen: "alibaba",
  "zai-org": "zhipuai",
};

// Served IDs whose canonical metadata lives under a differently-named lab entry.
const BASE_MODEL_ALIASES: Record<string, string | undefined> = {
  "mistralai/Mistral-Large-3-675B-Instruct-2512": "mistral/mistral-large-2512",
  "mistralai/Mistral-Medium-3.5-128B": "mistral/mistral-medium-2604",
};

// The synthetic health-check model and serving artifacts that must not enter the catalog.
const PING_MODEL = "Nebul/Ping";
const DENYLIST = /OCR|Qwen3Guard/i;

// Deprecated server-side (descriptions point at GLM-5.3) but not flagged by /model/info.
const DEPRECATED = new Set(["zai-org/GLM-5.1-FP8", "zai-org/GLM-5.2-FP8"]);

const EffortValues = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]);

const ModelInfo = z.object({
  description: z.string().nullable().optional(),
  huggingface_id: z.string().nullable().optional(),
  input_cost_per_1m_tokens: z.number().nullable().optional(),
  output_cost_per_1m_tokens: z.number().nullable().optional(),
  cache_read_input_cost_per_1m_tokens: z.number().nullable().optional(),
  max_input_tokens: z.number().nullable().optional(),
  mode: z.string().nullable(),
  model_type: z.string().nullable(),
  reasoning_efforts: z.array(EffortValues).nullable().optional(),
}).passthrough();

export const NebulEntry = z.object({
  model_info: ModelInfo,
  model_name: z.string().min(1),
}).passthrough();

export const NebulResponse = z.object({
  data: z.array(NebulEntry),
}).passthrough();

export type NebulEntry = z.infer<typeof NebulEntry>;

export const nebul = {
  id: "nebul",
  name: "Nebul",
  modelsDir: "providers/nebul/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Nebul models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return NebulResponse.parse(raw).data;
  },
  // Unauthenticated /model/info is the authoritative catalog: entries removed
  // server-side are removed here (deleteMissing defaults on), and new resolvable
  // chat models are created with base_model overrides only.
  translateModel(entry, context) {
    if (!isCatalogChatModel(entry)) return undefined;
    const id = entry.model_name;
    const info = entry.model_info;
    const baseModel = resolveBaseModel(id, info.huggingface_id ?? undefined);
    if (baseModel === undefined) return undefined;
    if (info.input_cost_per_1m_tokens == null || info.output_cost_per_1m_tokens == null || info.max_input_tokens == null) return undefined;
    const values = {
      reasoning_options: buildReasoningOptions(entry, context.existing(id)),
      cost: {
        input: info.input_cost_per_1m_tokens,
        output: info.output_cost_per_1m_tokens,
        cache_read: info.cache_read_input_cost_per_1m_tokens ?? undefined,
      },
      limit: { context: info.max_input_tokens },
    };
    return {
      id,
      model: factorBaseModel(baseModel, values, values.limit) as SyncedModel,
    };
  },
  // Only report chat models whose base_model could not be resolved; filtered
  // serving artifacts (embeddings, rerankers, the ping model) skip silently.
  sourceID(entry: NebulEntry) {
    return isCatalogChatModel(entry) ? entry.model_name : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `Nebul models could not be resolved to lab metadata and need hand-authored base_model targets:`,
      ids.map((id) => `\`${id}\``).join(", "),
    ];
  },
} satisfies SyncProvider<NebulEntry>;

function isCatalogChatModel(entry: NebulEntry): boolean {
  const info = entry.model_info;
  return info.model_type === "llm" && info.mode === "chat"
    && entry.model_name !== PING_MODEL && !DEPRECATED.has(entry.model_name) && !DENYLIST.test(entry.model_name);
}

// /model/info only describes the effort control; hand-authored toggle and
// budget_tokens options must survive rewrites, so replace just the effort entry.
function buildReasoningOptions(entry: NebulEntry, existing: ExistingModel | undefined) {
  const efforts = entry.model_info.reasoning_efforts ?? [];
  if (efforts.length === 0) return existing?.reasoning_options;
  const preserved = existing?.reasoning_options?.filter((option) => option.type !== "effort") ?? [];
  return [...preserved, { type: "effort" as const, values: efforts }];
}

function resolveBaseModel(servedID: string, huggingfaceID: string | undefined): string | undefined {
  return baseModelCandidates(servedID, huggingfaceID).find(canonicalExists);
}

// existsSync is case-insensitive on Windows/macOS; verify the real on-disk filename case
// so the resolved base_model matches the canonical metadata exactly (and CI on Linux).
function canonicalExists(candidate: string): boolean {
  const file = path.join(MODELS_DIR, `${candidate}.toml`);
  if (!existsSync(file)) return false;
  try {
    return readdirSync(path.dirname(file)).includes(path.basename(file));
  } catch {
    return false;
  }
}

function baseModelCandidates(servedID: string, huggingfaceID: string | undefined): string[] {
  const alias = BASE_MODEL_ALIASES[servedID];
  const servedCandidate = mapOrgToCandidate(servedID);
  const hfCandidate = huggingfaceID === undefined ? undefined : mapOrgToCandidate(huggingfaceID);
  return [
    ...new Set([alias, servedCandidate, hfCandidate, ...quantizationStripped(hfCandidate), ...quantizationStripped(servedCandidate)]).values(),
  ].filter((candidate): candidate is string => candidate !== undefined);
}

function mapOrgToCandidate(id: string): string | undefined {
  const [org, ...modelParts] = id.split("/");
  if (org === undefined || modelParts.length === 0) return undefined;
  const provider = ORG_TO_MODEL_PROVIDER[org];
  if (provider === undefined) return undefined;
  return `${provider}/${modelParts.join("/").toLowerCase()}`;
}

// Hosts serve quantized checkpoints (e.g. -FP8, -BF16) of weights whose canonical
// metadata is published for the base precision; try those names without the suffix.
// NVIDIA also prefixes checkpoints with "NVIDIA-", which the metadata names drop.
function quantizationStripped(candidate: string | undefined): string[] {
  if (candidate === undefined) return [];
  const withoutQuant = candidate.replace(/-(fp8|bf16|fp4|int8)$/i, "");
  const withoutPrefix = withoutQuant.replace(/nvidia-/, "");
  return withoutQuant === candidate ? [] : [...new Set([withoutQuant, withoutPrefix])].filter((value) => value !== candidate);
}
