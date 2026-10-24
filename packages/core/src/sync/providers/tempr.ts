import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { SyncProvider, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { resolveCanonicalBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

// Tempr Gateway's public catalog: every model it serves on a caller's own provider key, in
// OpenRouter's model-list shape plus a `tempr` object. No key needed.
// https://temprhq.io/docs/gateway-reference#catalog
const API_ENDPOINT = "https://api.temprhq.io/v1/catalog";
const ROOT_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..");
const REASONING_DOCS = "https://temprhq.io/docs/gateway-chat-completions#reasoning";

// A catalog this small is an outage on Tempr's side, not the labs retiring their models; syncing
// it would delete most of the provider.
const MIN_MODELS = 100;

// Fields of the mirrored provider entry that describe that provider's own request surface, not
// the model: Tempr's surface is its own, and its reasoning comes back in its own shape.
const PROVIDER_ONLY_FIELDS = ["reasoning_options", "interleaved", "provider", "experimental", "npm", "api", "shape"] as const;

// How a provider entry describes and dates a model says nothing about using it through Tempr; a
// Tempr entry inherits the lab file's.
const CATALOGUE_FIELDS = ["description", "release_date", "last_updated", "knowledge", "family"] as const;

const ReasoningOption = z.object({
  type: z.enum(["toggle", "effort", "budget_tokens"]),
  values: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
}).strict();
type ReasoningOption = z.infer<typeof ReasoningOption>;

// The effort values the schema accepts (schema.ts ReasoningEffortValue). A catalog value outside
// them is a vocabulary change to review, not something to publish.
const SCHEMA_EFFORT_VALUES = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]);

function hasUnknownEffort(options: ReasoningOption[]) {
  return options.some((o) => o.type === "effort" && (o.values ?? []).some((v) => !SCHEMA_EFFORT_VALUES.has(v)));
}

const PriceTier = z.object({
  min_prompt_tokens: z.number(),
  prompt: z.string().optional(),
  completion: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
}).passthrough();

export const TemprModel = z.object({
  id: z.string().min(1),
  name: z.string(),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
    overrides: z.array(PriceTier).optional(),
  }).passthrough(),
  supported_parameters: z.array(z.string()),
  tempr: z.object({
    provider: z.string(),
    model: z.string(),
    type: z.enum(["language", "embedding"]),
    status: z.string().nullable(),
    price_source: z.enum(["tempr", "models.dev"]),
    reasoning_forwarded: z.boolean().default(true),
    provider_kind: z.string().nullable().optional(),
    models_dev: z.object({
      provider: z.string(),
      model: z.string(),
      canonical_model_id: z.string().nullable().optional(),
    }).passthrough(),
    reasoning_options: z.array(ReasoningOption).optional(),
  }).passthrough(),
}).passthrough();
export type TemprModel = z.infer<typeof TemprModel>;

export const TemprCatalog = z.object({
  schema: z.literal(1),
  data: z.array(TemprModel),
}).passthrough();

type Toml = Record<string, unknown>;

function readToml(relative: string): Toml | undefined {
  const file = path.join(ROOT_DIR, relative);
  if (!existsSync(file)) return undefined;
  return Bun.TOML.parse(readFileSync(file, "utf8")) as Toml;
}

// The catalog is remote data: its ids may only name files under providers/ and models/.
// Provider directories can contain dots (providers/wafer.ai); a leading character that isn't a
// letter or digit rules out "." and "..".
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*(\/[A-Za-z0-9][A-Za-z0-9._:@+-]*)*$/;

export function isSafeModelPath(id: string) {
  return SAFE_MODEL.test(id) && !id.split("/").some((part) => part === "." || part === "..");
}

/**
 * The models.dev entry a Tempr model mirrors: the same model under the provider Tempr reaches it
 * on. Undefined when the catalog's ids aren't plain provider and model ids.
 */
export function counterpartPath(model: TemprModel) {
  const { provider, model: id } = model.tempr.models_dev;
  if (!SAFE_PROVIDER.test(provider) || !isSafeModelPath(id)) return undefined;
  return `providers/${provider}/models/${id}.toml`;
}

