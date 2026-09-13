import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

// ========================================
// Constants
// ========================================

const API_ENDPOINT = "https://api.hopscotchlabs.ai/public/models";
const MODELS_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "models",
);
const PROVIDERS_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "providers",
);
/** Hopscotch publishes thousandths of the currency unit per million tokens. */
const THOUSANDTHS_PER_UNIT = 1_000;
/**
 * OpenRouter is the established same-surface relay, so it is the one peer
 * consulted when a lab's own entry documents no reasoning controls. Same
 * choice, and the same reason, as the Eden AI mapper.
 */
const PEER_PROVIDER = "openrouter";
/**
 * The reasoning fields each provider family accepts on Hopscotch's
 * OpenAI-compatible door, read from the gateway's own parameter maps.
 *
 * This host does not relay a request body untouched. Its request builder starts
 * from an empty object and fills it only from keys the serving family's map
 * names; a family with no map for the endpoint is refused outright. There is no
 * passthrough branch and no dynamic config for any family below, so the map is
 * the whole request surface and a field it does not carry never reaches the
 * provider. Each entry is that map, read from the family's own module rather
 * than inferred from the surface label:
 *
 *   anthropic, cohere      `thinking`                      (own map)
 *   google                 `thinking`, `reasoning_effort`  (own map)
 *   openai                 `reasoning_effort`              (own map)
 *   meta, minimax, z-ai    `reasoning_effort`              (inherited whole
 *                                                          from the OpenAI
 *                                                          base map, excluding
 *                                                          nothing)
 *   deepinfra, deepseek,   none: their maps carry no reasoning parameter of
 *   fireworks-ai, moonshot any spelling, so a caller cannot reach one here
 *
 * A family absent from this table publishes no control, which is a statement
 * about the map rather than a gap in it.
 */
const REASONING_FIELDS_BY_FAMILY: Record<
  string,
  readonly ("thinking" | "reasoning_effort")[]
> = {
  anthropic: ["thinking"],
  cohere: ["thinking"],
  google: ["reasoning_effort", "thinking"],
  openai: ["reasoning_effort"],
  meta: ["reasoning_effort"],
  minimax: ["reasoning_effort"],
  "z-ai": ["reasoning_effort"],
};
/**
 * Families whose map carries no reasoning parameter of any spelling, listed
 * with the whole set each one accepts so the claim can be checked rather than
 * taken. These are the complete parameter lists from each family's own
 * `chatComplete.ts` in the gateway, not a search for reasoning-shaped names:
 *
 *   anthropic     max_completion_tokens, max_tokens, messages, model, stop,
 *                 stream, temperature, thinking, tool_choice, tools, top_k,
 *                 top_p, user
 *                 -- no reasoning_effort and no output_config, so an effort
 *                 cannot travel this path whatever the lab calls it
 *   deepinfra     frequency_penalty, max_completion_tokens, max_tokens,
 *                 messages, model, n, presence_penalty, stop, stream,
 *                 stream_options, temperature, tool_choice, tools, top_p
 *   deepseek      frequency_penalty, logprobs, max_completion_tokens,
 *                 max_tokens, messages, model, parallel_tool_calls,
 *                 presence_penalty, response_format, stop, stream,
 *                 stream_options, temperature, tool_choice, tools,
 *                 top_logprobs, top_p
 *   fireworks-ai  context_length_exceeded_behavior, frequency_penalty,
 *                 logprobs, max_completion_tokens, max_tokens, messages,
 *                 model, n, presence_penalty, prompt_truncate_len,
 *                 response_format, stop, stream, stream_options, temperature,
 *                 tools, top_k, top_logprobs, top_p, user
 *   moonshot      max_completion_tokens, max_tokens, messages, model, stream,
 *                 stream_options, temperature, tool_choice, tools, top_p
 *
 * A caller's reasoning field is dropped before the provider sees it, whichever
 * of these four serves the model, because the request is rebuilt from the list
 * above and from nothing else.
 */
const NO_REASONING_CONTROL = new Set([
  "deepinfra",
  "deepseek",
  "fireworks-ai",
  "moonshot",
]);

const baseReasoningByID = new Map<string, boolean>();
let peerOptions: Map<string, ReasoningOptions> | undefined;

type ReasoningOptions = NonNullable<SyncedFullModel["reasoning_options"]>;

// ========================================
// Schemas
// ========================================

const Capability = z.enum(["yes", "no", "unknown"]).catch("unknown");

