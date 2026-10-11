import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ReasoningOption as CatalogReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel } from "./openrouter.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..", "..", "..");
const MODELS_DIR = path.join(ROOT, "models");
const PROVIDERS_DIR = path.join(ROOT, "providers");

// kenari is an OpenAI-compatible gateway. Both feeds are public and need no auth, and the
// pricing feed publishes the IDR->USD rate itself, so the USD `cost` this catalog stores comes
// from the provider's own number instead of an inferred one.
// Reference: https://kenari.id/docs/models
const CATALOG_ENDPOINT = process.env.KENARI_MODELS_URL ?? "https://kenari.id/v1/models";
const PRICING_ENDPOINT =
  process.env.KENARI_PRICING_URL ?? "https://kenari.id/api/public/pricing";
const CATALOG_DOC = "https://kenari.id/docs/models";
const PRICING_DOC = "https://kenari.id/api/public/pricing";

// kenari documents its own reasoning contract, so every `toggle` this module writes cites the
// host's field rather than whoever the option set was borrowed from. AGENTS.md requires that
// wire path in the file header. /v1/chat/completions takes the flat `reasoning_effort`, and also
// a unified `reasoning` object with `enabled` (boolean), `effort`, `max_tokens` (reasoning
// budget) and `exclude`; /v1/messages takes the Anthropic `thinking` block instead.
const DOCS_URL = "https://kenari.id/docs/reasoning";

// `owned_by` is kenari's own lab label and does not always equal the catalog's lab id.
const LAB_ALIAS: Record<string, string> = { "x-ai": "xai", "z-ai": "zhipuai", qwen: "alibaba" };

// kenari mixes decimal and binary token counts (128000 vs 131072); below this the two agree.
const CONTEXT_TOLERANCE = 0.03;

// The unit the conversion below assumes. Prices arrive as micro-IDR per 1M tokens; if the feed
// ever says otherwise the price is not comparable, so it is left to the lab entry rather than
// converted blind.
const PRICING_CURRENCY = "IDR";
const PRICING_UNIT = "micro_idr_per_1m_tokens";

// `deleteMissing` runs at the runner default and `sunset_at` is not guaranteed to be populated
// on every retirement, so a truncated-but-non-empty feed must fail here rather than read as
// "delete most of the catalog".
const MIN_LIVE_MODELS = 30;

// The feed also reports lanes the catalog's schema has no enum for (`file`), so modality
// values are filtered rather than passed straight into a strict schema.
const MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;
type Modality = (typeof MODALITIES)[number];
const isModality = (value: string): value is Modality =>
  (MODALITIES as readonly string[]).includes(value);

/** One unrecognised level fails `SyncedAuthoredModel` and aborts the whole run for every model. */
function isReasoningEffort(value: string): boolean {
  return CatalogReasoningOption.safeParse({ type: "effort", values: [value] }).success;
}

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
    // kenari's own retirement date. Absence of an id is not proof of retirement, which is why
    // `MIN_LIVE_MODELS` exists; this field is the explicit signal when it is populated.
    sunset_at: z.string().nullable().optional(),
  })
  .passthrough();

const CatalogResponse = z.object({ data: z.array(CatalogModel) }).passthrough();

// Only the rate is read here. The feed's `items` carry the same prices the catalog feed already
// attaches to each model, in the unit `PRICING_UNIT` names, so joining them by id would add a
// second source of truth for one number rather than a check on it. `.passthrough()` keeps the
// rest of the payload available if that ever stops being true.
const PricingResponse = z
  .object({ usd_idr_rate: z.number().positive() })
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

interface LabControl {
  /** The entry's own `reasoning_options`: `null` when absent, `[]` when explicitly empty. */
  options: CatalogReasoningOption[] | null;
  reasoning: boolean | undefined;
}

interface ControlIndex {
  /** Keyed by the id form a `base_model` uses, plus each entry's own path form. */
  byKey: Map<string, LabControl>;
  /** Keyed by `base_model`, so a lab served only through relays still resolves. */
  byBaseModel: Map<string, LabControl>;
}

let labIndex: Map<string, Map<string, LabEntry>> | undefined;
let controlIndex: ControlIndex | undefined;

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
 * Every provider entry that declares reasoning controls, reachable by the id a `base_model`
 * would use. Two shapes have to be covered, because a provider may namespace its own entries:
 *
 *   providers/alibaba/models/qwen3.8-max.toml        -> alibaba/qwen3.8-max
 *   providers/nvidia/models/nvidia/nemotron-....toml -> nvidia/nvidia/... and nvidia/...
 *
 * `reasoning_options` is a provider-only field and never appears under `models/`, so a lab's
 * controls live in its own first-party entry here, and AGENTS.md makes that entry the starting
 * point for a relay. Some labs have no entry of their own at all and are only reachable through
 * the relays that carry them, so every entry is also indexed by the `base_model` it serves.
 */