/** A per-token price string (OpenRouter's unit) as models.dev's price per million tokens. */
export function perMillion(perToken: string | undefined): number | undefined {
  if (perToken === undefined) return undefined;
  const value = Number(perToken);
  return Number.isFinite(value) ? Number((value * 1_000_000).toPrecision(12)) : undefined;
}

function temprCost(model: TemprModel) {
  const pricing = model.tempr.price_source === "tempr" ? model.pricing : undefined;
  if (pricing === undefined) return undefined;
  const tiers = (pricing.overrides ?? []).flatMap((tier) => {
    const input = perMillion(tier.prompt);
    const output = perMillion(tier.completion);
    if (input === undefined || output === undefined) return [];
    return [stripUndefined({
      input,
      output,
      cache_read: perMillion(tier.input_cache_read),
      cache_write: perMillion(tier.input_cache_write),
      tier: { type: "context" as const, size: tier.min_prompt_tokens },
    })];
  });
  return stripUndefined({
    input: perMillion(pricing.prompt),
    output: perMillion(pricing.completion),
    cache_read: perMillion(pricing.input_cache_read),
    cache_write: perMillion(pricing.input_cache_write),
    tiers: tiers.length > 0 ? tiers : undefined,
  });
}

/**
 * Tempr's controls, written the way the mirrored entry writes "can be off" -- a toggle, or "none"
 * among the effort values, never both -- so the two read alike.
 */
export function encodeOptions(temprOptions: ReasoningOption[], sourceOptions: ReasoningOption[]): ReasoningOption[] {
  const toggle = temprOptions.some((o) => o.type === "toggle");
  const effort = temprOptions.find((o) => o.type === "effort");
  const budget = temprOptions.find((o) => o.type === "budget_tokens");
  const canDisable = toggle || (effort?.values ?? []).includes("none") || budget?.min === 0;
  const levels = (effort?.values ?? []).filter((v) => v !== "none");
  const sourceUsesNone = sourceOptions.some((o) => o.type === "effort" && (o.values ?? []).includes("none"));

  const out: ReasoningOption[] = [];
  if (canDisable && levels.length > 0 && sourceUsesNone) out.push({ type: "effort", values: ["none", ...levels] });
  else {
    if (canDisable) out.push({ type: "toggle" });
    if (levels.length > 0) out.push({ type: "effort", values: levels });
  }
  if (budget !== undefined) out.push(stripUndefined({ type: "budget_tokens" as const, min: budget.min, max: budget.max }));
  return out;
}

/** The leading comment: which request fields set each control on Tempr's three surfaces. */
export function header(options: ReasoningOption[], forwarded: boolean, hostListsControls: boolean, host = true): string[] {
  const lines = [`# Tempr Gateway: ${REASONING_DOCS}`];
  if (!forwarded) {
    lines.push(
      "# No caller control on Tempr: Tempr forwards no reasoning settings to this host at",
      "# all. It routes each model to whichever upstream provider serves it, and those providers",
      "# disagree, so there is no deterministic behaviour to expose.",
    );
    return lines;
  }
  if (options.length === 0) {
    if (hostListsControls) {
      lines.push(
        "# No caller control on Tempr for this model on this host, deliberately: its effort levels",
        "# don't behave as labelled here, so Tempr exposes none rather than a picker that does the",
        "# opposite of what it says.",
      );
    } else {
      lines.push(...(host
        ? ["# No reasoning control for this model on this host: it reasons at its own depth,", '# and the x-tempr-reasoning-effort response header reports "default".']
        : ["# No reasoning control for this model: it reasons at its own depth, and the", '# x-tempr-reasoning-effort response header reports "default".']));
    }
    return lines;
  }
  const effort = options.find((o) => o.type === "effort");
  const levels = (effort?.values ?? []).filter((v) => v !== "none");
  const toggle = options.some((o) => o.type === "toggle");
  const canDisable = toggle || (effort?.values ?? []).includes("none");
  const budget = options.some((o) => o.type === "budget_tokens");
  const off = canDisable ? "none|" : "";
  if (canDisable) {
    lines.push(toggle
      ? '# Toggle: reasoning.enabled = true|false (reasoning.effort = "none" also turns it off)'
      : '# Off: reasoning.effort = "none" (or reasoning.enabled = false)');
  }
  if (levels.length > 0) lines.push(`# Effort: reasoning.effort = ${off}${levels.join("|")} (alias: top-level reasoning_effort)`);
  if (budget) lines.push("# Budget: reasoning.max_tokens (integer reasoning tokens)");

  const messages: string[] = [];
  if (canDisable) messages.push("thinking.type = enabled|disabled");
  if (levels.length > 0) messages.push(`output_config.effort = ${levels.join("|")}`);
  if (budget) messages.push("thinking.budget_tokens");
  if (messages.length > 0) lines.push(`# /v1/messages: ${messages.join("; ")}`);

  if (levels.length > 0) lines.push(`# /v1/responses: reasoning.effort = ${off}${levels.join("|")}`);
  else if (canDisable) lines.push('# /v1/responses: reasoning.effort = "none" turns it off, any other level turns it on');
  return lines;
}

