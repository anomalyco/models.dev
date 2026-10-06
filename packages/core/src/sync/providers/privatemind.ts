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

// Aliases for ids the normalizer cannot resolve on its own, because the
// canonical file is named for a version code (Mistral Medium 3.5 lives at
// mistral-medium-2604). A deployment whose id only adds a quant or rehost
// affix needs no entry here.
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

// Canonical base for a model id, or undefined when nothing matches, which
// skips the entry rather than writing it inline (see translateModel). On-disk
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

// /v1/models carries one modality flag, `image_input`, so the lab entry stays
// the source of truth for the rest and a kind is dropped only where this host
// refuses it in a live request. Recorded per id rather than host-wide because
// the deployments genuinely differ: the two Qwen builds accept `video_url` and
// bill the frames, while Kimi K3 and GLM 5.3 Flash refuse it. Evidence and the
// exact errors are in the leading provider.toml comment.
const VIDEO_REFUSED = new Set(["kimi-k3", "glm-5-3-flash-nvfp4"]);
// `file` is not a supported content part type anywhere on this API, so no
// deployment can take a document however the lab entry is written.
const DOCUMENT_KINDS = new Set(["pdf", "document"]);

function baseInputModalities(baseModel: string): string[] | undefined {
  const raw = Bun.TOML.parse(
    readFileSync(path.join(MODELS_DIR, `${baseModel}.toml`), "utf8"),
  ) as { modalities?: { input?: unknown } };
  const input = raw.modalities?.input;
  return Array.isArray(input) && input.every((kind) => typeof kind === "string")
    ? (input as string[])
    : undefined;
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

// The enabling half of the platform's fixed reasoning_effort vocabulary. It is
// a property of the API rather than of any one model: anything outside
// off|low|medium|high|max is refused with HTTP 400, whatever the lab or peer
// hosts of the same weights accept.
const WIRE_LEVELS = ["low", "medium", "high", "max"] as const;

const Capabilities = z
  .object({
    tools: z.boolean().optional(),
    response_format: z.boolean().optional(),
    reasoning_effort: z.boolean().optional(),
    // Accepted values of a graded per-model dial (Kimi K3 and GLM 5.3:
    // low | high | max). Absent on binary-toggle hybrids. A dial that
    // includes "off" carries the toggle inside itself.
    reasoning_effort_levels: z.array(EffortLevel).optional(),
    // The level applied when the caller sends none. No models.dev field
    // maps to it, so it is documented in the model file's leading comment.
    reasoning_effort_default: EffortLevel.optional(),
    // The deployment is thinking-only: reasoning cannot be turned off.
    // Emitted only when true.
    reasoning_mandatory: z.boolean().optional(),
    image_input: z.boolean().optional(),
  })
  .partial()
  .passthrough();

const Cost = z
  .object({
    input_per_m_token: z.number().optional(),
    output_per_m_token: z.number().optional(),
    image_per_generation: z.number().optional(),
    cache_read_per_m_token: z.number().optional(),
    cache_write_per_m_token: z.number().optional(),
  })
  .partial();

// Prices arrive as the product of a rate and a discount, so a cache axis can
// come back as 0.04000000000000001. Twelve significant digits is far more
// precision than any published rate carries and drops the float noise without
// inventing a figure.
const price = (value: number) => Number(value.toPrecision(12));

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
  // Absence from /v1/models is reported, not acted on. The listing is scoped
  // to the caller's organisation, so a key could see a catalog this one does
  // not, and the platform also drops a deployment from the listing while it is
  // migrated. Either way an automated delete would retire a live model, so
  // removals stay a human decision.
  deleteMissing: false,
  // The adapter re-derives base_model authoritatively from the API id + on-disk
  // metadata each run, so it owns the pointer rather than freezing a prior one.
  preserveBaseModels: false,
  // Same for the wire-path header: it is derived from the live control, so a
  // model that gains or loses its toggle gets the matching header, not a
  // frozen one.
  authoritativeHeaders: true,
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local PrivateMind models were absent from /v1/models and were retained for manual lifecycle review: the listing is organisation-scoped and a deployment also leaves it while being migrated, so absence is not retirement.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} PrivateMind models were not created, for one of two reasons. Either no price could be resolved, because /v1/models quotes cost to API-key callers only and there was no authored \`[cost]\` to fall back on, in which case setting \`PRIVATEMIND_API_KEY\` creates them. Or no canonical \`models/\` entry matched the id, so there was no published output cap to inherit and nothing was invented: author the lab entry and the next sync picks it up.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
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
    const reasoning = params.includes("reasoning") || params.includes("include_reasoning");
    const effortToggle = Boolean(caps.reasoning_effort);
    const effortLevels = caps.reasoning_effort_levels ?? [];
    // On a graded dial, "off" is the toggle and the rest are the levels.
    const gradedLevels = effortLevels.filter((level): level is GradedLevel => level !== "off");
    // `reasoning_mandatory` is the platform's own thinking-only classification,
    // derived from how the deployment is served rather than declared per
    // capability, so it decides the toggle: such a model answers "off" with
    // HTTP 400 whatever else it advertises. Everything else with a reasoning
    // control has a real on/off switch, offered either as the bare capability
    // or as "off" among the dial's values.
    const hasToggle =
      caps.reasoning_mandatory === true ? false : effortToggle || effortLevels.includes("off");
    // Leading wire-path comment for the model file (every toggle needs one;
    // an effort dial gets the same treatment). Written on every sync.
    const effortDefault = caps.reasoning_effort_default;
    const headerLines: string[] = [];
    if (hasToggle) {
      headerLines.push(
        gradedLevels.length > 0
          ? `# Toggle: reasoning_effort = off|${gradedLevels.join("|")} ("off" disables thinking; the listed levels set its depth)`
          : `# Toggle: reasoning_effort = off|${WIRE_LEVELS.join("|")} ("off" disables, every other value enables it identically)`,
      );
    }
    if (gradedLevels.length > 0) {
      const notes = [
        effortDefault === undefined ? undefined : `default ${effortDefault}`,
        hasToggle ? undefined : 'always thinking, "off" returns 400',
      ].filter((note) => note !== undefined);
      headerLines.push(
        `# Effort: reasoning_effort = ${gradedLevels.join("|")}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`,
      );
    }
    if (reasoning && gradedLevels.length === 0) {
      // Why a reasoning model here can carry no effort list: the platform
      // resolves the caller's reasoning_effort against the deployment's own
      // body fragment and never forwards the level, so where the deployment
      // declares no per-level rows the enabling values are one control.
      headerLines.push(
        "# No graded dial on this deployment: the platform consumes reasoning_effort rather",
        "# than forwarding it, and resolves every enabling value to the same request. A value",
        `# outside off|${WIRE_LEVELS.join("|")} returns HTTP 400.`,
      );
    }
    if (headerLines.length > 0) {
      headerLines.push("# https://docs.privatemind.com/chat-completions.html#reasoning-effort");
    }
    if (vision) {
      headerLines.push(
        VIDEO_REFUSED.has(model.id)
          ? "# Modalities: text and image. This deployment refuses `video_url`, and `file` is not a supported part type on this API."
          : "# Modalities: text, image and video, inherited from the lab entry and confirmed by a `video_url` request billing video tokens. `file` is not a supported part type on this API.",
      );
    }
    const header = headerLines.length > 0 ? `${headerLines.join("\n")}\n` : undefined;
    const context_length = model.context_length ?? 0;
    const existing = context.existing(model.id);
    // A price is written only when the API quotes both sides; a half-quoted
    // rate is never padded with 0. Otherwise the authored cost stands, and a
    // model with no cost anywhere (an unkeyed run meeting a new deployment)
    // is skipped until a keyed run can price it.
    // Both sides of the token rate are required; the cache axes ride along
    // when the API quotes them, and are omitted rather than guessed when not.
    const apiCost =
      cost.input_per_m_token != null && cost.output_per_m_token != null
        ? {
            input: price(cost.input_per_m_token),
            output: price(cost.output_per_m_token),
            ...(cost.cache_read_per_m_token != null
              ? { cache_read: price(cost.cache_read_per_m_token) }
              : {}),
            ...(cost.cache_write_per_m_token != null
              ? { cache_write: price(cost.cache_write_per_m_token) }
              : {}),
          }
        : undefined;
    const authoredCost =
      existing?.cost?.input !== undefined && existing.cost.output !== undefined
        ? {
            input: existing.cost.input,
            output: existing.cost.output,
            ...(existing.cost.cache_read !== undefined
              ? { cache_read: existing.cost.cache_read }
              : {}),
            ...(existing.cost.cache_write !== undefined
              ? { cache_write: existing.cost.cache_write }
              : {}),
          }
        : undefined;
    const resolvedCost = apiCost ?? authoredCost;
    if (resolvedCost === undefined && existing === undefined) return undefined;
    const date = isoDate(model.created);
    // Every entry is factored onto canonical metadata, so a model with no
    // match, or with no serving window to clamp an inherited cap to, is
    // skipped for manual authoring rather than written from invented values.
    const baseModel = resolveBaseModel(model.id);
    if (baseModel === undefined || context_length <= 0) return undefined;
    // Inherit the lab entry's input modalities and subtract only what this
    // deployment provably refuses, rather than flattening every vision model
    // to text and image.
    const declared = baseInputModalities(baseModel);
    const inputModalities = (declared ?? (vision ? ["text", "image"] : ["text"])).filter(
      (kind) =>
        !DOCUMENT_KINDS.has(kind) &&
        !(kind === "video" && VIDEO_REFUSED.has(model.id)) &&
        (kind !== "image" || vision),
    ) as ("text" | "image" | "video" | "audio" | "pdf")[];
    // Output cap: inherit the base model's published limit.output, clamped to
    // the serving window, since output cannot exceed it. Never synthesized, so
    // a base that publishes no cap skips the entry too.
    const baseOutput = baseOutputLimit(baseModel);
    if (baseOutput === undefined) return undefined;
    const outputLimit = Math.min(baseOutput, context_length);

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
      // reasoning_effort semantics are advertised per model. A thinking-only
      // deployment publishes its accepted depths in reasoning_effort_levels
      // (Kimi K3 and GLM 5.3: low | high | max) and rejects "off". A hybrid
      // carries the bare capability, a verified on/off toggle: "off" disables
      // `message.reasoning`, every other accepted value enables it
      // identically. A model with a dial that lists "off" carries both.
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
    // publishes no authoritative dates (`created` is request-time), so the
    // entry inherits release_date and last_updated from the lab file and the
    // synthesized pair is dropped here. Every entry is factored: a model with
    // no canonical base was skipped above rather than written inline, because
    // a non-lab host must not invent lab metadata.
    const { release_date: _releaseDate, last_updated: _lastUpdated, ...overrides } = synced;
    return { id: model.id, model: factorBaseModel(baseModel, overrides, synced.limit), header };
  },
} satisfies SyncProvider<PrivateMindModel>;
