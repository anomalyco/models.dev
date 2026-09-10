import path from "node:path";

import { z } from "zod";

import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://aihubmix.com/api/v1/models?type=llm";

/** AIHubMix quotes USD per 1M tokens directly, matching the catalog unit. */
const Pricing = z
  .object({
    input: z.number().nullish(),
    output: z.number().nullish(),
    cache_read: z.number().nullish(),
    cache_write: z.number().nullish(),
    tiers: z
      .array(
        z
          .object({
            tier: z.object({
              type: z.string().nullish(),
              size: z.number(),
            }),
            input: z.number().nullish(),
            output: z.number().nullish(),
            cache_read: z.number().nullish(),
            cache_write: z.number().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

/**
 * AIHubMix ships `default` alongside `type`/`values`, which the catalog's strict
 * ReasoningOption rejects, so the extra key is dropped during translation.
 */
const ReasoningOption = z
  .object({
    type: z.string(),
    values: z.array(z.string()).nullish(),
  })
  .passthrough();

export const AihubmixModel = z
  .object({
    model_id: z.string().min(1),
    model_name: z.string().nullish(),
    developer_id: z.number().nullish(),
    desc: z.string().nullish(),
    pricing: Pricing.nullish(),
    features: z.string().nullish(),
    input_modalities: z.string().nullish(),
    output_modalities: z.string().nullish(),
    context_length: z.number().nullish(),
    max_output: z.number().nullish(),
    reasoning: z.boolean().nullish(),
    reasoning_options: z.array(ReasoningOption).nullish(),
    tool_call: z.boolean().nullish(),
    release_date: z.string().nullish(),
    last_updated: z.string().nullish(),
    // Not served yet; read opportunistically so creates unblock without a code
    // change once AIHubMix adds them.
    knowledge: z.string().nullish(),
    open_weights: z.boolean().nullish(),
    retire_stage: z.string().nullish(),
  })
  .passthrough();

export const AihubmixResponse = z
  .object({
    success: z.boolean().nullish(),
    data: z.array(AihubmixModel).min(1),
  })
  .passthrough();

export type AihubmixModel = z.infer<typeof AihubmixModel>;

/**
 * AIHubMix relays upstream models under its own IDs, so a relay is factored onto
 * the lab metadata it serves whenever that metadata exists — the relay then only
 * records what it actually changes (price, reasoning controls, limits).
 *
 * `developer_id` is AIHubMix's own lab identifier and is the only reliable way
 * back to a catalog namespace: relay IDs carry routing prefixes (`coding-`,
 * `alicloud-`) and suffixes (`-free`, `-think`, `-nothink`) that are AIHubMix
 * routing modes rather than distinct upstream models.
 */
const LAB_BY_DEVELOPER: Record<number, string> = {
  2: "anthropic",
  3: "microsoft",
  4: "bytedance-seed",
  5: "zhipuai",
  6: "cohere",
  7: "deepseek",
  8: "google",
  9: "xai",
  10: "mistral",
  11: "meta",
  12: "openai",
  13: "alibaba",
  15: "moonshotai",
  16: "stepfun",
  17: "nvidia",
  18: "minimax",
  24: "tencent",
  28: "meituan",
  29: "inclusionai",
  31: "xiaomi",
  44: "upstage",
};

/** Routing prefixes and suffixes that select a mode, not a different model. */
const ROUTING_PREFIXES = [
  "coding-", "alicloud-", "deep-", "zai-", "anthropic-", "xiaomi-", "openai-", "nvidia-", "bai-",
];
const ROUTING_SUFFIXES = [
  "-free", "-think", "-nothink", "-search", "-preview", "-disc", "-exp", "-highspeed", "-fast",
  "-latest",
];

/** Catalog effort levels; AIHubMix spells two of them differently. */
const EFFORT_ALIASES: Record<string, string> = { no_think: "none", instant: "minimal" };
const EFFORT_VALUES = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
]);

type LabMetadataIDs = Map<string, string>;

let labMetadataIDs: LabMetadataIDs | undefined;

/**
 * The catalog rejects a `base_model` that resolves to nothing, so relays are
 * only factored onto metadata that is actually present on disk.
 */
async function readLabMetadataIDs(modelsDir: string) {
  const metadataDir = path.join(path.dirname(path.dirname(path.dirname(modelsDir))), "models");
  const ids = new Map<string, string>();
  for await (const file of new Bun.Glob("**/*.toml").scan({ cwd: metadataDir, followSymlinks: true })) {
    const id = file.split(path.sep).join("/").slice(0, -5);
    // AIHubMix lowercases every relay ID while labs keep their own casing
    // (`minimax-m2` against `minimax/MiniMax-M2`), so lookups are case-folded.
    ids.set(id.toLowerCase(), id);
  }
  return ids;
}

export const aihubmix = {
  id: "aihubmix",
  name: "AIHubMix",
  modelsDir: "providers/aihubmix/models",
  trackMissingModels: true,
  // Routing aliases such as `alicloud-glm-5.1` are served but unlisted, so a
  // local file absent from the response is retained rather than deleted.
  deleteMissing: false,
  sourceID(model) {
    return model.retire_stage === "deprecated" ? undefined : model.model_id;
  },
  missingNotice(paths) {
    return paths.map(
      (file) =>
        `AIHubMix no longer lists ${file}; confirm it is still a served routing alias or deprecate it.`,
    );
  },
  skippedNotice(ids) {
    return ids.map(
      (id) =>
        `AIHubMix lists ${id} but the response carries neither a resolvable base model nor the release_date/open_weights a standalone entry needs.`,
    );
  },
  async fetchModels() {
    labMetadataIDs = await readLabMetadataIDs(this.modelsDir);
    const response = await fetch(process.env.AIHUBMIX_MODELS_URL ?? API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`AIHubMix models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return AihubmixResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.model_id);
    const built = buildAihubmixModel(model, existing, labMetadataIDs);
    if (built === undefined) return undefined;
    return { id: model.model_id, model: built };
  },
} satisfies SyncProvider<AihubmixModel>;

export function buildAihubmixModel(
  model: AihubmixModel,
  existing: ExistingModel | undefined,
  labIDs: LabMetadataIDs | undefined = labMetadataIDs,
): SyncedModel | undefined {
  const input = modalities(model.input_modalities, existing?.modalities?.input ?? ["text"]);
  const output = modalities(model.output_modalities, existing?.modalities?.output ?? ["text"]);
  const features = new Set((model.features ?? "").split(",").map((value) => value.trim()));
  const reasoning = model.reasoning ?? existing?.reasoning ?? false;
  const toolCall = model.tool_call ?? existing?.tool_call ?? false;
  const structuredOutput = features.has("structured_outputs") || existing?.structured_output;
  const name = model.model_name ?? existing?.name;
  const context = tokens(model.context_length);
  // AIHubMix backfills an unknown `max_output` from `context_length`, so a value
  // equal to the window is read as absent the same way a 0 is — 51 of 415 models
  // quote the two as equal, and a model whose output ceiling really is its whole
  // context window leaves no room for the prompt.
  const quoted = tokens(model.max_output);
  // Two ways AIHubMix signals an unknown output ceiling: backfilling it from
  // `context_length` (51 of 415 models quote the two as equal, which would leave
  // no room for the prompt) and quoting a value above the window (6 models, up to
  // 10x). Both are read as absent, the same as the 0 the endpoint also uses.
  const maxOutput =
    context !== undefined && quoted !== undefined && quoted >= context ? undefined : quoted;
  const limit = {
    context: context ?? existing?.limit?.context,
    output: maxOutput ?? existing?.limit?.output,
  };
  const shared = {
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions(model) ?? existing?.reasoning_options,
    tool_call: toolCall,
    structured_output: structuredOutput,
    // AIHubMix serves no temperature or interleaved flags; keep what was authored.
    temperature: existing?.temperature,
    interleaved: existing?.interleaved,
    status: model.retire_stage === "deprecated" ? ("deprecated" as const) : existing?.status,
    modalities: { input, output },
    limit,
    cost: buildCost(model.pricing, existing?.cost),
  };

  const base = existing?.base_model ?? resolveBaseModel(model, labIDs);
  if (base !== undefined) {
    return factorBaseModel(
      base,
      { name: existing?.name, description: existing?.description, ...shared },
      limit,
      existing?.base_model === base ? existing.base_model_omit : undefined,
    );
  }

  // A standalone entry must carry every required catalog field itself. AIHubMix
  // dates only 52 of its 415 models and serves no open_weights flag, so a relay
  // with neither metadata to inherit nor those fields is reported rather than
  // written with invented values.
  const releaseDate = model.release_date ?? existing?.release_date;
  const openWeights = model.open_weights ?? existing?.open_weights;
  if (name === undefined || releaseDate === undefined || openWeights === undefined) {
    return existing === undefined ? undefined : (existing as SyncedModel);
  }

  return {
    ...shared,
    name,
    description:
      existing?.description ??
      model.desc ??
      describeModel({
        id: model.model_id,
        providerId: "aihubmix",
        name,
        reasoning,
        tool_call: toolCall,
        structured_output: structuredOutput,
        open_weights: openWeights,
        limit,
        modalities: { input, output },
      }),
    family: existing?.family,
    release_date: releaseDate,
    last_updated: model.last_updated ?? model.release_date ?? existing?.last_updated ?? releaseDate,
    knowledge: model.knowledge ?? existing?.knowledge,
    open_weights: openWeights,
  } as SyncedFullModel;
}

function resolveBaseModel(model: AihubmixModel, labIDs: LabMetadataIDs | undefined) {
  const lab = LAB_BY_DEVELOPER[model.developer_id ?? -1];
  if (lab === undefined || labIDs === undefined) return undefined;
  for (const candidate of baseCandidates(model.model_id)) {
    const id = labIDs.get(`${lab}/${candidate}`.toLowerCase());
    if (id !== undefined) return id;
  }
  return undefined;
}

/** Longest match first: strip routing prefixes, then routing suffixes. */
function baseCandidates(modelID: string) {
  const bare = modelID.split("/").at(-1) ?? modelID;
  const candidates = new Set([bare]);
  for (const prefix of ROUTING_PREFIXES) {
    if (bare.toLowerCase().startsWith(prefix)) candidates.add(bare.slice(prefix.length));
  }
  for (const suffix of ROUTING_SUFFIXES) {
    for (const candidate of [...candidates]) {
      if (candidate.toLowerCase().endsWith(suffix)) {
        candidates.add(candidate.slice(0, -suffix.length));
      }
    }
  }
  return candidates;
}

function reasoningOptions(model: AihubmixModel): SyncedFullModel["reasoning_options"] {
  if (model.reasoning_options == null) return undefined;
  const options = model.reasoning_options.flatMap((option) => {
    if (option.type === "toggle" || option.type === "budget_tokens") {
      return [{ type: option.type }];
    }
    if (option.type !== "effort") return [];
    const values = (option.values ?? [])
      .map((value) => EFFORT_ALIASES[value] ?? value)
      .filter((value) => EFFORT_VALUES.has(value));
    return values.length > 0 ? [{ type: "effort" as const, values }] : [];
  });
  return options.length > 0 ? (options as SyncedFullModel["reasoning_options"]) : undefined;
}

function modalities(value: string | null | undefined, fallback: string[]) {
  const parsed = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => ["text", "audio", "image", "video", "pdf"].includes(entry));
  return (parsed.length > 0 ? parsed : fallback) as SyncedFullModel["modalities"]["input"];
}

/**
 * AIHubMix omits a price field when the model has no such rate, so an omitted
 * field means "not offered" and an authored value is only kept when the
 * endpoint quotes nothing at all for the model.
 */
function buildCost(
  pricing: AihubmixModel["pricing"],
  authored: ExistingModel["cost"],
): SyncedFullModel["cost"] {
  if (pricing == null) return authored;
  const input = price(pricing.input);
  const output = price(pricing.output);
  if (input === undefined || output === undefined) return authored;

  return {
    input,
    output,
    cache_read: price(pricing.cache_read),
    cache_write: price(pricing.cache_write),
    tiers: costTiers(pricing) ?? authored?.tiers,
  };
}

function costTiers(pricing: NonNullable<AihubmixModel["pricing"]>) {
  const tiers = (pricing.tiers ?? []).flatMap((tier) => {
    const input = price(tier.input);
    const output = price(tier.output);
    if (input === undefined || output === undefined) return [];
    return [
      {
        tier: { type: tier.tier.type ?? "context", size: tier.tier.size },
        input,
        output,
        cache_read: price(tier.cache_read),
        cache_write: price(tier.cache_write),
      },
    ];
  });
  return tiers.length > 0 ? (tiers as NonNullable<SyncedFullModel["cost"]>["tiers"]) : undefined;
}

/**
 * AIHubMix sends 0 for a limit it does not know rather than omitting the field —
 * 102 of 415 models quote `max_output: 0` — so 0 is read as absent. A model that
 * truly emitted no tokens would not be servable.
 */
function tokens(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function price(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1_000_000) / 1_000_000;
}