function isPlainObject(value: unknown): value is Toml {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An entry without what it would inherit from the lab model anyway. A plain table ([limit],
 * [modalities]) merges onto the lab's key by key, so each equal key goes on its own; anything else
 * (arrays of tables included) replaces the lab's whole value. The lab files carry no cost.
 */
export function overridesOf(entry: Toml, lab: Toml): Toml {
  const out: Toml = {};
  for (const [key, value] of Object.entries(entry)) {
    const inherited = lab[key];
    if (isPlainObject(value) && isPlainObject(inherited)) {
      const table = Object.fromEntries(Object.entries(value).filter(([k, v]) => !isDeepStrictEqual(inherited[k], v)));
      if (Object.keys(table).length > 0) out[key] = table;
    } else if (!isDeepStrictEqual(inherited, value)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The lab model a Tempr entry inherits from: the mirrored entry's own base_model, or -- when the
 * mirrored entry is the lab's own full definition -- the lab file of the same id.
 */
function resolveBase(model: TemprModel, counterpart: Toml, read: (relative: string) => Toml | undefined) {
  if (typeof counterpart.base_model === "string") {
    const overrides = { ...counterpart };
    for (const field of CATALOGUE_FIELDS) delete overrides[field];
    return { base: counterpart.base_model, overrides };
  }
  const { provider, model: id, canonical_model_id } = model.tempr.models_dev;
  // models.dev's own resolvers: the lab prefix of a provider id (zai/ is the zhipuai/ lab), and a
  // host id that names its lab (openai/gpt-oss-20b).
  const candidates = [canonical_model_id, `${provider}/${id}`, resolveCanonicalBaseModel(`${provider}/${id}`), resolveModelMetadataBaseModel(id)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!isSafeModelPath(candidate)) continue;
    const lab = read(`models/${candidate}.toml`);
    if (lab === undefined) continue;
    const overrides = overridesOf(counterpart, lab);
    for (const field of CATALOGUE_FIELDS) delete overrides[field];
    return { base: candidate, overrides: { base_model: candidate, ...overrides } };
  }
  return undefined;
}

/**
 * The Tempr entry for one catalog model: the mirrored provider entry's own overrides on the same
 * base_model, Tempr's live price where its catalog confirms the model, and Tempr's reasoning
 * controls. Undefined when there is no lab model to inherit from.
 */
export function buildTemprModel(model: TemprModel, read: (relative: string) => Toml | undefined = readToml):
  { model: SyncedModel; header: string; controlsUnknown: boolean } | undefined {
  const relative = counterpartPath(model);
  const counterpart = relative === undefined ? undefined : read(relative);
  if (counterpart === undefined) return undefined;
  const resolved = resolveBase(model, counterpart, read);
  if (resolved === undefined) return undefined;

  const result: Toml = resolved.overrides;
  for (const field of PROVIDER_ONLY_FIELDS) delete result[field];
  const lines: string[] = [];

  // Tempr's /v1/embeddings takes OpenAI's embeddings shape: text in, whatever else the model
  // accepts elsewhere.
  if (model.tempr.type === "embedding") {
    const lab = read(`models/${resolved.base}.toml`);
    const labInput = (lab?.modalities as Toml | undefined)?.input ?? (counterpart.modalities as Toml | undefined)?.input;
    if (Array.isArray(labInput) && labInput.some((m) => m !== "text")) {
      result.attachment = false;
      result.modalities = { input: ["text"], output: ["text"] };
      for (const extra of ["input_audio", "output_audio"]) delete (result.cost as Toml | undefined)?.[extra];
      lines.push(
        "# Tempr serves this model on /v1/embeddings, which takes OpenAI's embeddings shape: text",
        "# input only there, so the lab's other input modalities aren't reachable through Tempr.",
      );
    }
  }

  const temprPrice = temprCost(model);
  if (temprPrice !== undefined) {
    // Tempr's catalog prices input, output and the cache; what it doesn't publish (a separate
    // reasoning rate, audio rates) stays as the mirrored entry has it.
    const mirrored = isPlainObject(result.cost) ? result.cost : isPlainObject(counterpart.cost) ? counterpart.cost : {};
    const cost: Toml = { ...temprPrice };
    for (const key of ["reasoning", "input_audio", "output_audio"]) {
      if (cost[key] === undefined && mirrored[key] !== undefined) cost[key] = mirrored[key];
    }
    if (!isDeepStrictEqual(cost, counterpart.cost)) result.cost = cost;
  }

  const reasons = model.supported_parameters.includes("reasoning") || model.supported_parameters.includes("include_reasoning");
  // An omitted list says nothing about the controls, so the authored ones are kept; an empty one
  // says there are none.
  const published = model.tempr.reasoning_forwarded ? model.tempr.reasoning_options : [];
  const controlsUnknown = reasons && (published === undefined || hasUnknownEffort(published));
  if (reasons && !controlsUnknown && published !== undefined) {
    const base = read(`models/${resolved.base}.toml`);
    const sourceOptions = (counterpart.reasoning_options ?? base?.reasoning_options ?? []) as ReasoningOption[];
    const options = encodeOptions(published, sourceOptions);
    result.reasoning_options = options;
    lines.push(...header(options, model.tempr.reasoning_forwarded, sourceOptions.length > 0, model.tempr.provider_kind !== "first_party"));
  }

  return { model: result as SyncedModel, header: lines.length > 0 ? lines.join("\n") + "\n" : "", controlsUnknown };
}

export const tempr = {
  id: "tempr",
  name: "Tempr Gateway",
  modelsDir: "providers/tempr/models",
  authoritativeHeaders: true,
  // A Tempr entry inherits the lab's description (see CATALOGUE_FIELDS), so an old one isn't kept.
  preserveDescriptions: false,
  sourceID(model) {
    return isSafeModelPath(model.id) ? model.id : undefined;
  },
  // A model skipped for having no lab file is still served: keep any entry it has, rather than
  // delete it, and report it. Models gone from the catalog are retirements and are deleted.
  missingModelID(model) {
    return isSafeModelPath(model.id) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Tempr models were skipped because there is no lab model to inherit from (a host-defined model that needs its own lab entry first).`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) throw new Error(`Tempr Gateway catalog request failed: ${response.status} ${response.statusText}`);
    return response.json();
  },
  parseModels(raw) {
    const catalog = TemprCatalog.parse(raw);
    if (catalog.data.length < MIN_MODELS) {
      throw new Error(`Tempr Gateway catalog lists only ${catalog.data.length} models (expected at least ${MIN_MODELS}); refusing to sync a partial catalog.`);
    }
    return catalog.data;
  },
  translateModel(model, context) {
    // The id names the file written, so it gets the same check as the ids that name files read.
    if (!isSafeModelPath(model.id)) return undefined;
    const built = buildTemprModel(model);
    if (built === undefined) return undefined;
    // A reasoning model whose controls the catalog omits, or lists in values the schema doesn't
    // know, keeps the controls already authored for it; a new one isn't written until they're known.
    if (built.controlsUnknown) {
      const kept = context.authored(model.id)?.reasoning_options as ReasoningOption[] | undefined;
      if (kept === undefined) {
        throw new MissingReasoningOptionsError(model.id, "the Tempr catalog lists no usable reasoning controls for this reasoning model");
      }
      // The runner keeps the authored controls; headers are authoritative, so the comment naming
      // their request fields is written again from them rather than dropped.
      const lines = header(kept, model.tempr.reasoning_forwarded, kept.length > 0, model.tempr.provider_kind !== "first_party");
      return { id: model.id, model: built.model, header: lines.join("\n") + "\n" };
    }
    return { id: model.id, model: built.model, header: built.header || undefined };
  },
} satisfies SyncProvider<TemprModel>;

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
