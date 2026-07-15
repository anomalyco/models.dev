import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import { factorBaseModel } from "./openrouter.js";
import type { SyncProvider, SyncedFullModel } from "../index.js";

// PrivateMind is an OpenAI-compatible platform. Every registry entry is derived
// entirely from /v1/models, so deploying, swapping, or retiring a model needs
// no change here — the next sync reflects it automatically.
const API_ENDPOINT = "https://api.privatemind.com/v1/models";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Where a model.dev metadata file exists for the underlying model, AGENTS.md
// requires the provider entry to use `base_model` and carry only overrides.
// Explicit aliases cover ids whose canonical file is named by a version code
// the id cannot be normalized to (Mistral Medium 3.5 lives at mistral-medium-2604).
const BASE_MODEL_ALIASES: Record<string, string> = {
  "mistral-medium-3-5-128b-nvfp4": "mistral/mistral-medium-2604",
};

// Quant-build suffixes the platform serves, stripped before matching the
// canonical author metadata (e.g. "glm-5-2-nvfp4" -> "glm-5-2").
const QUANT_SUFFIX = /-(nvfp4|fp8|fp4|int8|awq|gptq|w8a8)$/;
// Vendor-rehost prefixes (an NVIDIA/RedHat rehost of another lab's weights);
// dropped so the id matches the author's canonical file, not the rehoster's.
const REHOST_PREFIX = /^(nvidia|unsloth|neuralmagic|redhatai)-/;

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