function labControls(): ControlIndex {
  if (controlIndex) return controlIndex;
  const byKey = new Map<string, LabControl>();
  const byBaseModel = new Map<string, LabControl>();
  for (const provider of readdirSync(PROVIDERS_DIR, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    const pending: Array<{ dir: string; prefix: string }> = [
      { dir: path.join(PROVIDERS_DIR, provider.name, "models"), prefix: "" },
    ];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      let children;
      try {
        children = readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        const full = path.join(current.dir, child.name);
        if (child.isDirectory()) {
          pending.push({ dir: full, prefix: `${current.prefix}${child.name}/` });
          continue;
        }
        if (!child.name.endsWith(".toml")) continue;
        const rest = `${current.prefix}${child.name.slice(0, -5)}`;
        const entry = readToml(full);
        const value = entry?.reasoning_options;
        const options = value === undefined ? null : z.array(CatalogReasoningOption).safeParse(value);
        const control: LabControl = {
          options: options !== null && options.success ? options.data : null,
          reasoning: typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined,
        };
        byKey.set(`${provider.name}/${rest}`, control);
        // A provider that namespaces under its own name spells the same id twice; the
        // un-doubled form is the one `base_model` uses.
        const namespace = rest.slice(0, rest.indexOf("/"));
        if (namespace === provider.name) byKey.set(rest, control);
        const baseModel = typeof entry?.base_model === "string" ? entry.base_model : undefined;
        if (baseModel !== undefined && (control.options?.length ?? 0) > 0) {
          if (!byBaseModel.has(baseModel)) byBaseModel.set(baseModel, control);
        }
      }
    }
  }
  controlIndex = { byKey, byBaseModel };
  return controlIndex;
}

/**
 * The controls for the model a kenari id relays. The lab's own entry wins outright: an explicit
 * `[]` there is the lab asserting "this model reasons but exposes no caller control", and a
 * relay listing more must not override it. Only when the lab has no entry at all does a relay
 * carrying the same `base_model` become the evidence.
 */
