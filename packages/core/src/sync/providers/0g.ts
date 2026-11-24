import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { resolveAiandBaseModel } from "./aiand.js";
import { factorBaseModel, modelMetadata } from "./openrouter.js";

const API_ENDPOINT = "https://router-api.0g.ai/v1/models";

const TOKENS_PER_PRICING_UNIT = 1_000_000;

// The live catalog lists ~100 chat models; anything far below that is a
// truncated response, not a mass retirement.
const MIN_LIVE_CHAT_MODELS = 20;

// Chat models the catalog lists but that do not serve, kept out until they do.
// Each entry names the evidence; remove it once a probe succeeds again.
const NOT_SERVING = new Map<string, string>([
  ["qwen2.5-vl-72b-instruct", "404 bad_response_status_code on chat and image probes, 2026-11-18"],
]);

// A reasoning file created from a catalog `reasoning` block starts with this
// header, and follows the block: the header names no levels or date, so it stays
// true as the block changes, and gives the wire path every toggle needs. Files
// are told apart by its first line alone, so the rest can be reworded; changing
// the first line means changing it in every file that has it.
export const SYNCED_REASONING_MARKER = "# Reasoning controls: synced from the `reasoning` block of GET https://router-api.0g.ai/v1/models";
export const SYNCED_REASONING_HEADER = [
  SYNCED_REASONING_MARKER,
  "# (reasoning_effort measured on every row serving the model).",
  '# Toggle, when listed: reasoning_effort = "none" turns thinking off.',
].join("\n") + "\n";

// Any other reasoning file was authored by hand, from a probe its header cites,
// and a block never rewrites it: an absent level list means "none found to
// work" where a hand probe with a larger budget may have found levels that do,
// and the hand-written header would then contradict the data. A block that
// disagrees is reported until the file's header records that block as reviewed
// with a line `# Reasoning block reviewed: <verified_at>`.
const REVIEWED_BLOCK = /^# Reasoning block reviewed: (\d{4}-\d{2}-\d{2})\b/m;

// Only chat models are in scope. The catalog also lists image, video, speech,
// transcription, embedding and decision models (`type`), skipped silently.
const CHAT_TYPE = "chatbot";

// Per-token USD strings ("0.000004"), not per million. Media models carry
// other keys (per image, per second) and no prompt/completion pair.
const ZeroGPricing = z.object({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  cache_write: z.string().optional(),
  cache_write_1h: z.string().optional(),
}).passthrough();

// The router's measured reasoning_effort behaviour for a model, published only
// once every row serving it was probed and agreed (0g-router param-probe):
// `mandatory` says whether `reasoning_effort: none` fails to turn thinking off;
// `supported_efforts` lists the levels that change how much it thinks, high to
// low, with "none" last when it turns thinking off and another level is listed.
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const ZeroGReasoning = z.object({
  mandatory: z.boolean(),
  supported_efforts: z.array(z.enum(EFFORT_LEVELS))
    .refine((levels) => new Set(levels).size === levels.length, "duplicate levels")
    .optional(),
  verified_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).passthrough();

export type ZeroGReasoning = z.infer<typeof ZeroGReasoning>;

export const ZeroGModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  owned_by: z.string(),
  name: z.string().min(1),
  type: z.string().optional(),
  context_length: z.number().int().positive().optional(),
  pricing_usd: ZeroGPricing.optional(),
  supported_parameters: z.array(z.string()).optional(),
  tee_attested: z.boolean().optional(),
  // Parsed per model (reasoningBlock), so a block the sync cannot read leaves
  // that model's controls as authored instead of failing the whole run.
  reasoning: z.unknown().optional(),
}).passthrough();

export const ZeroGResponse = z.object({
  data: z.array(ZeroGModel),
}).passthrough();

export type ZeroGModel = z.infer<typeof ZeroGModel>;

// A chat row stays in the synced set even when its price is missing or garbled,
// so the published entry is kept rather than deleted as absent (see
// translateModel); only creating a new file needs a price.
function isChat(model: ZeroGModel) {
  return !NOT_SERVING.has(model.id) && model.type === CHAT_TYPE;
}

