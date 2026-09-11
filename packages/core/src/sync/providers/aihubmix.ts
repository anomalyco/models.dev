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
    // The upstream lab that built the model, and the AIHubMix ID this entry is a
    // routing variant of. Both are served by the catalog itself, so neither the
    // lab nor the variant relationship is inferred from the relay ID here.
    vendor: z.string().nullish(),
    variant_of: z.string().nullish(),
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
    // `knowledge` is not served yet; read opportunistically so it lands without a
    // code change once AIHubMix adds it.
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
 * The catalog answers both halves of that lookup itself: `vendor` names the lab
 * that built the model, and `variant_of` names the AIHubMix ID this entry is a
 * routing variant of. Relay IDs carry prefixes (`coding-`, `alicloud-`) and
 * suffixes (`-free`, `-think`) that are AIHubMix routing modes rather than
 * distinct upstream models, and `variant_of` states that relationship instead of
 * it being guessed from the string — which also resolves the relays no amount of
 * string surgery reaches, such as `ox-alpha` onto `zhipuai/glm-5.3-flash`.
 */
const VENDOR_LABS: Record<string, string> = {
  // The two registries spell four labs differently. This maps namespaces, not
  // models: no entry here decides what any model is or which lab built it.
  zhipu: "zhipuai",
  moonshot: "moonshotai",
  bytedance: "bytedance-seed",
  "meituan-longcat": "meituan",
};

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
/** Every listed relay by lowercased ID, so `variant_of` can be followed. */
type RelayCatalog = Map<string, AihubmixModel>;

let labMetadataIDs: LabMetadataIDs | undefined;
let relayCatalog: RelayCatalog | undefined;

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

// The same off state is reachable from whichever dialect the caller speaks, so
// the toggle has no single wire path. Name one per protocol.
const TOGGLE_HEADER =
  '# Toggle: $.enable_thinking = true|false on the OpenAI-compatible /v1/chat/completions path (verified live 2026-09-11);\n' +
  '# $.thinking.type = "enabled"|"disabled"|"adaptive" on /v1/messages; $.generationConfig.thinkingConfig on the Gemini path.\n' +
  "# https://docs.aihubmix.com/cn/api/unified-inference\n";

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
        `AIHubMix lists ${id} but the response carries neither a vendor/variant_of that resolves to lab metadata nor the release_date/open_weights/limits a standalone entry needs.`,
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
    const data = AihubmixResponse.parse(raw).data;
    // `cc-minimax-m2` and `cc-MiniMax-M2` are the same route under two spellings
    // and would claim filenames that differ only in case. Keep the last entry
    // whole rather than mixing two records.
    relayCatalog = new Map(data.map((model) => [model.model_id.toLowerCase(), model]));
    return [...relayCatalog.values()];
  },
  translateModel(model, context) {
    const existing = context.existing(model.model_id);
    const built = buildAihubmixModel(model, existing, labMetadataIDs, relayCatalog);
    if (built === undefined) return undefined;
    return {
      id: model.model_id,
      model: built,
      // A rewrite drops whatever header the file carried, so re-author it here
      // or the wire path is lost on the first sync that touches the model.
      header: built.reasoning_options?.some((option) => option.type === "toggle") ? TOGGLE_HEADER : undefined,
    };
  },
} satisfies SyncProvider<AihubmixModel>;

export function buildAihubmixModel(
  model: AihubmixModel,
  existing: ExistingModel | undefined,
  labIDs: LabMetadataIDs | undefined = labMetadataIDs,
  catalog: RelayCatalog | undefined = relayCatalog,
): SyncedModel | undefined {
  const input = modalities(model.input_modalities, existing?.modalities?.input ?? ["text"]);
  const output = modalities(model.output_modalities, existing?.modalities?.output ?? ["text"]);
  const features = new Set((model.features ?? "").split(",").map((value) => value.trim()));
  const reasoning = model.reasoning ?? existing?.reasoning ?? false;
  const toolCall = model.tool_call ?? existing?.tool_call ?? false;
  const structuredOutput = features.has("structured_outputs") || existing?.structured_output;
  const name = model.model_name ?? existing?.name;
  const context = tokens(model.context_length);
  // Two ways AIHubMix signals an unknown output ceiling: backfilling it from
  // `context_length` (36 of 408 models quote the two as equal, which would leave
  // no room for the prompt) and quoting a value above the window. Both are read
  // as absent, the same as the 0 the endpoint also uses.
  const quoted = tokens(model.max_output);
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

  const base = existing?.base_model ?? resolveBaseModel(model, labIDs, catalog);
  if (base !== undefined) {
    return factorBaseModel(
      base,
      { name: existing?.name, description: existing?.description, ...shared },
      limit,
      existing?.base_model === base ? existing.base_model_omit : undefined,
    );
  }

  // A standalone entry must carry every required catalog field itself, and the
  // endpoint still leaves gaps: 304 of 408 models are dated, 289 state
  // `open_weights`, and the rest quote 0 for a limit they do not know. A relay
  // with neither metadata to inherit nor those fields is reported rather than
  // written with invented values.
  const releaseDate = model.release_date ?? existing?.release_date;
  const openWeights = model.open_weights ?? existing?.open_weights;
  if (
    name === undefined ||
    releaseDate === undefined ||
    openWeights === undefined ||
    limit.context === undefined ||
    limit.output === undefined
  ) {
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

function resolveBaseModel(
  model: AihubmixModel,
  labIDs: LabMetadataIDs | undefined,
  catalog: RelayCatalog | undefined,
) {
  const vendor = model.vendor;
  if (vendor == null || labIDs === undefined) return undefined;
  const lab = VENDOR_LABS[vendor] ?? vendor;
  for (const candidate of relayChain(model, catalog)) {
    const id = labIDs.get(`${lab}/${candidate}`.toLowerCase());
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * The relay's own ID first, then one `variant_of` hop at a time toward the
 * canonical entry. Nearest first matters: `qwen3.8-max-preview` is a variant of
 * `qwen3.8-max` and both are published lab models, so the relay must factor onto
 * the preview it actually serves rather than onto the root of its chain.
 */
function relayChain(model: AihubmixModel, catalog: RelayCatalog | undefined) {
  const chain = [bareID(model.model_id)];
  const seen = new Set(chain);
  let current: AihubmixModel | undefined = model;
  while (current?.variant_of != null) {
    const parent = bareID(current.variant_of);
    if (seen.has(parent)) break;
    seen.add(parent);
    chain.push(parent);
    current = catalog?.get(current.variant_of.toLowerCase());
  }
  return chain;
}

function bareID(modelID: string) {
  return modelID.split("/").at(-1) ?? modelID;
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
 * 104 of 408 models quote `max_output: 0` — so 0 is read as absent. A model that
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