function controlFor(source: string): LabControl | null {
  const index = labControls();
  const direct = index.byKey.get(source);
  if (direct !== undefined) return direct;
  return index.byBaseModel.get(source) ?? null;
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
 * AGENTS.md's multi-model-relay rule makes the model's own lab entry the authority for a
 * relay's controls, so its option *set* is the starting point and kenari's published level list
 * may only narrow it: dropping a `budget_tokens` the host forwards, or widening `effort` past
 * what the lab documents, both assert something the evidence does not support. The lab's own
 * `reasoning` flag is what settles whether the model reasons at all, because kenari reports
 * `null` for ids whose lab entry does declare controls.
 */
export function resolveReasoningOptions(
  id: string,
  baseModel: string,
  levels: string[] | null | undefined,
  reasoning: boolean | null | undefined,
): CatalogReasoningOption[] | undefined {
  const source = REASONING_SOURCE[id] ?? baseModel;
  const base = controlFor(source);
  const reasons = reasoning ?? base?.reasoning ?? undefined;
  if (reasons === false) return undefined;

  // kenari's own list, restricted to the vocabulary the schema knows.
  const hostLevels = (levels ?? []).filter(isReasoningEffort);

  if (base?.options != null) {
    if (base.options.length === 0) return [];
    return sortControls(
      base.options.map((option) => {
        if (option.type !== "effort" || hostLevels.length === 0) return option;
        const kept = option.values.filter((value) => hostLevels.includes(value));
        // A disjoint list is not evidence that the model lost a level, so the lab's own set
        // stands rather than the entry claiming "no caller control".
        return kept.length === 0 ? option : { type: "effort", values: kept };
      }),
    );
  }

  // No lab entry to start from: kenari's list is then the only evidence there is.
  if (hostLevels.length > 0) return sortControls([{ type: "effort", values: hostLevels }]);

  if (reasons === true) {
    throw new MissingReasoningOptionsError(
      id,
      `kenari serves ${id} as a reasoner, but neither ${source} nor kenari's feed publishes a`
        + " schema-valid reasoning_options set; research the host's controls before listing",
    );
  }
  return undefined;
}

/** `micro_idr_per_1m_tokens` -> USD per 1M tokens, at the rate the feed published. */
export function toUsd(micro: number | null | undefined, rate: number): number | undefined {
  if (micro === null || micro === undefined) return undefined;
  const value = micro / 1_000_000 / rate;
  // Two decimals at or above $1, four below — the magnitudes a picker renders.
  const rounded = Number(value.toFixed(value >= 1 ? 2 : 4));
  // Rounding must never turn a paid route into `0`, which would read as a free one.
  return rounded === 0 && value > 0 ? Number(value.toPrecision(2)) : rounded;
}

/** The feed's prices are comparable only in the unit the conversion assumes. */
function pricingIsMicroIdr(
  pricing: KenariCatalogModel["pricing"],
): pricing is NonNullable<KenariCatalogModel["pricing"]> {
  if (pricing === undefined) return false;
  if (pricing.currency !== undefined && pricing.currency.toUpperCase() !== PRICING_CURRENCY) {
    return false;
  }
  return pricing.unit === undefined || pricing.unit === PRICING_UNIT;
}

/**
 * AGENTS.md: the rate and its date belong in the leading comment, and a `toggle` may not be
 * written without its wire path. This header is authoritative, so it is emitted for every
 * synced model, not only the ones that carry reasoning controls.
 */
function fileHeader(model: SyncedModel, rate: number): string {
  const lines = [
    "# Synced from kenari's public API by the kenari sync module.",
    `# Catalog: GET ${CATALOG_DOC}`,
    `# Pricing: GET ${PRICING_DOC} (usd_idr_rate = ${rate} on ${new Date().toISOString().slice(0, 10)})`,
    "# IDR prices were converted to USD per 1M tokens by dividing by that rate.",
  ];
  const options = "reasoning_options" in model ? model.reasoning_options : undefined;
  if (options === undefined || options.length === 0) return `${lines.join("\n")}\n`;

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

/** An id kenari has already retired; it is dropped so the runner removes the stale file. */
function isRetired(sunsetAt: string | null | undefined): boolean {
  if (sunsetAt === null || sunsetAt === undefined) return false;
  const at = Date.parse(sunsetAt);
  return Number.isFinite(at) && at <= Date.now();
}

export const kenari = {
  id: "kenari",
  name: "Kenari",
  modelsDir: "providers/kenari/models",
  // Factoring is explicit below, and a lab-identical override must not be re-injected on every
  // run, so both defaults are off the way the other factored gateways do it.
  preserveBaseModels: false,
  preserveDescriptions: false,
  // The header carries the rate and date in force for the last sync and the wire path of every
  // control written, so it is regenerated rather than left as whatever an earlier run wrote.
  authoritativeHeaders: true,
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
    const live = models.filter((model) => !isRetired(model.sunset_at));
    if (live.length < MIN_LIVE_MODELS) {
      throw new Error(
        `kenari catalog returned ${live.length} live models, below the ${MIN_LIVE_MODELS}`
          + " needed to distinguish a retirement from a truncated response",
      );
    }
    return live.map((model) => ({ model, rate }));
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

    const endpoints = model.endpoints;
    const chat = endpoints === undefined || endpoints.includes("chat");
    const pricing = pricingIsMicroIdr(model.pricing) ? model.pricing : undefined;
    const free = pricing?.free === true;
    // A free lane is priced at zero on its token rates but says nothing about caching, so the
    // cache rates are omitted rather than asserted as free.
    const price = (micro: number | null | undefined): number | undefined =>
      free ? 0 : toUsd(micro, rate);
    const cachePrice = (micro: number | null | undefined): number | undefined =>
      free ? undefined : toUsd(micro, rate);
    const input = price(pricing?.input);
    const output = price(pricing?.output);
    const cacheRead = cachePrice(pricing?.cache_read);
    const cacheWrite = cachePrice(pricing?.cache_write);
    // A price the feed does not publish is not `$0`: writing zero there would publish a fake
    // free tier, which is the drift this module exists to remove. `[cost]` is omitted instead
    // and the lab entry's own cost stands.
    const cost =
      input === undefined || output === undefined
        ? undefined
        : {
            input,
            output,
            ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
            ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
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
      ...(cost === undefined ? {} : { cost }),
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
        // Hand-authored fields the feed is not authoritative for.
        status: deltas?.status,
        interleaved: deltas?.interleaved,
        ...(deltas?.cost?.tiers === undefined
          ? {}
          : { cost: { ...host.cost, tiers: deltas.cost.tiers } }),
      },
      // The narrowed limit is what lets `factorBaseModel` record that `limit.input` must not be
      // inherited from the lab entry now that `limit.context` no longer matches it.
      narrows ? { context: advertised } : undefined,
      deltas?.base_model_omit,
    ) as SyncedModel;

    return { id: model.id, model: built, header: fileHeader(built, rate) };
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
