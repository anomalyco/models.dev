import { readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ModelFamily } from "../../family.js";
import { ReasoningOption as CatalogReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// ai&'s /v1/api.json publishes this repo's shape directly; the `aiand` key is
// the attributable provider entry and lists only schema-complete models, so
// translation is near-identity. Reference:
// https://api.aiand.com/v1/api.json
const API_ENDPOINT = process.env.AIAND_API_URL ?? "https://api.aiand.com/v1/api.json";

const MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;

const GATEWAY_INTERLEAVED = { field: "reasoning_content" } as const;
const INTERLEAVED_FIELDS = ["reasoning_content", "reasoning_details"] as const;
type Modality = (typeof MODALITIES)[number];

// The feed publishes the catalog's reasoning_options shape. Effort values are
// parsed leniently (any string) so a vocabulary the schema doesn't know yet
// is filtered per value instead of aborting the whole feed parse; toggle and
// budget_tokens controls take the shared catalog schema as-is.
const FeedReasoningOption = z.union([
  z.object({ type: z.literal("effort"), values: z.array(z.string()) }).passthrough(),
  CatalogReasoningOption,
]);

export const AiandModel = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    family: z.string().optional(),
    release_date: z.string(),
    last_updated: z.string().optional(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    reasoning_options: z.array(FeedReasoningOption).optional(),
    temperature: z.boolean(),
    tool_call: z.boolean(),
    structured_output: z.boolean().optional(),
    cost: z
      .object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cache_read: z.number().nonnegative().optional(),
      })
      .passthrough(),
    limit: z
      .object({
        context: z.number().int().positive(),
        output: z.number().int().positive(),
      })
      .passthrough(),
    modalities: z
      .object({
        input: z.array(z.string()),
        output: z.array(z.string()),
      })
      .passthrough(),
    open_weights: z.boolean().optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    interleaved: z.union([z.boolean(), z.object({ field: z.string() }).passthrough()]).optional(),
  })
  .passthrough();

export const AiandResponse = z
  .object({
    aiand: z.object({ models: z.record(AiandModel) }).passthrough(),
  })
  .passthrough();

export type AiandModel = z.infer<typeof AiandModel>;

