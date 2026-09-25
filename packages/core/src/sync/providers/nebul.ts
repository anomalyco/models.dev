import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, modelMetadata } from "./openrouter.js";

const API_ENDPOINT = "https://api.inference.nebul.io/v1/model/info";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Maps the org prefix of a served ID to the lab namespace under models/.
// The Hugging Face org name and the lab name in models/ often differ.
// Keys are lowercase, and the lookup lowercases the org the same way. Hugging Face
// org paths are case-insensitive in URLs, so "qwen/Qwen3.8-27B-FP8" is a valid ID shape.
const ORG_TO_MODEL_PROVIDER: Record<string, string | undefined> = {
  "deepseek-ai": "deepseek",
  google: "google",
  "meta-models": "meta",
  mistralai: "mistral",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  openai: "openai",
  qwen: "alibaba",
  "zai-org": "zhipuai",
};

// Served IDs whose lab metadata in models/ lives under a different model name.
const BASE_MODEL_ALIASES: Record<string, string | undefined> = {
  "mistralai/Mistral-Large-3-675B-Instruct-2512": "mistral/mistral-large-2512",
};

// The sync scope is general chat models. The catalog also lists specialized
// OCR (document text recognition) models by name and flags private, internal,
// and safety entries with display_tags. The filter keeps all of those out,
// because they are not chat models and models.dev has no matching lab metadata for them.
const OUT_OF_SCOPE_PATTERNS = [/OCR/i];
const OUT_OF_SCOPE_TAGS = new Set(["Guard Model", "Content Safety", "Private", "Internal"]);

// The sync fails closed (it throws on bad data instead of syncing it) on a
// partial catalog. The in-scope chat catalog has ~14 models as of 2026-09-24.
// A truncated response (a per-lab serving outage or a half-written deploy) can
// pass the non-empty checks in parseModels. The code must not treat it as the
// real catalog. As a second guard, the provider runs with deleteMissing: false,
// so even a bad catalog cannot delete curated local files. A catalog with less
// than half the known-good size is structurally incomplete. Raise this number
// deliberately as the catalog grows.
const MIN_CHAT_MODELS = 6;

const ModelInfo = z.object({
  description: z.string().nullable().optional(),
  huggingface_id: z.string().nullable().optional(),
  input_cost_per_1m_tokens: z.number().nullable().optional(),
  output_cost_per_1m_tokens: z.number().nullable().optional(),
  cache_read_input_cost_per_1m_tokens: z.number().nullable().optional(),
  display_tags: z.array(z.string()).nullable().optional(),
  max_input_tokens: z.number().nullable().optional(),
  mode: z.string().nullable(),
  model_type: z.string().nullable(),
  // The catalog only advertises this list, and the sync never copies it into an
  // entry, because probes proved the list unreliable. The schema accepts any
  // string. A strict enum throws on a future unknown value. That failure stops
  // the hourly run and blocks cost/context refreshes for curated models.
  reasoning_efforts: z.array(z.string()).nullable().optional(),
  superseded_by_model_name: z.string().nullable().optional(),
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
  // Nebul is a curated provider, so only the hand-authored flagship models ship.
  // The catalog is authoritative for their live cost and context, but it must
  // never grow or shrink the local set. skipCreates keeps any other in-scope chat
  // model out, and deleteMissing: false keeps a curated model that drops out of
  // the catalog (zai-org/GLM-5.3 is intermittently absent) instead of deleting it.
  skipCreates: true,
  deleteMissing: false,
  // Skipped reasoners (the fail-closed path below) and chat models outside the
  // curation are expected. Missing-model issues for them ask for models that
  // this provider deliberately does not curate.
  trackMissingModels: false,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Nebul models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const data = NebulResponse.parse(raw).data;
    // An empty catalog is an upstream fault. The delete-missing pass deletes
    // every local model file when the sync accepts it, so the code throws instead.
    if (data.length === 0) {
      throw new Error("Nebul returned an empty model catalog");
    }
    // The same failure applies when the response shape drifts and no entry
    // matches the chat-model filter anymore, for example after renamed
    // model_type or mode values.
    if (!data.some(isCatalogChatModel)) {
      throw new Error("Nebul returned no usable chat models");
    }
    const chatCount = data.filter(isCatalogChatModel).length;
    if (chatCount < MIN_CHAT_MODELS) {
      throw new Error(
        `Nebul returned only ${chatCount} usable chat models (expected at least ${MIN_CHAT_MODELS}); treating the catalog as a partial fault and skipping this run`,
      );
    }
    return data;
  },
  // The unauthenticated /v1/model/info endpoint is authoritative for the live
  // cost and context of the curated entries. The provider runs with skipCreates
  // and deleteMissing: false, so translateModel only refreshes existing files.
  // skippedNotice reports any other in-scope chat model, and missingNotice
  // reports a curated model that the catalog no longer lists. Whole-catalog
  // faults still fail closed in parseModels.
  translateModel(entry, context) {
    if (!isCatalogChatModel(entry)) return undefined;
    const id = entry.model_name;
    const info = entry.model_info;
    const existing = context.existing(id);
    // Existing entries must survive incomplete source data. A transient null
    // price or an unresolved alias otherwise deletes the hand-authored TOML on
    // the next run. Existing entries keep their authored base_model and
    // cost/limit, and only new models need a source entry with complete pricing
    // and a resolvable base.
    const baseModel = existing?.base_model ?? resolveBaseModel(id, info.huggingface_id ?? undefined);
    const cost = info.input_cost_per_1m_tokens != null && info.output_cost_per_1m_tokens != null
      ? {
          input: info.input_cost_per_1m_tokens,
          output: info.output_cost_per_1m_tokens,
          cache_read: info.cache_read_input_cost_per_1m_tokens ?? undefined,
        }
      : existing?.cost;
    const limit = info.max_input_tokens != null ? { context: info.max_input_tokens } : existing?.limit;
    if (existing === undefined && (baseModel === undefined || cost === undefined || limit === undefined)) return undefined;
    // A hand-authored reasoning = false marks a served ID whose lab model
    // reasons but that this host serves with thinking disabled. The catalog
    // reports supports_reasoning = false and no reasoning_efforts for it. Keep
    // the override and suppress the reasoning controls and traces. The entry
    // then needs no reasoning_options, and no interleaved side channel applies
    // when the host returns no traces.
    const reasoningDisabled = existing?.reasoning === false;
    // Fail closed unless the caller control is hand-authored from live probe
    // evidence. Probes proved the advertised reasoning_efforts wrong in one
    // case: on 2026-09-23 the catalog advertised low|medium|high|max for one
    // model, and its engine rejects every value but high. The runner skips the
    // ID so that the options can be hand-authored from live probes.
    const isReasoner = !reasoningDisabled && (baseModel !== undefined
      ? modelMetadata(baseModel).reasoning === true
      : existing?.reasoning === true);
    if (isReasoner && existing?.reasoning_options === undefined) {
      throw new MissingReasoningOptionsError(
        id,
        `${id} is a reasoning model, but the catalog entry has no probe-verified reasoning_options; hand-author them instead of trusting the advertised reasoning_efforts`,
      );
    }
    const values = reasoningDisabled
      ? { reasoning: false, interleaved: undefined, reasoning_options: undefined, cost, limit }
      : { interleaved: existing?.interleaved, reasoning_options: existing?.reasoning_options, cost, limit };
    if (baseModel !== undefined) {
      return {
        id,
        model: factorBaseModel(baseModel, values, limit) as SyncedModel,
      };
    }
    // The existing standalone definition has a served alias that no longer
    // resolves. Keep the authored fields, and refresh only what /model/info
    // still provides.
    return { id, model: { ...existing, ...values } as SyncedModel };
  },
  // Report only in-scope chat models whose base_model does not resolve. Filtered
  // entries (embeddings, rerankers, out-of-scope specialized models, superseded
  // IDs) skip silently.
  sourceID(entry: NebulEntry) {
    return isCatalogChatModel(entry) ? entry.model_name : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `Nebul serves these in-scope chat models, but only the curated catalog is shipped (skipCreates); not added:`,
      ids.map((id) => `\`${id}\``).join(", "),
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `Nebul models absent from the source catalog were retained, not deleted:`,
      paths.map((p) => `\`${p.replace(/\.toml$/, "")}\``).join(", "),
    ];
  },
} satisfies SyncProvider<NebulEntry>;