// Punctuation-insensitive index of every models/<provider>/<model>.toml, built
// once. Lets dash-for-dot ids ("glm-5-2" == "glm-5.2") resolve without a table.
let metadataIndexCache: { id: string; norm: string }[] | undefined;
function metadataIndex() {
  if (metadataIndexCache !== undefined) return metadataIndexCache;
  const index: { id: string; norm: string }[] = [];
  for (const provider of readdirSync(MODELS_DIR, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    for (const file of readdirSync(path.join(MODELS_DIR, provider.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".toml")) continue;
      const stem = file.name.slice(0, -5);
      index.push({ id: `${provider.name}/${stem}`, norm: normalize(stem) });
    }
  }
  metadataIndexCache = index;
  return index;
}

// Resolve a PrivateMind model id to a canonical `models/<provider>/<model>` base,
// or undefined to keep the entry full-inline (no canonical exists, e.g.
// qwen3-vl-32b-thinking-fp8). Deterministic and on-disk guarded: a model factors
// only once its canonical file is present, and a normalized id must match exactly
// one file, so the sync stays self-updating and idempotent without a per-model map.
function resolveBaseModel(id: string): string | undefined {
  const alias = BASE_MODEL_ALIASES[id];
  if (alias !== undefined) {
    return existsSync(path.join(MODELS_DIR, `${alias}.toml`)) ? alias : undefined;
  }
  const stripped = id.replace(QUANT_SUFFIX, "");
  const keys = new Set([normalize(stripped), normalize(stripped.replace(REHOST_PREFIX, ""))]);
  for (const key of keys) {
    const matches = metadataIndex().filter((entry) => entry.norm === key);
    const [match] = matches;
    if (matches.length === 1 && match !== undefined) return match.id;
  }
  return undefined;
}

// Only chat-shaped models map onto a models.dev entry; embeddings, TTS, ASR,
// rerank, OCR and image-gen are skipped. Keys on the API's model_type, not a
// hand-maintained list.
const CHAT_TYPES = new Set(["chat", "vision-chat"]);

const Capabilities = z
  .object({
    tools: z.boolean().optional(),
    response_format: z.boolean().optional(),
    reasoning_effort: z.boolean().optional(),
    image_input: z.boolean().optional(),
  })
  .partial()
  .passthrough();

const Cost = z
  .object({
    input_per_m_token: z.number().optional(),
    output_per_m_token: z.number().optional(),
    image_per_generation: z.number().optional(),
  })
  .partial();

const PrivateMindModel = z
  .object({
    id: z.string(),
    model_full_name: z.string().optional(),
    model_type: z.string().optional(),
    // Curated per-model blurb from the gateway catalog; mapped straight into
    // the models.dev `description` field (see translateModel).
    description: z.string().optional(),
    created: z.number().optional(),
    open_weights: z.boolean().optional(),
    capabilities: Capabilities.optional(),
    context_length: z.number().nullable().optional(),
    cost: Cost.nullable().optional(),
    supported_parameters: z.array(z.string()).optional(),
  })
  .passthrough();

const PrivateMindResponse = z.object({ data: z.array(PrivateMindModel) }).passthrough();

type PrivateMindModel = z.infer<typeof PrivateMindModel>;

// /v1/models carries a unix `created`; it seeds release_date / last_updated and
// is then preserved, so the dates stay stable across syncs.
function isoDate(unixSeconds: number | undefined): string {
  const ms = unixSeconds ? unixSeconds * 1000 : Date.now();
  return new Date(ms).toISOString().slice(0, 10);
}

export const privatemind = {
  id: "privatemind",
  name: "PrivateMind",
  modelsDir: "providers/privatemind/models",
  // Mirror the live fleet: drop entries for models no longer returned by the API.
  deleteMissing: true,
  // The adapter re-derives base_model authoritatively from the API id + on-disk
  // metadata each run, so it owns the pointer rather than freezing a prior one.
  preserveBaseModels: false,
  async fetchModels() {
    // /v1/models is public (no API key): the endpoint returns the default
    // org's catalog to anonymous callers.
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`PrivateMind /v1/models failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // Publish only chat-shaped, open-weight models. `open_weights === true` is
    // the gateway's own signal (sourced from the catalog), so internal /
    // proprietary models (open_weights false) drop out here automatically — no
    // hand-maintained denylist.
    return PrivateMindResponse.parse(raw).data.filter(
      (model) => CHAT_TYPES.has(model.model_type ?? "") && model.open_weights === true,
    );
  },
  sourceID(model) {
    return model.id;
  },
  translateModel(model, context) {
    const caps = model.capabilities ?? {};
    const cost = model.cost ?? {};
    const params = model.supported_parameters ?? [];
    const vision = Boolean(caps.image_input) || model.model_type === "vision-chat";
    const reasoning = Boolean(caps.reasoning_effort);
    const context_length = model.context_length ?? 0;
    const existing = context.existing(model.id);
    const date = isoDate(model.created);
    const inputModalities: ("text" | "image")[] = vision ? ["text", "image"] : ["text"];
    // vLLM serves with no output cap below the context window, so for large
    // models the output ceiling is the context length. But OpenCode reserves
    // the output budget from the window (usable = context - min(output, 32000)),
    // so output == context starves a near-32K model's usable context to almost
    // nothing. When the window is small (<= 64K) clamp output to leave room for
    // the prompt; large windows are unaffected (OpenCode caps output at 32000).
    const outputLimit = context_length <= 65_536 ? Math.min(context_length, 8_192) : context_length;

    // The gateway's curated blurb is the source of truth, so it wins over any
    // prior TOML value (edits on the platform flow through on the next sync).
    // Fall back to the existing description, then a derived one, so the entry
    // always satisfies the required, non-empty `description` field.
    const apiDescription = model.description?.trim() || undefined;
    const description =
      apiDescription ??
      existing?.description ??
      describeModel({
        id: model.id,
        providerId: "privatemind",
        name: model.model_full_name || model.id,
        reasoning,
        tool_call: Boolean(caps.tools),
        structured_output: Boolean(caps.response_format),
        open_weights: true,
        limit: { context: context_length, output: outputLimit },
        modalities: { input: inputModalities, output: ["text"] },
      });

    const synced: SyncedFullModel = {
      name: model.model_full_name || model.id,
      description,
      attachment: vision,
      reasoning,
      // The gateway maps low/medium/high onto one "thinking" toggle (only
      // off vs on is distinct), so no graded effort level is verified.
      reasoning_options: reasoning ? [] : undefined,
      tool_call: Boolean(caps.tools),
      temperature: params.includes("temperature"),
      structured_output: Boolean(caps.response_format),
      open_weights: true,
      release_date: existing?.release_date ?? date,
      last_updated: existing?.last_updated ?? date,
      cost:
        cost.input_per_m_token != null || cost.output_per_m_token != null
          ? { input: cost.input_per_m_token ?? 0, output: cost.output_per_m_token ?? 0 }
          : undefined,
      limit: {
        context: context_length,
        output: outputLimit,
      },
      modalities: {
        input: inputModalities,
        output: ["text"],
      },
    };

    // Factor onto canonical metadata when one exists (AGENTS.md hard blocker):
    // factorBaseModel subtracts every field equal to the base, so the written
    // TOML keeps only genuine provider overrides (cost, reasoning_options, and
    // the NVFP4/FP8 serving deltas). No canonical -> full inline entry.
    const baseModel = resolveBaseModel(model.id);
    return {
      id: model.id,
      model:
        baseModel === undefined
          ? synced
          : factorBaseModel(baseModel, synced, synced.limit),
    };
  },
} satisfies SyncProvider<PrivateMindModel>;