export const aiand = {
  id: "aiand",
  name: "ai&",
  modelsDir: "providers/aiand/models",
  // Factoring is explicit (factorBaseModel) so files stay override-only; the
  // runner's default preservation keeps the base_model reference but does not
  // drop fields identical to the base.
  preserveBaseModels: false,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`ai& catalog request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const models = Object.values(AiandResponse.parse(raw).aiand.models);
    // deleteMissing runs at the runner default: an empty or truncated feed
    // must fail loudly here rather than read as "delete the local catalog".
    if (models.length === 0) {
      throw new Error("ai& catalog returned no models; refusing an empty feed as authoritative");
    }
    return models;
  },
  translateModel(model, context) {
    // `authored` is the raw TOML — the only thing that can carry a genuine
    // override. `existing` is the base-resolved merge and would make inherited
    // lab values look hand-written.
    const authored = context.authored(model.id);
    const baseModel = authored?.base_model ?? resolveAiandBaseModel(model.id, model.name);
    // A new feed model with no resolvable lab entry must never be written as
    // an unfactored full definition; it goes to the missing-model issue flow
    // instead. An existing local file is always translated — skipping one
    // would delete it.
    if (authored === undefined && baseModel === undefined) return undefined;
    return {
      id: model.id,
      model: buildAiandModel(model, authored, baseModel),
    };
  },
  sourceID(model) {
    return model.id;
  },
  // The only skip is "no lab base yet", never an intentional removal, so every
  // skip enters the missing-model issue flow: the runner keeps any existing
  // local entry and opens one deduped issue for the lab metadata.
  missingModelID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `Skipped ${ids.length} feed model(s) with no resolvable base model (missing-model issue flow): ${ids.join(", ")}`,
    ];
  },
} satisfies SyncProvider<AiandModel>;

type HostFields = Omit<
  SyncedFullModel,
  "name" | "description" | "family" | "release_date" | "last_updated" | "knowledge" | "open_weights"
>;

/**
 * `authored` is the provider TOML as written (not base-resolved). Host facts —
 * pricing, limits, controls, capability flags, modalities, status, the side
 * channel — are feed-authoritative. Lab-owned facts are never asserted from
 * the gateway on a factored file: they appear only as deltas the authored
 * file already carried on top of its base_model, so a full-inline file being
 * factored for the first time (or a brand-new file) inherits the lab entry
 * outright instead of re-emitting the lab's values as overrides.
 */
export function buildAiandModel(
  model: AiandModel,
  authored: ExistingModel | undefined,
  baseModel: string | null | undefined = authored?.base_model ?? resolveAiandBaseModel(model.id, model.name),
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const limit = {
    context: model.limit.context,
    input: authored?.limit?.input,
    output: model.limit.output,
  };
  const host: HostFields = {
    attachment: model.attachment,
    reasoning: model.reasoning,
    // The schema refuses reasoning_options on a non-reasoner; a non-reasoning
    // feed model must not stall the sync on that refine.
    reasoning_options: model.reasoning ? resolveReasoningOptions(model, authored) : undefined,
    tool_call: model.tool_call,
    structured_output: model.structured_output,
    temperature: model.temperature,
    // Canonical order so a feed-side reordering never churns a TOML.
    modalities: {
      input: sortModalities(model.modalities.input.filter(isModality)),
      output: sortModalities(model.modalities.output.filter(isModality)),
    },
    limit,
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      reasoning: authored?.cost?.reasoning,
      cache_read: model.cost.cache_read,
      cache_write: authored?.cost?.cache_write,
      input_audio: authored?.cost?.input_audio,
      output_audio: authored?.cost?.output_audio,
      tiers: authored?.cost?.tiers,
    },
    // Absence means active on the feed, and the feed owns deprecation: a
    // curated alpha/beta survives omission, a curated deprecated does not,
    // or a route the gateway reactivated would stay marked retired forever.
    status: model.status ?? (authored?.status === "deprecated" ? undefined : authored?.status),
    // Every ai& reasoner streams its thinking in message.reasoning_content —
    // a gateway-wide side channel — so a brand-new reasoner gets it even
    // before the feed publishes `interleaved` itself.
    interleaved: model.reasoning
      ? (normalizeInterleaved(model.interleaved) ?? authored?.interleaved ?? GATEWAY_INTERLEAVED)
      : undefined,
  };

  if (baseModel != null) {
    // Only a file that already sat on this base can carry genuine lab-field
    // deltas; anything else inherits the lab entry.
    const deltas = authored?.base_model === baseModel ? authored : undefined;
    return factorBaseModel(
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
      limit,
      deltas?.base_model_omit,
    );
  }

  // Standalone (no lab entry anywhere): curated values win for lab-owned
  // fields, the feed fills the rest. Unknown families degrade to the curated
  // value rather than fail validation.
  const family = ModelFamily.safeParse(model.family);
  return {
    ...host,
    name: authored?.name ?? model.name,
    description: authored?.description ?? model.description ?? model.name,
    family: family.success ? family.data : authored?.family,
    // Release dates are lab metadata the gateway is not authoritative for.
    release_date: authored?.release_date ?? model.release_date,
    // The feed's last_updated tracks catalog-row edits, not model revisions.
    last_updated: authored?.last_updated ?? model.last_updated ?? today,
    knowledge: authored?.knowledge,
    open_weights: model.open_weights ?? authored?.open_weights ?? false,
  };
}

interface MetadataEntry {
  id: string;
  normalizedFull: string;
  normalizedFilename: string;
}

let metadataEntries: MetadataEntry[] | undefined;

/**
 * ai& publishes lab-prefixed ids ("deepseek-ai/deepseek-v4-flash") whose lab
 * segment can differ from the models/ directory ("deepseek/…"), so new ids
 * resolve like Venice's: a unique normalized match on the full id first, then
 * on the filename alone.
 */
export function resolveAiandBaseModel(id: string, name: string): string | undefined {
  const entries = getMetadataEntries();
  for (const candidate of [...new Set([id, name])]) {
    const normalizedFull = normalize(candidate);
    const normalizedFilename = normalize(candidate.split("/").pop() ?? candidate);
    const ranked = [
      entries.filter((entry) => entry.normalizedFull === normalizedFull),
      entries.filter((entry) => entry.normalizedFilename === normalizedFilename),
    ];
    const match = ranked.find((matches) => matches.length === 1)?.[0]?.id;
    if (match !== undefined) return match;
  }
  return undefined;
}

function getMetadataEntries() {
  if (metadataEntries !== undefined) return metadataEntries;
  metadataEntries = [];
  for (const provider of readdirSync(MODELS_DIR, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    for (const file of readdirSync(path.join(MODELS_DIR, provider.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".toml")) continue;
      const filename = file.name.slice(0, -5);
      metadataEntries.push({
        id: `${provider.name}/${filename}`,
        normalizedFull: normalize(`${provider.name}/${filename}`),
        normalizedFilename: normalize(filename),
      });
    }
  }
  return metadataEntries;
}

function normalize(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

type ReasoningEffortValue = Extract<
  Extract<z.infer<typeof CatalogReasoningOption>, { type: "effort" }>["values"][number],
  string
>;

function isReasoningEffort(value: string): value is ReasoningEffortValue {
  return CatalogReasoningOption.safeParse({ type: "effort", values: [value] }).success;
}

/**
 * Omit, empty, and vocabulary-miss are three different assertions: an omitted
 * feed list asserts nothing (authored options stay), an explicit [] asserts
 * "no caller controls", and a non-empty list whose values the schema doesn't
 * know yet keeps the authored options rather than inventing "no control" and
 * auto-merging it.
 */
function resolveReasoningOptions(
  model: AiandModel,
  authored: ExistingModel | undefined,
): SyncedFullModel["reasoning_options"] {
  if (model.reasoning_options === undefined) return authoredReasoningOptions(authored);
  if (model.reasoning_options.length === 0) return [];
  const feed = model.reasoning_options.flatMap((option) => {
    if (option.type === "effort") {
      const values = option.values.filter(
        (value): value is ReasoningEffortValue => typeof value === "string" && isReasoningEffort(value),
      );
      return values.length > 0 ? [{ type: "effort" as const, values }] : [];
    }
    // toggle / budget_tokens carry no vocabulary to filter; the catalog
    // schema already validated them at parse time.
    return [option];
  });
  return feed.length > 0 ? feed : authoredReasoningOptions(authored);
}

function authoredReasoningOptions(
  authored: ExistingModel | undefined,
): SyncedFullModel["reasoning_options"] {
  const options = (authored?.reasoning_options ?? [])
    .map((option) => CatalogReasoningOption.safeParse(option))
    .flatMap((result) => (result.success ? [result.data] : []));
  return options.length > 0 ? options : undefined;
}

function isModality(value: string): value is Modality {
  return (MODALITIES as readonly string[]).includes(value);
}

function normalizeInterleaved(
  value: AiandModel["interleaved"],
): SyncedFullModel["interleaved"] | undefined {
  if (value === true) return true;
  if (value === undefined || value === false) return undefined;
  const field = value.field;
  return (INTERLEAVED_FIELDS as readonly string[]).includes(field)
    ? { field: field as (typeof INTERLEAVED_FIELDS)[number] }
    : undefined;
}

function sortModalities(values: Modality[]): Modality[] {
  return [...new Set(values)].sort((a, b) => MODALITIES.indexOf(a) - MODALITIES.indexOf(b));
}
