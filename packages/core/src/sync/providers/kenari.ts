import path from "node:path";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import {
  factorBaseModel,
  resolveCanonicalBaseModel,
  resolveModelMetadataBaseModel,
} from "./openrouter.js";

const API_ENDPOINT = "https://kenari.id/v1/models";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Billing happens in the customer's IDR wallet, so a USD figure here would be a
// misleading conversion. Entries exist for capability/limit data only.
const ZERO_COST = { input: 0, output: 0 };

const TOGGLE_HEADER = `# Toggle: $.reasoning.enabled = true|false
`;

export function toggleHeader(model: SyncedModel) {
  return model.reasoning_options?.some((option) => option.type === "toggle")
    ? TOGGLE_HEADER
    : undefined;
}

const EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"] as const;
type EffortValue = (typeof EFFORT_VALUES)[number];
const EFFORT_SET = new Set<string>(EFFORT_VALUES);

// Capability and modality facts come from the canonical base model, never the feed.
export const KenariModel = z.object({
  id: z.string(),
  owned_by: z.string(),
  reasoning: z.boolean().optional(),
  // Plain strings, not an enum: an unknown effort value would otherwise throw
  // and kill the whole hourly sync. Unknown values are dropped when building.
  reasoning_options: z.array(z.string()).optional(),
}).passthrough();

export const KenariResponse = z.object({
  data: z.array(KenariModel),
}).passthrough();

export type KenariModel = z.infer<typeof KenariModel>;