export const zerog = {
  id: "0g",
  name: "0G Private Computer",
  modelsDir: "providers/0g/models",
  // Only a priced chat row is reported when skipped, so the notice below lists
  // exactly the rows that lack a lab entry; a new row without a price is skipped
  // silently (an existing one keeps its file, see translateModel).
  sourceID(model) {
    return isChat(model) && hasPrice(model) ? model.id : undefined;
  },
  // A priced chat model is skipped only when it has no lab entry to base it on or
  // its lab entry reasons and the catalog publishes no reasoning block for it
  // (MissingReasoningOptionsError); both need hand-authored metadata, so both
  // open a deduped missing-model issue. A new row without a
  // price is skipped without one: there is nothing to publish until it has one.
  missingModelID(model) {
    return isChat(model) && hasPrice(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} 0G chat models have no lab entry under models/ to base them on: `
        + ids.map((id) => `\`${id}\``).join(", "),
    ];
  },
  async fetchModels() {
    return fetchZeroGModels();
  },
  parseModels(raw) {
    return ZeroGResponse.parse(raw).data.filter(isChat);
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return createZeroGModel(model);
    // A price the catalog garbles or leaves out keeps the published entry rather
    // than aborting the run or deleting a route that is still served.
    if (!hasPrice(model)) {
      const authored = context.authored(model.id);
      return authored === undefined ? undefined : { id: model.id, model: authored as SyncedModel };
    }
    const v2Set = cacheWriteByTtl(model, context.v2?.(model.id));
    const { controls, notices } = existingControls(model, existing, context.authored(model.id), context.header?.(model.id));
    return {
      id: model.id,
      model: buildZeroGModel(model, existing, controls),
      ...(v2Set === undefined ? {} : { v2Set }),
      ...(notices.length === 0 ? {} : { notices }),
    };
  },
} satisfies SyncProvider<ZeroGModel>;

export async function fetchZeroGModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`0G models request failed: ${response.status} ${response.statusText}`);
  }
  const parsed = ZeroGResponse.parse(await response.json());
  const chat = parsed.data.filter(isChat).length;
  if (chat < MIN_LIVE_CHAT_MODELS) {
    throw new Error(
      `0G returned ${chat} chat models, below the ${MIN_LIVE_CHAT_MODELS} needed to`
        + ` distinguish a retirement from a truncated response`,
    );
  }
  return parsed;
}

// New models are created as base_model overlays carrying only cost; the rest
// (limits, modalities, tools, dates) is inherited from the lab entry. The
// catalog's ids are bare ("claude-opus-5.5"), so the lab entry is found by a
// unique normalized match. A model whose lab entry reasons also takes its
// reasoning controls from the catalog's `reasoning` block; without one it is
// not created and opens an issue for its controls to be authored by hand.
export function createZeroGModel(model: ZeroGModel) {
  if (!isChat(model) || !hasPrice(model)) return undefined;
  const baseModel = resolveAiandBaseModel(model.id, model.name);
  if (baseModel === undefined) return undefined;
  if (modelMetadata(baseModel).reasoning !== true) {
    return {
      id: model.id,
      model: { base_model: baseModel, cost: cost(model) } as SyncedModel,
    };
  }
  const block = reasoningBlock(model);
  if (block === undefined) {
    throw new MissingReasoningOptionsError(
      model.id,
      `reasoning model (base ${baseModel}) that 0G's /v1/models publishes no`
        + (model.reasoning === undefined ? "" : " readable")
        + " reasoning block for; probe the route and author its reasoning controls by hand",
    );
  }
  // AGENTS.md asks every GPT-5+ file for evidence of its custom-tool (freeform)
  // support, which the catalog does not carry.
  const gpt = /^openai\/gpt-(\d+)/.exec(baseModel);
  if (gpt !== null && Number(gpt[1]) >= 5) {
    throw new MissingReasoningOptionsError(
      model.id,
      `GPT-5+ model (base ${baseModel}): probe and note its freeform custom-tool support, then author it by hand`,
    );
  }
  return {
    id: model.id,
    model: { base_model: baseModel, cost: cost(model), reasoning_options: reasoningOptions(block) } as SyncedModel,
    header: SYNCED_REASONING_HEADER,
  };
}

export function reasoningBlock(model: ZeroGModel): ZeroGReasoning | undefined {
  if (model.reasoning === undefined) return undefined;
  const parsed = ZeroGReasoning.safeParse(model.reasoning);
  return parsed.success ? parsed.data : undefined;
}

type ReasoningOptions = NonNullable<SyncedFullModel["reasoning_options"]>;

function effortRank(value: string) {
  return EFFORT_LEVELS.indexOf(value as (typeof EFFORT_LEVELS)[number]);
}

// The catalog's block as models.dev controls. An effort list holding "none"
// takes no toggle (AGENTS.md, Reasoning controls); a mandatory block with no
// levels is always on with no caller control.
export function reasoningOptions(block: ZeroGReasoning): ReasoningOptions {
  const graded = (block.supported_efforts ?? [])
    .filter((value) => value !== "none")
    .sort((a, b) => effortRank(a) - effortRank(b));
  if (graded.length > 0) return [{ type: "effort", values: block.mandatory ? graded : ["none", ...graded] }];
  return block.mandatory ? [] : [{ type: "toggle" }];
}

