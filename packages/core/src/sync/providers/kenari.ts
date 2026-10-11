import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ReasoningOption as CatalogReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..", "..", "..");
const MODELS_DIR = path.join(ROOT, "models");
const PROVIDERS_DIR = path.join(ROOT, "providers");

// kenari is an OpenAI-compatible gateway. Both feeds are public, need no auth, and the pricing
// feed publishes the IDR->USD rate itself, so the USD `cost` this catalog stores comes from the
// provider's own number instead of an inferred one. Reference: https://kenari.id/docs/models
const CATALOG_ENDPOINT = process.env.KENARI_MODELS_URL ?? "https://kenari.id/v1/models";
const PRICING_ENDPOINT =
  process.env.KENARI_PRICING_URL ?? "https://kenari.id/api/public/pricing";
const PRICING_DOC = "https://kenari.id/api/public/pricing";

// kenari documents its own reasoning contract, so every `toggle` this module writes cites the
// host's field rather than whoever the option set was borrowed from. AGENTS.md requires that
// wire path in the file header. See https://kenari.id/docs/reasoning: /v1/chat/completions
// takes the flat `reasoning_effort`, and also a unified `reasoning` object with `enabled`
// (boolean), `effort`, `max_tokens` (reasoning budget) and `exclude`; /v1/messages takes the
// Anthropic `thinking` block instead.
const DOCS_URL = "https://kenari.id/docs/reasoning";

// `owned_by` is kenari's own lab label and does not always equal the catalog's lab id.
const LAB_ALIAS: Record<string, string> = { "x-ai": "xai", "z-ai": "zhipuai", qwen: "alibaba" };

// kenari mixes decimal and binary token counts (128000 vs 131072); below this the two agree.
const CONTEXT_TOLERANCE = 0.03;

// The feed also reports lanes the catalog's schema has no enum for (`file`), so modality
// values are filtered rather than passed straight into a strict schema.
const MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;
type Modality = (typeof MODALITIES)[number];
const isModality = (value: string): value is Modality =>
  (MODALITIES as readonly string[]).includes(value);

const CatalogModel = z
  .object({
    id: z.string().min(1),
    owned_by: z.string().optional(),
    endpoints: z.array(z.string()).optional(),
    context_length: z.number().int().positive().nullable().optional(),
    modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).optional(),
    reasoning: z.boolean().nullable().optional(),
    // kenari's flat level list, or null when it lists none for that id.
    reasoning_options: z.array(z.string()).nullable().optional(),
    // true only once a verified provider-specific "reasoning off" payload is registered; false
    // does NOT mean the switch is missing, so this module never reads it as one.
    reasoning_toggle: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    pricing: z
      .object({
        currency: z.string().optional(),
        unit: z.string().optional(),
        free: z.boolean().optional(),
        input: z.number().nullable().optional(),
        output: z.number().nullable().optional(),
        cache_read: z.number().nullable().optional(),
        cache_write: z.number().nullable().optional(),
      })
      .optional(),
    sunset_at: z.string().nullable().optional(),
  })
  .passthrough();

const CatalogResponse = z.object({ data: z.array(CatalogModel) }).passthrough();

const PricingResponse = z
  .object({
    usd_idr_rate: z.number().positive(),
    items: z.array(z.object({ model: z.string() }).passthrough()).optional(),
  })
  .passthrough();

export type KenariCatalogModel = z.infer<typeof CatalogModel>;

/** A catalog model joined with the IDR->USD rate in force when the feed was read. */
export interface KenariModel {
  model: KenariCatalogModel;
  rate: number;
}

interface LabEntry {
  /** The stem as spelled on disk, so `base_model` matches the file exactly. */
  stem: string;
  context?: number;
  input?: number;
}

let labIndex: Map<string, Map<string, LabEntry>> | undefined;
interface LabControl {
  options: CatalogReasoningOption[] | null;
  reasoning: boolean | undefined;
}

let controlIndex: Map<string, Map<string, LabControl>> | undefined;