function isCatalogChatModel(entry: NebulEntry): boolean {
  const info = entry.model_info;
  return info.model_type === "llm" && info.mode === "chat"
    && info.superseded_by_model_name == null && !OUT_OF_SCOPE_PATTERNS.some((pattern) => pattern.test(entry.model_name))
    && !(info.display_tags ?? []).some((tag) => OUT_OF_SCOPE_TAGS.has(tag));
}

// Nebul documents exactly one reasoning control: reasoning_effort. The sync
// copies only hand-authored options into an entry, because probes proved the
// advertised reasoning_efforts unreliable (on 2026-09-23 the catalog advertised
// low|medium|high|max for one model, and its engine rejects every value but
// high). translateModel rejects a reasoner with no authored options, and a
// non-reasoner carries no options. The API supports no lab-style toggles or
// budget controls unless a probe of this host shows them.

function resolveBaseModel(servedID: string, huggingfaceID: string | undefined): string | undefined {
  return baseModelCandidates(servedID, huggingfaceID).find(canonicalExists);
}

// existsSync is case-insensitive on Windows and macOS. readdirSync reads the
// real on-disk filename case, so the resolved base_model matches the models/
// filename exactly, and CI on Linux passes.
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
  const provider = ORG_TO_MODEL_PROVIDER[org.toLowerCase()];
  if (provider === undefined) return undefined;
  return `${provider}/${modelParts.join("/").toLowerCase()}`;
}

// Hosts serve quantized checkpoints (the same weights in a smaller number
// format, for example -FP8, -BF16), and the lab publishes the metadata under
// the base-precision name. The resolver also tries the names without the
// quantization suffix. NVIDIA prefixes checkpoint names with "NVIDIA-", and the
// metadata names drop that prefix.
function quantizationStripped(candidate: string | undefined): string[] {
  if (candidate === undefined) return [];
  const withoutQuant = candidate.replace(/-(fp8|bf16|fp4|int8)$/i, "");
  const withoutPrefix = withoutQuant.replace(/nvidia-/, "");
  return withoutQuant === candidate ? [] : [...new Set([withoutQuant, withoutPrefix])].filter((value) => value !== candidate);
}