// Controls for a file that exists: the block's for a reasoning file created
// from one (its header starts with SYNCED_REASONING_MARKER), none (keep as
// authored) otherwise. A block that cannot be read, or that disagrees with a
// hand-authored file and was not recorded there as reviewed, is reported.
function existingControls(model: ZeroGModel, existing: ExistingModel, authored: ExistingModel | undefined, header = "") {
  const notices: string[] = [];
  if (existing.reasoning !== true || model.reasoning === undefined) return { controls: undefined, notices };
  const block = reasoningBlock(model);
  if (block === undefined) {
    notices.push(`0G model ${model.id} publishes a reasoning block the sync cannot read; its reasoning controls are left as authored`);
    return { controls: undefined, notices };
  }
  const controls = reasoningOptions(block);
  if (header.startsWith(SYNCED_REASONING_MARKER)) return { controls, notices };
  const current = authored?.reasoning_options ?? existing.reasoning_options ?? [];
  if (describe(controls) !== describe(current) && REVIEWED_BLOCK.exec(header)?.[1] !== block.verified_at) {
    notices.push(
      `0G's reasoning block for ${model.id} (${describe(controls)}, verified_at ${block.verified_at}) differs from its`
        + ` hand-authored controls (${describe(current)}); re-probe and update the file by hand, or record the block in`
        + ` its header as \`# Reasoning block reviewed: ${block.verified_at}\``,
    );
  }
  return { controls: undefined, notices };
}

// A budget is left out: the block covers reasoning_effort only, so it never has one.
function describe(options: ReasoningOptions) {
  const parts = options
    .filter((option) => option.type !== "budget_tokens")
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((option) => (option.type === "effort" ? `effort ${option.values.join("|")}` : option.type));
  return parts.length === 0 ? "no caller control" : parts.join(", ");
}

// The catalog returns per-token strings; scaling them introduces float
// artifacts, so every published price is rounded.
function perMillion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 ? Number((parsed * TOKENS_PER_PRICING_UNIT).toFixed(6)) : undefined;
}

function hasPrice(model: ZeroGModel) {
  return perMillion(model.pricing_usd?.prompt) !== undefined
    && perMillion(model.pricing_usd?.completion) !== undefined;
}

function cost(model: ZeroGModel, current?: ExistingModel["cost"]) {
  const input = perMillion(model.pricing_usd?.prompt);
  const output = perMillion(model.pricing_usd?.completion);
  if (input === undefined || output === undefined) {
    throw new Error(`0G model ${model.id} has no parseable prompt/completion price`);
  }
  // `cache_write` is the default (5-minute) write price; the 1-hour price has no
  // v1 field and is published through v2 by cacheWriteByTtl.
  const cacheWrite = perMillion(model.pricing_usd?.cache_write);
  return {
    ...current,
    input,
    output,
    ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
  };
}

// The catalog's `cache_write` and `cache_write_1h` are the default and 1-hour
// cache write prices. v2 can hold both, labelled by TTL, but only a file whose
// cache capability lists exactly those TTLs (e.g. ["5m", "1h"], as OpenRouter's
// sync requires) says which label the default price carries; otherwise only the
// v1 default write is published.
function cacheWriteByTtl(model: ZeroGModel, current: Record<string, unknown> | undefined) {
  const write = perMillion(model.pricing_usd?.cache_write);
  const write1h = perMillion(model.pricing_usd?.cache_write_1h);
  if (write === undefined || write1h === undefined) return undefined;
  const ttls = (current?.capabilities as { cache?: { explicit?: { ttl?: unknown } } } | undefined)?.cache?.explicit?.ttl;
  if (!Array.isArray(ttls) || ttls.length !== 2 || ttls[0] === "1h" || ttls[1] !== "1h") return undefined;
  return { "cost.text.input.cache.write": { [ttls[0] as string]: write, "1h": write1h } };
}

// Price comes from the catalog, and reasoning controls from its `reasoning`
// block where it publishes one (controls). 0G relays most of its models, so its
// `context_length` is the upstream's figure rather than a cap 0G imposes, and
// its capability fields describe what the router forwards, not what the model
// does: limits and the other capabilities stay hand-authored.
export function buildZeroGModel(model: ZeroGModel, existing: ExistingModel, controls?: ReasoningOptions): SyncedModel {
  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const values = {
    ...current,
    cost: cost(model, existing.cost),
    ...(controls === undefined ? {} : { reasoning_options: controls }),
  } as SyncedFullModel;
  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, existing.limit, baseModelOmit);
}