function readToml(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = Bun.TOML.parse(readFileSync(file, "utf-8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** `models/<lab>/<stem>.toml` — the only entries a provider file may point `base_model` at. */
function labEntries(): Map<string, Map<string, LabEntry>> {
  if (labIndex) return labIndex;
  const index = new Map<string, Map<string, LabEntry>>();
  for (const lab of readdirSync(MODELS_DIR, { withFileTypes: true })) {
    if (!lab.isDirectory()) continue;
    const entries = new Map<string, LabEntry>();
    for (const file of readdirSync(path.join(MODELS_DIR, lab.name))) {
      if (!file.endsWith(".toml")) continue;
      const stem = file.slice(0, -5);
      const limit = readToml(path.join(MODELS_DIR, lab.name, file))?.limit;
      const record =
        typeof limit === "object" && limit !== null ? (limit as Record<string, unknown>) : {};
      entries.set(stem.toLowerCase(), {
        stem,
        context: typeof record.context === "number" ? record.context : undefined,
        input: typeof record.input === "number" ? record.input : undefined,
      });
    }
    index.set(lab.name, entries);
  }
  labIndex = index;
  return index;
}

/**
 * A lab's own first-party host entry (`providers/<lab>/models/**`). `reasoning_options` is a
 * provider-only field and never appears under `models/`, so a lab's reasoning controls live
 * here — and AGENTS.md makes them the starting point for a relay.
 */
function labControls(): Map<string, Map<string, LabControl>> {
  if (controlIndex) return controlIndex;
  const index = new Map<string, Map<string, LabControl>>();
  for (const provider of readdirSync(PROVIDERS_DIR, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    const controls = new Map<string, LabControl>();
    const pending = [path.join(PROVIDERS_DIR, provider.name, "models")];
    while (pending.length > 0) {
      const dir = pending.pop();
      if (dir === undefined) continue;
      let children;
      try {
        children = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        const full = path.join(dir, child.name);
        if (child.isDirectory()) {
          pending.push(full);
          continue;
        }
        if (!child.name.endsWith(".toml")) continue;
        const key = `${provider.name}/${child.name.slice(0, -5)}`;
        if (controls.has(key)) continue; // first wins, so a flat entry beats a nested one
        const entry = readToml(full);
        const value = entry?.reasoning_options;
        const options = value === undefined ? null : z.array(CatalogReasoningOption).safeParse(value);
        controls.set(key, {
          options: options !== null && options.success ? options.data : null,
          reasoning: typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined,
        });
      }
    }
    index.set(provider.name, controls);
  }
  controlIndex = index;
  return index;
}

/** Candidate lab stems for a kenari id: verbatim, dotted, dashed, without the free lane. */
function candidateStems(id: string): string[] {
  const lower = (id.endsWith(":free") ? id.slice(0, -5) : id).toLowerCase();
  const out = [lower];
  for (const value of [
    lower.replace(/(?<=\d)-(?=\d)/g, "."),
    lower.replace(/(?<=\d)\.(?=\d)/g, "-"),
  ]) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** The lab entry a kenari id relays, or undefined when nothing in `models/` matches. */
export function resolveBaseModel(id: string, ownedBy: string | undefined): LabEntry | undefined {
  if (ownedBy === undefined || ownedBy === "") return undefined;
  const entries = labEntries().get(LAB_ALIAS[ownedBy] ?? ownedBy);
  if (entries === undefined) return undefined;
  for (const candidate of candidateStems(id)) {
    const entry = entries.get(candidate);
    if (entry !== undefined) return entry;
  }
  return undefined;
}

/**
 * Ids whose lab entry is not discoverable from the feed: `deepseek-v4-1-flash` is served by
 * DeepSeek-V4.1-Flash, whose first-party entry carries the legacy name `deepseek-flash`, and
 * `glm-4.7-flash` has no zhipuai host entry at all, so its control comes from the relay that
 * documents it.
 */
const REASONING_SOURCE: Record<string, string> = {
  "deepseek-v4-1-flash": "deepseek/deepseek-flash",
  "glm-4-7-flash:free": "openrouter/z-ai/glm-4.7-flash",
};

function sortControls(options: CatalogReasoningOption[]): CatalogReasoningOption[] {
  const order = { toggle: 0, effort: 1, budget_tokens: 2 };
  return [...options]
    .map((option) => ({ ...option }))
    .sort((a, b) => order[a.type] - order[b.type]);
}

/**
 * The option *set* is the lab entry's, per AGENTS.md's multi-model-relay rule. kenari's
 * published level list refines the *values* when it has one, because that list is the host's
 * own statement about which levels it accepts; a lab that declares an on/off control keeps its
 * toggle, since kenari translates `reasoning: { enabled: false }` for every reasoning model.
 */
export function resolveReasoningOptions(
  id: string,
  baseModel: string,
  levels: string[] | null | undefined,
  reasoning: boolean | null | undefined,
): CatalogReasoningOption[] | undefined {
  const source = REASONING_SOURCE[id] ?? baseModel;
  const controls = labControls().get(source.slice(0, source.indexOf("/")));
  const base = controls?.get(source) ?? null;
  // The resolved `reasoning` flag comes from the lab entry, not from kenari's feed: kenari
  // reports null for ids whose lab entry does declare a control, and the schema refuses
  // reasoning_options on a non-reasoner. So only the lab's own flag can suppress them.
  const reasons = reasoning ?? base?.reasoning;
  if (reasons === false) return undefined;

  if (levels !== null && levels !== undefined && levels.length > 0) {
    const options: CatalogReasoningOption[] = [{ type: "effort", values: [...levels] }];
    if (base?.options?.some((option) => option.type === "toggle")) {
      options.unshift({ type: "toggle" });
    }
    return sortControls(options);
  }

  if (base?.options != null && base.options.length > 0) return sortControls(base.options);
  // `[]` asserts "this model reasons but exposes no control", so it is only safe when the lab
  // entry says the model reasons; on a non-reasoner the schema refuses reasoning_options.
  return reasons === true ? [] : undefined;
}

/** `micro_idr_per_1m_tokens` -> USD per 1M tokens, at the rate the feed published. */
export function toUsd(micro: number | null | undefined, rate: number): number | undefined {
  if (micro === null || micro === undefined) return undefined;
  const value = micro / 1_000_000 / rate;
  // Two decimals at or above $1, four below — the magnitudes a picker renders.
  return Number(value >= 1 ? value.toFixed(2) : value.toFixed(4));
}

/** AGENTS.md: a `toggle` may not be written without its wire path in the leading comment. */
function reasoningHeader(model: SyncedModel): string | undefined {
  const options = model.reasoning_options;
  if (options === undefined || options.length === 0) return undefined;
  const lines = [`# Pricing: GET ${PRICING_DOC} (usd_idr_rate; synced by the kenari module)`];
  lines.push(`# Docs: ${DOCS_URL}`);
  if (options.some((option) => option.type === "toggle")) {
    lines.push("# Toggle: reasoning.enabled = true|false");
  }
  const effort = options.find((option) => option.type === "effort");
  if (effort !== undefined && effort.type === "effort" && effort.values.length > 0) {
    lines.push(`# Effort: reasoning_effort = ${effort.values.join("|")}`);
  }
  if (options.some((option) => option.type === "budget_tokens")) {
    lines.push("# Budget: reasoning.max_tokens (integer reasoning-token budget)");
  }
  return `${lines.join("\n")}\n`;
}

export const kenari = {
  id: "kenari",
  name: "Kenari",
  modelsDir: "providers/kenari/models",
  // Factoring is explicit below, and a lab-identical override must not be re-injected on every
  // run, so both defaults are off the way the other factored gateways do it.
  preserveBaseModels: false,
  preserveDescriptions: false,
  async fetchModels() {
    const [catalog, pricing] = await Promise.all([fetch(CATALOG_ENDPOINT), fetch(PRICING_ENDPOINT)]);
    if (!catalog.ok) {
      throw new Error(`kenari catalog request failed: ${catalog.status} ${catalog.statusText}`);
    }
    if (!pricing.ok) {
      throw new Error(`kenari pricing request failed: ${pricing.status} ${pricing.statusText}`);
    }
    const rate = PricingResponse.parse(await pricing.json()).usd_idr_rate;
    return { catalog: await catalog.json(), rate };
  },
  parseModels(raw) {
    const { catalog, rate } = raw as { catalog: unknown; rate: number };
    const models = CatalogResponse.parse(catalog).data;
    // deleteMissing runs at the runner default, so an empty or truncated feed must fail here
    // rather than read as "delete the whole catalog".
    if (models.length === 0) {
      throw new Error("kenari catalog returned no models; refusing an empty feed as authoritative");
    }
    return models.map((model) => ({ model, rate }));
  },
  translateModel(source, context) {
    const { model, rate } = source;
    // `authored` is the raw TOML and the only thing that can carry a genuine override; a file
    // already sitting on its base keeps its display-name and capability deltas through it.
    const authored: ExistingModel | undefined = context.authored(model.id);
    const lab = resolveBaseModel(model.id, model.owned_by);
    const labID =
      lab === undefined
        ? undefined
        : `${LAB_ALIAS[model.owned_by ?? ""] ?? model.owned_by ?? ""}/${lab.stem}`;
    const baseModel = authored?.base_model ?? labID;
    // A feed model with no resolvable lab entry must never be written as an unfactored full
    // definition; it goes to the missing-model issue flow, which also preserves any existing
    // local file for that id (a hand-authored standalone entry, for instance).
    if (baseModel === undefined) return undefined;

    const chat = model.endpoints === undefined || model.endpoints.every((value) => value === "chat");
    const pricing = model.pricing;
    const free = pricing?.free === true;
    const cost = {
      input: free ? 0 : toUsd(pricing?.input, rate),
      output: free ? 0 : toUsd(pricing?.output, rate),
      cache_read: free ? undefined : toUsd(pricing?.cache_read, rate),
      cache_write: free ? undefined : toUsd(pricing?.cache_write, rate),
    };

    const reasoningOptions = resolveReasoningOptions(
      model.id,
      baseModel,
      model.reasoning_options,
      model.reasoning,
    );

    // A gateway cannot grant more context than the model itself has, so kenari's number is only
    // adopted when it is *smaller* than the lab's and the gap is real rather than a
    // decimal-vs-binary artifact.
    const advertised = chat ? (model.context_length ?? undefined) : undefined;
    const labContext = lab?.context;
    const narrows =
      advertised !== undefined &&
      labContext !== undefined &&
      advertised < labContext &&
      (labContext - advertised) / labContext > CONTEXT_TOLERANCE;

    const host: Partial<SyncedFullModel> = {
      cost: {
        input: cost.input ?? 0,
        output: cost.output ?? 0,
        ...(cost.cache_read === undefined ? {} : { cache_read: cost.cache_read }),
        ...(cost.cache_write === undefined ? {} : { cache_write: cost.cache_write }),
      },
      ...(reasoningOptions === undefined ? {} : { reasoning_options: reasoningOptions }),
      ...(narrows ? { limit: { context: advertised } } : {}),
      ...(chat && model.modalities !== undefined
        ? {
            modalities: {
              input: model.modalities.input.filter(isModality).sort(),
              output: model.modalities.output.filter(isModality).sort(),
            },
          }
        : {}),
    };

    const deltas = authored?.base_model === baseModel ? authored : undefined;
    const built = factorBaseModel(
      baseModel,
      {
        ...host,
        name: deltas?.name,
        description: deltas?.description,
        release_date: deltas?.release_date,
        last_updated: deltas?.last_updated,
        knowledge: deltas?.knowledge,
        open_weights: deltas?.open_weights,
      },
      undefined,
      deltas?.base_model_omit,
    ) as SyncedModel;

    return { id: model.id, model: built, header: reasoningHeader(built) };
  },
  sourceID(model) {
    return model.model.id;
  },
  // The only skip is "no lab entry to point at", never an intentional removal, so every skip
  // enters the missing-model issue flow: the runner keeps any existing local entry and opens one
  // deduped issue asking for the lab mapping.
  missingModelID(model) {
    return model.model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `Skipped ${ids.length} feed model(s) with no resolvable lab entry (missing-model issue flow): ${ids.join(", ")}`,
    ];
  },
} satisfies SyncProvider<KenariModel>;