export const HopscotchModel = z
  .object({
    id: z.string().min(1),
    created: z.number(),
    owned_by: z.string().nullish(),
    uniblock: z
      .object({
        model_id: z.string().min(1),
        author_slug: z.string().nullish(),
        context_window_tokens: z.number().nullish(),
        max_output_tokens: z.number().nullish(),
        input_rate_thousandths: z.number().nullish(),
        output_rate_thousandths: z.number().nullish(),
        cache_read_rate_thousandths: z.number().nullish(),
        cache_write_rate_thousandths: z.number().nullish(),
        endpoint_families: z.array(z.string()).default([]),
        provider_families: z.array(z.string()).default([]),
        deprecated_at: z.union([z.number(), z.string()]).nullish(),
        capabilities: z
          .object({
            tools: Capability.optional(),
            json_mode: Capability.optional(),
            vision: Capability.optional(),
          })
          .passthrough()
          .default({}),
      })
      .passthrough(),
  })
  .passthrough();

export const HopscotchResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(HopscotchModel),
  })
  .passthrough();

export type HopscotchModel = z.infer<typeof HopscotchModel>;

// ========================================
// Util functions
// ========================================

/**
 * Hopscotch IDs are `<serving provider>/<model>`, and the model half keeps the
 * upstream vendor namespace for hosted open-weight models
 * (`deepseek-ai/DeepSeek-V3.2`). Canonical metadata is keyed by the model's
 * author instead, so try the published ID, then the author's namespace, then
 * the bare name, which resolves only when it is unique across the tree.
 */
export function resolveHopscotchBaseModel(
  modelID: string,
  authorSlug: string | null | undefined,
) {
  const tail = modelID.split("/").at(-1) ?? modelID;
  return (
    resolveModelMetadataBaseModel(modelID) ??
    (authorSlug == null
      ? undefined
      : resolveModelMetadataBaseModel(`${authorSlug}/${tail}`)) ??
    resolveModelMetadataBaseModel(tail)
  );
}

/** `"yes"`/`"no"` are proven; `"unknown"` leaves the base model's fact standing. */
function capability(value: string | undefined): boolean | undefined {
  if (value === "yes") return true;
  if (value === "no") return false;
  return undefined;
}

function pricePerMillion(
  thousandths: number | null | undefined,
): number | undefined {
  if (thousandths == null || thousandths <= 0) return undefined;
  return thousandths / THOUSANDTHS_PER_UNIT;
}

/**
 * A cache rate equal to the input rate is published, because it is charged.
 *
 * Hopscotch creates a model's cache rates as a copy of its input rate, and
 * where no distinct rate is ever decided its pricing substitutes that same
 * anchor at settlement. So an equal pair is not a placeholder to be dropped:
 * it is what a caller actually pays for a cache read on that route, and
 * omitting it would let the model's own provider entry supply a cheaper figure
 * and understate this host. It refreshes on the next hourly sync if a real
 * rate is decided.
 */
function cacheRate(rate: number | null | undefined): number | undefined {
  return pricePerMillion(rate);
}

function buildCost(model: HopscotchModel): SyncedModel["cost"] {
  const input = pricePerMillion(model.uniblock.input_rate_thousandths);
  const output = pricePerMillion(model.uniblock.output_rate_thousandths);
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    cache_read: cacheRate(model.uniblock.cache_read_rate_thousandths),
    cache_write: cacheRate(model.uniblock.cache_write_rate_thousandths),
  };
}

/**
 * Whether the canonical model reasons. Hopscotch's own catalog does not publish
 * a reasoning flag, so the base model is the authority.
 */
function baseModelReasons(baseModel: string): boolean {
  let cached = baseReasoningByID.get(baseModel);
  if (cached === undefined) {
    const toml = parseToml(path.join(MODELS_DIR, `${baseModel}.toml`));
    cached = toml?.reasoning === true;
    baseReasoningByID.set(baseModel, cached);
  }
  return cached;
}

function parseToml(filePath: string) {
  try {
    return Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function tomlFilesIn(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) =>
    entry.isDirectory()
      ? tomlFilesIn(path.join(dir, entry.name))
      : entry.name.endsWith(".toml")
        ? [path.join(dir, entry.name)]
        : [],
  );
}

function optionsIn(toml: Record<string, unknown> | undefined) {
  const options = toml?.["reasoning_options"];
  return Array.isArray(options) ? (options as ReasoningOptions) : undefined;
}

function peerOptionsByBaseModel() {
  if (peerOptions !== undefined) return peerOptions;

  peerOptions = new Map();
  for (const file of tomlFilesIn(
    path.join(PROVIDERS_DIR, PEER_PROVIDER, "models"),
  )) {
    const toml = parseToml(file);
    const base = toml?.["base_model"];
    if (typeof base !== "string" || peerOptions.has(base)) continue;
    const options = optionsIn(toml);
    if (options !== undefined) peerOptions.set(base, options);
  }
  return peerOptions;
}

