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

// Aliases for ids whose canonical file is a version code the id can't normalize
// to (Mistral Medium 3.5 lives at mistral-medium-2604).
const BASE_MODEL_ALIASES: Record<string, string> = {
  "mistral-medium-3-5-128b-nvfp4": "mistral/mistral-medium-2604",
};

// Stripped before matching the canonical author file: quant-build suffix and
// vendor-rehost prefix (e.g. "nvidia-kimi-k2-6-nvfp4" -> "kimi-k2-6").
const QUANT_SUFFIX = /-(nvfp4|fp8|fp4|int8|awq|gptq|w8a8)$/;
const REHOST_PREFIX = /^(nvidia|unsloth|neuralmagic|redhatai)-/;

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

// Punctuation-insensitive index of models/*/*.toml so dashed ids match dotted
// filenames ("glm-5-2" == "glm-5.2") without a table.
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

// Canonical base for a model id, or undefined to keep it full-inline. On-disk
// guarded and requires a unique match, so it stays self-updating and idempotent.
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
    // Small windows (<= 64K) clamp output so OpenCode's reserved output budget
    // doesn't starve usable context; large windows keep the full window.
    const outputLimit = context_length <= 65_536 ? Math.min(context_length, 8_192) : context_length;

    // API blurb is source of truth (wins over prior TOML); fall back to existing,
    // then derived, so `description` is always non-empty.
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
      // Verified live: reasoning_effort toggles thinking on/off (no graded effort).
      reasoning_options: reasoning ? [{ type: "toggle" }] : undefined,
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

    // Factor onto canonical metadata when one exists (AGENTS.md hard blocker);
    // factorBaseModel keeps only fields that differ from the base.
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