export const kenari = {
  id: "kenari",
  name: "Kenari",
  modelsDir: "providers/kenari/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Kenari request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const models = KenariResponse.parse(raw).data;
    // Claimed by an exact ID match, so the version-stripping fallback cannot
    // hand the same canonical entry to a second host ID.
    exactClaims = new Set(
      models
        .map((model) => resolveExactBaseModel(model))
        .filter((id): id is string => id !== undefined),
    );
    return models;
  },
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `Skipped models with no canonical \`models/\` metadata entry (hand-author these): ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  translateModel(model, context) {
    const translated = buildKenariModel(model, context.existing(model.id));
    if (translated === undefined) return undefined;
    return { id: model.id, model: translated, header: toggleHeader(translated) };
  },
} satisfies SyncProvider<KenariModel>;

// Kenari spells versions with dashes (`glm-5-2`) where canonical IDs use dots
// (`glm-5.2`). Try the raw ID, then the dotted variant.
function baseCandidates(model: KenariModel) {
  return [...new Set([model.id, model.id.replace(/(\d)-(?=\d)/g, "$1.")])];
}

// Exact matches only: the shared resolver, then the bare ID against metadata
// filenames. Both accept a single unambiguous match, so a wrong guess stays a
// skip rather than a bad base_model.
function resolveExactBaseModel(model: KenariModel) {
  const candidates = baseCandidates(model);
  for (const candidate of candidates) {
    const canonical = resolveCanonicalBaseModel(`${model.owned_by}/${candidate}`);
    if (canonical !== undefined) return canonical;
  }
  for (const candidate of candidates) {
    const byMetadata = resolveModelMetadataBaseModel(candidate);
    if (byMetadata !== undefined) return byMetadata;
  }
  return undefined;
}

// Filled by `parseModels`. Empty for a direct call, which keeps the fallback
// usable on a single model.
let exactClaims: ReadonlySet<string> = new Set();

export function resolveKenariBaseModel(
  model: KenariModel,
  claimed: ReadonlySet<string> = exactClaims,
) {
  const exact = resolveExactBaseModel(model);
  if (exact !== undefined) return exact;
  // Last resort: the canonical entry may carry a release version the host's ID
  // drops, e.g. `north-mini-code:free` -> `models/cohere/north-mini-code-1-0`.
  for (const candidate of baseCandidates(model)) {
    const versioned = resolveVersionedCanonicalBaseModel(candidate);
    if (versioned === undefined) continue;
    // Claimed by an exact match elsewhere, so this is a sibling product rather
    // than the same model without its version (`grok-imagine-image` vs
    // `grok-imagine-image-2-0`). Skip instead of giving two hosts one entry.
    if (claimed.has(versioned)) return undefined;
    return versioned;
  }
  return undefined;
}

// Trailing release marker: `-1-0`, `-2512`, `-20241022`. Digits only, so a word
// suffix (`-code`, `-flash`) never counts as a version.
const VERSION_SUFFIX = /^\d[\d.-]*$/;

let versionedIndex: Map<string, string[]> | undefined;

// Index canonical IDs by their version-stripped stem, once per process.
function versionedCanonicalIndex() {
  if (versionedIndex !== undefined) return versionedIndex;
  const index = new Map<string, string[]>();
  let labs: Dirent[];
  try {
    labs = readdirSync(MODELS_DIR, { withFileTypes: true });
  } catch {
    versionedIndex = index;
    return index;
  }
  for (const lab of labs) {
    if (!lab.isDirectory()) continue;
    let files: string[];
    try {
      files = readdirSync(path.join(MODELS_DIR, lab.name));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".toml")) continue;
      const id = file.slice(0, -".toml".length);
      const cut = id.lastIndexOf("-");
      if (cut <= 0) continue;
      if (!VERSION_SUFFIX.test(id.slice(cut + 1))) continue;
      // Fold every trailing version segment: `north-mini-code-1-0` stems to
      // `north-mini-code`, not `north-mini-code-1`.
      let stem = id.slice(0, cut);
      while (true) {
        const next = stem.lastIndexOf("-");
        if (next <= 0 || !VERSION_SUFFIX.test(stem.slice(next + 1))) break;
        stem = stem.slice(0, next);
      }
      const key = stem.toLowerCase();
      const bucket = index.get(key);
      if (bucket === undefined) index.set(key, [`${lab.name}/${id}`]);
      else bucket.push(`${lab.name}/${id}`);
    }
  }
  versionedIndex = index;
  return index;
}

// Only when exactly one versioned entry exists. Stems with siblings
// (`mistral-large`, `gpt-4o`) stay unresolved: picking a release would be a
// guess, and a wrong `base_model` is worse than a visible skip.
function resolveVersionedCanonicalBaseModel(candidate: string) {
  const bare = candidate.replace(/:free$/, "").toLowerCase();
  const matches = versionedCanonicalIndex().get(bare);
  return matches !== undefined && matches.length === 1 ? matches[0] : undefined;
}

// An omitted `reasoning_options` means the endpoint said nothing, not that the
// model has none. Returning `[]` would be an affirmative "no caller control"
// and would wipe hand-authored efforts, since `[]` is not nullish.
function reasoningOptions(
  model: KenariModel,
  existing: ExistingModel | undefined,
): SyncedFullModel["reasoning_options"] {
  if (model.reasoning !== true) return undefined;
  const efforts = model.reasoning_options;
  const values = [...new Set(efforts ?? [])].filter((value): value is EffortValue =>
    EFFORT_SET.has(value)
  );
  // Efforts published but none recognised: keep what is authored rather than
  // guessing the control shape from an unreadable list.
  if (efforts !== undefined && efforts.length > 0 && values.length === 0) return undefined;
  // Every reasoning model here takes the same off switch, so the toggle is
  // authored for all of them rather than left to the effort list.
  const authored = (existing?.reasoning_options ?? []).filter((option) => option.type !== "toggle");
  const carriesNone = (options: typeof authored) =>
    options.some((option) => option.type === "effort" && option.values.includes("none"));
  if (efforts === undefined) {
    return carriesNone(authored) ? authored : [{ type: "toggle" }, ...authored];
  }
  const effort = values.length > 0 ? [{ type: "effort" as const, values }] : [];
  // `none` is already the off switch, so a toggle beside it spells one control twice.
  if (values.includes("none")) return effort;
  const budget = authored.filter((option) => option.type === "budget_tokens");
  return [{ type: "toggle" }, ...budget, ...effort];
}

function canonicalName(baseModelID: string) {
  try {
    const toml = Bun.TOML.parse(
      readFileSync(path.join(MODELS_DIR, `${baseModelID}.toml`), "utf8"),
    ) as { name?: string };
    return toml.name;
  } catch {
    return undefined;
  }
}

function freeName(model: KenariModel, baseModelID: string) {
  if (!model.id.endsWith(":free")) return undefined;
  const base = canonicalName(baseModelID);
  return base !== undefined ? `${base} (Free)` : undefined;
}

export function buildKenariModel(
  model: KenariModel,
  existing: ExistingModel | undefined,
): SyncedModel | undefined {
  // Kenari's context_length is ingested FROM models.dev, so syncing it back
  // would pin a circular copy. Limits inherit from the base model; only
  // hand-authored overrides are preserved.
  const limit = existing?.limit;

  // Resolving here rather than only on the create path migrates an existing
  // full-inline file onto its lab entry once that entry lands.
  const base = existing?.base_model ?? resolveKenariBaseModel(model);

  // Refresh reasoning controls + zero cost, keep every authored override.
  if (existing !== undefined && base !== undefined) {
    return factorBaseModel(
      base,
      {
        name: existing.name,
        description: existing.description,
        attachment: existing.attachment,
        reasoning: existing.reasoning,
        reasoning_options: reasoningOptions(model, existing) ?? existing.reasoning_options,
        temperature: existing.temperature,
        tool_call: existing.tool_call,
        structured_output: existing.structured_output,
        status: existing.status,
        interleaved: existing.interleaved,
        knowledge: existing.knowledge,
        modalities: existing.modalities,
        limit,
        cost: ZERO_COST,
      },
      limit,
      existing.base_model_omit,
    );
  }

  // No canonical entry to factor onto: refresh in place, keep curated metadata.
  if (existing !== undefined) {
    return {
      ...existing,
      reasoning_options: reasoningOptions(model, existing) ?? existing.reasoning_options,
      cost: ZERO_COST,
      limit,
    } as SyncedModel;
  }

  // New model: only create when a canonical entry exists to inherit capability
  // facts from. The endpoint has no name/release-date data, so an unresolvable
  // model is skipped and surfaced in the notice rather than invented.
  if (base === undefined) return undefined;
  return factorBaseModel(
    base,
    {
      name: freeName(model, base),
      reasoning_options: reasoningOptions(model, undefined),
      limit,
      cost: ZERO_COST,
    },
    limit,
  );
}