/**
 * The wire path for each control the file publishes, as a leading comment.
 *
 * Sync strips every comment but a leading block, so the paths go at the top.
 * The lines describe only the controls actually written: a file publishing a
 * toggle alone must not advertise a budget field beside it. The object each
 * control lives in differs by family, so the names are keyed rather than
 * assumed: Anthropic's own shape reaches the provider untouched, Google's
 * transform reads the same two keys off it, and Cohere's budget has its own
 * name.
 */
const THINKING_FIELDS_BY_FAMILY: Record<
  string,
  { toggle: string; budget: string }
> = {
  anthropic: {
    toggle: "thinking.type = enabled|disabled",
    budget: "thinking.budget_tokens (integer reasoning tokens)",
  },
  google: {
    toggle: "thinking.type = enabled|disabled",
    budget: "thinking.budget_tokens (integer reasoning tokens)",
  },
  cohere: {
    toggle: "thinking.type = enabled|disabled",
    budget: "thinking.token_budget (integer reasoning tokens)",
  },
};

function headerFor(
  family: string,
  options: ReasoningOptions,
): string | undefined {
  const lines: string[] = [];
  const effort = options.find((option) => option.type === "effort");
  if (effort !== undefined && "values" in effort) {
    lines.push(`# Effort: reasoning_effort = ${effort.values.join("|")}`);
  }
  const fields = THINKING_FIELDS_BY_FAMILY[family];
  if (fields !== undefined) {
    if (options.some((option) => option.type === "toggle")) {
      lines.push(`# Toggle: ${fields.toggle}`);
    }
    if (options.some((option) => option.type === "budget_tokens")) {
      lines.push(`# Budget: ${fields.budget}`);
    }
  }
  if (lines.length === 0) return undefined;
  lines.push("# https://platform.hopscotchlabs.ai/models");
  return lines.join("\n");
}

function carries(
  type: string,
  fields: readonly ("thinking" | "reasoning_effort")[],
): boolean {
  /*
   * An effort ladder needs `reasoning_effort`, and nothing else will do. It is
   * not a member of the `thinking` object, so a family that forwards only that
   * object cannot express one however the model's own API spells it.
   */
  if (type === "effort") return fields.includes("reasoning_effort");
  // A toggle and a budget both live inside `thinking`.
  return fields.includes("thinking");
}

export function reasoningOptionsFor(
  baseModel: string,
  family: string | undefined,
): { options: ReasoningOptions; togglesThinking: boolean } | undefined {
  const fields =
    family === undefined ? undefined : REASONING_FIELDS_BY_FAMILY[family];
  if (fields === undefined) {
    // Absent from both tables means nobody has read this family's map yet.
    return family !== undefined && NO_REASONING_CONTROL.has(family)
      ? { options: [], togglesThinking: false }
      : undefined;
  }

  const documented =
    optionsIn(
      parseToml(
        path.join(
          PROVIDERS_DIR,
          baseModel.split("/")[0] ?? "",
          "models",
          `${baseModel.split("/").slice(1).join("/")}.toml`,
        ),
      ),
    ) ?? peerOptionsByBaseModel().get(baseModel);
  if (documented === undefined) return undefined;

  const options = documented.filter((option) => carries(option.type, fields));
  /*
   * An empty list is a claim that nobody may steer this model here, so it is
   * only written where that is affirmed: the model's own provider says so, or
   * the family's map carries no reasoning field at all. Documented controls
   * that cannot travel this path are a different case, and the controls that
   * could are unknown rather than absent, so those are reported instead.
   */
  if (documented.length > 0 && options.length === 0) return undefined;
  return {
    options,
    togglesThinking: options.some((option) => option.type === "toggle"),
  };
}

