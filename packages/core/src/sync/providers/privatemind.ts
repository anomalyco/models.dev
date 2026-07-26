import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import { factorBaseModel } from "./openrouter.js";
import type { SyncProvider, SyncedFullModel } from "../index.js";

// PrivateMind is an OpenAI-compatible platform. Every registry entry is derived
// entirely from /v1/models, so deploying, swapping, or retiring a model needs
// no change here; the next sync reflects it automatically.
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

// /v1/models publishes no completion cap, so limit.output is never synthesized
// from the context window. A factored entry inherits its base model's
// published cap instead.
function baseOutputLimit(baseModel: string): number | undefined {
  const raw = Bun.TOML.parse(
    readFileSync(path.join(MODELS_DIR, `${baseModel}.toml`), "utf8"),
  ) as { limit?: { output?: unknown } };
  const output = raw.limit?.output;
  return typeof output === "number" ? output : undefined;
}

// Only chat-shaped models map onto a models.dev entry; embeddings, TTS, ASR,
// rerank, OCR and image-gen are skipped. Keys on the API's model_type, not a
// hand-maintained list.
const CHAT_TYPES = new Set(["chat", "vision-chat"]);

// Mirrors schema.ts ReasoningEffortValue (not exported) plus "off", the
// gateway's word for the thinking toggle. Strict on purpose: a level this
// catalog doesn't know fails the sync loudly instead of writing an invalid
// reasoning option.
const EffortLevel = z.enum(["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]);
type GradedLevel = Exclude<z.infer<typeof EffortLevel>, "off">;

const Capabilities = z
  .object({
    tools: z.boolean().optional(),
    response_format: z.boolean().optional(),
    reasoning_effort: z.boolean().optional(),
    // Accepted values of a graded per-model dial (kimi-k3: low | high | max,
    // deepseek-v4-flash: off | high | max, where "off" is the on/off
    // toggle). Absent on binary-toggle hybrids.
    reasoning_effort_levels: z.array(EffortLevel).optional(),
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

// /v1/models carries a unix `created`, but it is request-time on this API, so
// it cannot seed a real release date. Inline entries keep their first-synced
// date via the existing? preservation below; factored entries inherit dates
// from the lab file instead.
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
  // Same for the wire-path header: it is derived from the live control, so a
  // model that gains or loses its toggle gets the matching header, not a
  // frozen one.
  authoritativeHeaders: true,
  async fetchModels() {
    // /v1/models is public: anonymous callers get the default org's catalog
    // without prices. List prices are API-key metadata, so the sync sends
    // PRIVATEMIND_API_KEY when set and otherwise keeps the authored cost.
    // An unset CI secret arrives as "", which must not become "Bearer ".
    const key = process.env.PRIVATEMIND_API_KEY || undefined;
    const response = await fetch(API_ENDPOINT, {
      headers: key === undefined ? {} : { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      throw new Error(`PrivateMind /v1/models failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // Publish only chat-shaped, open-weight models. `open_weights === true` is
    // the gateway's own signal (sourced from the catalog), so internal /
    // proprietary models (open_weights false) drop out here automatically,
    // with no denylist to maintain by hand.
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
    // Capability and control are separate API signals: `supported_parameters`
    // advertises "reasoning" only when the deployment actually emits
    // chain-of-thought (delta.reasoning), while `capabilities.reasoning_effort`
    // says the thinking on/off toggle is accepted. A model that reasons without
    // the toggle stays reasoning = true with no options; a model with neither
    // signal is genuinely non-thinking (e.g. the Gemma 4 NVFP4 build rejects
    // reasoning_effort with HTTP 400 and emits no chain-of-thought).
    const reasoning = params.includes("reasoning");
    const effortToggle = Boolean(caps.reasoning_effort);
    const effortLevels = caps.reasoning_effort_levels ?? [];
    // On a graded dial, "off" is the toggle and the rest are the levels.
    const gradedLevels = effortLevels.filter((level): level is GradedLevel => level !== "off");
    const hasToggle = effortLevels.length > 0 ? effortLevels.includes("off") : effortToggle;
    // Leading wire-path comment for the model file (every toggle needs one;
    // an effort dial gets the same treatment). Written on every sync.
    const headerLines: string[] = [];
    if (hasToggle) {
      const enabling = gradedLevels.length > 0 ? gradedLevels.join("|") : "low|medium|high|max";
      headerLines.push(
        `# Toggle: reasoning_effort = off|${enabling} ("off" disables, every other value enables)`,
      );
    }
    if (gradedLevels.length > 0) {
      headerLines.push(
        `# Effort: reasoning_effort = ${gradedLevels.join("|")}${hasToggle ? "" : ' (always thinking, "off" returns 400)'}`,
      );
    }
    const header =
      headerLines.length > 0
        ? `${headerLines.join("\n")}\n# https://docs.privatemind.com/chat-completions.html#reasoning-effort\n`
        : undefined;
    const context_length = model.context_length ?? 0;
    const existing = context.existing(model.id);
    // A price is written only when the API quotes both sides; a half-quoted
    // rate is never padded with 0. Otherwise the authored cost stands, and a
    // model with no cost anywhere (an unkeyed run meeting a new deployment)
    // is skipped until a keyed run can price it.
    const apiCost =
      cost.input_per_m_token != null && cost.output_per_m_token != null
        ? { input: cost.input_per_m_token, output: cost.output_per_m_token }
        : undefined;
    const authoredCost =
      existing?.cost?.input !== undefined && existing.cost.output !== undefined
        ? { input: existing.cost.input, output: existing.cost.output }
        : undefined;
    const resolvedCost = apiCost ?? authoredCost;
    if (resolvedCost === undefined && existing === undefined) return undefined;
    const date = isoDate(model.created);
    const inputModalities: ("text" | "image")[] = vision ? ["text", "image"] : ["text"];
    const baseModel = resolveBaseModel(model.id);
    // Output cap: inherit the base model's published limit.output, clamped to
    // the serving window (output cannot exceed it). Without a base to inherit
    // from, publish a conservative 8K cap rather than claiming the window.
    const baseOutput = baseModel === undefined ? undefined : baseOutputLimit(baseModel);
    const outputLimit =
      baseOutput === undefined ? Math.min(context_length, 8_192) : Math.min(baseOutput, context_length);

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
      // reasoning_effort semantics are advertised per model. A graded dial
      // lists its accepted values in reasoning_effort_levels (kimi-k3:
      // low | high | max, always thinking; deepseek-v4-flash: off | high |
      // max, where off is the toggle). Hybrids without a dial carry the bare
      // capability, a verified on/off toggle: off disables
      // `message.reasoning`, low/medium/high enable it identically. An
      // always-on thinker with neither exposes no caller control.
      reasoning_options: reasoning
        ? [
            ...(hasToggle ? [{ type: "toggle" as const }] : []),
            ...(gradedLevels.length > 0 ? [{ type: "effort" as const, values: gradedLevels }] : []),
          ]
        : undefined,
      tool_call: Boolean(caps.tools),
      temperature: params.includes("temperature"),
      structured_output: Boolean(caps.response_format),
      open_weights: true,
      release_date: existing?.release_date ?? date,
      last_updated: existing?.last_updated ?? date,
      cost: resolvedCost,
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
    // factorBaseModel keeps only fields that differ from the base. The API
    // publishes no authoritative dates (`created` is request-time), so a
    // factored entry inherits release_date / last_updated from the lab file.
    // Inline entries (no base) keep the first-synced date.
    if (baseModel === undefined) return { id: model.id, model: synced, header };
    const { release_date: _releaseDate, last_updated: _lastUpdated, ...overrides } = synced;
    return { id: model.id, model: factorBaseModel(baseModel, overrides, synced.limit), header };
  },
} satisfies SyncProvider<PrivateMindModel>;