export function buildHopscotchModel(
  model: HopscotchModel,
  baseModel: string,
  reasoningOptions: ReasoningOptions | undefined,
): SyncedModel {
  const base = parseToml(path.join(MODELS_DIR, `${baseModel}.toml`));
  const baseLimit = (base?.["limit"] ?? {}) as Record<string, unknown>;
  const reportedContext = model.uniblock.context_window_tokens ?? undefined;
  /*
   * Hopscotch reports one window figure per model, and for some routes that
   * figure is the model's INPUT ceiling rather than its whole context: it
   * publishes 272,000 for GPT-5, which is the lab's `limit.input` beside a
   * `limit.context` of 400,000. Writing it as the context would shrink the
   * advertised window to the input ceiling, so a figure matching the base's
   * input is left alone and the base's own context stands.
   */
  const context =
    reportedContext !== undefined && reportedContext === baseLimit["input"]
      ? undefined
      : reportedContext;
  const reported = model.uniblock.max_output_tokens ?? undefined;
  /*
   * A missing max output is left to the base model rather than filled with the
   * context window. The two are different numbers, and standing one in for the
   * other would publish a ceiling this platform never reported and overwrite a
   * correct smaller one on every hourly sync.
   */
  const output = reported !== undefined && reported > 0 ? reported : undefined;
  const limit =
    context === undefined && output === undefined
      ? undefined
      : {
          ...(context === undefined ? {} : { context }),
          ...(output === undefined ? {} : { output }),
        };

  /*
   * A proven `vision = no` is a restriction this host can state, so it takes
   * image and file input off the model here whatever the base says. A proven
   * `yes` only confirms the base, whose modality list is the fuller one, so it
   * sets `attachment` and leaves the list alone rather than narrowing it to the
   * one modality this platform happens to name.
   *
   * Where a `yes` meets a base that takes text alone the two disagree, and the
   * catalog carries no modality list of its own to settle it. Writing
   * `attachment = true` beside a text-only input would publish a file that
   * contradicts itself, so the disagreement is left as it is and the base's own
   * facts stand. `streaming` and `audio` are reported `unknown` for every model
   * this host serves, so there is nothing to map from them.
   */
  const baseModalities = (base?.["modalities"] ?? {}) as Record<string, unknown>;
  const baseTakesFiles =
    Array.isArray(baseModalities["input"]) &&
    (baseModalities["input"] as unknown[]).some((mode) => mode !== "text");
  const reportedVision = capability(model.uniblock.capabilities.vision);
  const vision =
    reportedVision === true && !baseTakesFiles ? undefined : reportedVision;

  /*
   * A model this platform has withdrawn says so, rather than sitting in the
   * catalog as though it were still on sale.
   */
  const status =
    model.uniblock.deprecated_at == null ? undefined : ("deprecated" as const);

  /*
   * The name is deliberately not overridden. The canonical model's name is the
   * curated one; Hopscotch's display name is a per-platform label that is
   * sometimes the provider's raw id (`gpt-5`, `meta-models/Muse-Glimmer-30B`),
   * so imposing it would make this registry's names worse, not better.
   */
  return factorBaseModel(
    baseModel,
    {
      status,
      attachment: vision,
      ...(vision === false
        ? { modalities: { input: ["text"] as const } }
        : {}),
      tool_call: capability(model.uniblock.capabilities.tools),
      structured_output: capability(model.uniblock.capabilities.json_mode),
      reasoning_options: reasoningOptions,
      cost: buildCost(model),
      limit,
    },
    limit,
  );
}

// ========================================
// Hopscotch provider
// ========================================

export const hopscotch = {
  id: "hopscotch",
  name: "Hopscotch",
  modelsDir: "providers/hopscotch/models",
  preserveBaseModels: false,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(
        `Hopscotch request failed: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  },
  parseModels(raw) {
    return HopscotchResponse.parse(raw).data;
  },
  /**
   * Only the chat models, and only those whose canonical metadata already
   * exists. Hopscotch publishes prices, limits and proven capabilities but no
   * description or modalities, so a model with no base to stand on would need
   * facts invented for it.
   */
  sourceID(model) {
    return model.uniblock.endpoint_families.includes("chat_completions")
      ? model.id
      : undefined;
  },
  skippedNotice(ids) {
    return [
      `Skipped ${ids.length} Hopscotch model(s) with no canonical metadata: ${ids.join(", ")}.`,
    ];
  },
  translateModel(model) {
    if (!model.uniblock.endpoint_families.includes("chat_completions")) {
      return undefined;
    }
    const baseModel = resolveHopscotchBaseModel(
      model.uniblock.model_id,
      model.uniblock.author_slug,
    );
    if (baseModel === undefined) return undefined;
    const reasons = baseModelReasons(baseModel);
    if (!reasons) {
      return {
        id: model.id,
        model: buildHopscotchModel(model, baseModel, undefined),
      };
    }
    const family = model.uniblock.provider_families[0];
    const resolved = reasoningOptionsFor(baseModel, family);
    /*
     * Reported, not dropped. Returning undefined would read as "the host no
     * longer serves this model" and delete an already-synced file on the next
     * hourly run; this error leaves the file alone and names the gap instead.
     */
    if (resolved === undefined) {
      throw new MissingReasoningOptionsError(
        model.id,
        `no reasoning controls verified for ${baseModel} on family ${family ?? "unknown"}`,
      );
    }
    return {
      id: model.id,
      model: buildHopscotchModel(model, baseModel, resolved.options),
      header: headerFor(family ?? "", resolved.options),
    };
  },
} satisfies SyncProvider<HopscotchModel>;
