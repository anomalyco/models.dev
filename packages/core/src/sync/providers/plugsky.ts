import { z } from "zod";

import type { SyncProvider, SyncedFullModel } from "../index.js";

const API_ENDPOINT = "https://api.plugsky.com/v1/models";

/**
 * The host also lists lab-sounding aliases (plugsky-deepseek-*, plugsky-gemma*,
 * plugsky-gpt-oss*, plugsky-kimi, plugsky-llama4, plugsky-minimax,
 * plugsky-mistral-*, plugsky-phi, plugsky-qwen-*). Its own metadata reports
 * each as resolving to plugsky-lite or plugsky-frontier, so they cannot be
 * attributed to a lab `base_model`. They are intentionally excluded until the
 * host publishes verifiable per-alias lab attribution.
 */
const LAB_ALIAS = /^plugsky-(deepseek|gemma|gpt|kimi|llama|minimax|mistral|phi|qwen|claude|gemini|grok|nova|command|glm|ernie)/;

const MIN_LIVE_MODELS = 18;

const HEADER = [
  "# Description and capability flags come from https://api.plugsky.com/v1/models.",
  "# Sampling flags follow the documented chat-completions fields at https://plugsky.com/docs:",
  "# temperature and top_p are accepted; top_k is not documented and is published as false.",
  "# No reasoning-effort field is documented; reasoning is always-on where the model list reports it.",
  "# release_date is preserved for existing entries; a new entry uses its first catalog date.",
].join("\n");

/** v2-only sampling fields that the v1 AuthoredModel shape cannot carry. */
const SAMPLING_V2 = {
  "capabilities.top_p": true,
  "capabilities.top_k": false,
} as const;

export const PlugskyModel = z
  .object({
    id: z.string().min(1),
    created: z.number().int().nonnegative(),
    name: z.string().min(1).nullish(),
    description: z.string().nullish(),
    reasoning: z.boolean(),
    function_calling: z.boolean(),
    json_mode: z.boolean(),
    modality: z.array(z.string()).nullish(),
    context_window: z.number().int().positive().nullish(),
    engine_context_window: z.number().int().positive().nullish(),
    max_output_tokens: z.number().int().positive().nullish(),
    max_output: z.number().int().positive().nullish(),
  })
  .passthrough();

export const PlugskyResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(PlugskyModel),
  })
  .passthrough();

export type PlugskyModel = z.infer<typeof PlugskyModel>;

const INPUT_MODALITIES = new Set(["text", "image", "audio", "video", "pdf"]);

function isBrandedChatModel(model: PlugskyModel): boolean {
  if (!model.id.startsWith("plugsky-")) return false;
  if (model.id.includes("embed")) return false;
  return !LAB_ALIAS.test(model.id);
}

function descriptionFor(model: PlugskyModel): string {
  const description = (model.description ?? "").replace(/:\s*,/g, ":").trim();
  return description.length > 0
    ? description
    : `${model.name ?? model.id} — OpenAI-compatible chat model served by Plugsky.`;
}

export async function fetchPlugskyModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Plugsky models request failed: ${response.status} ${response.statusText}`);
  }
  const parsed = PlugskyResponse.parse(await response.json());
  assertPlugskyInventory(parsed.data);
  return parsed;
}

export const plugsky = {
  id: "plugsky",
  name: "Plugsky",
  modelsDir: "providers/plugsky/models",
  authoritativeHeaders: true,
  trackMissingModels: false,
  sourceID(model) {
    return isBrandedChatModel(model) ? model.id : undefined;
  },
  async fetchModels() {
    return fetchPlugskyModels();
  },
  parseModels(raw) {
    return PlugskyResponse.parse(raw).data;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} lab-sounding Plugsky aliases are intentionally not published as standalone provider models: `
        + ids.map((id) => `\`${id}\``).join(", ")
        + ". The host reports them as aliases of plugsky-lite or plugsky-frontier, so a lab base_model would be false.",
    ];
  },
  translateModel(model, context) {
    if (!isBrandedChatModel(model)) return undefined;

    const input = (model.modality ?? ["text"]).filter((modality) => INPUT_MODALITIES.has(modality));
    if (!input.includes("text")) input.unshift("text");

    const contextLimit = model.context_window ?? model.engine_context_window;
    const outputLimit = model.max_output_tokens ?? model.max_output;
    if (contextLimit == null || outputLimit == null) {
      throw new Error(`Plugsky model ${model.id} is missing context or output limits`);
    }

    const existing = context.existing(model.id);
    const date = existing?.release_date ?? new Date().toISOString().slice(0, 10);

    const translated: SyncedFullModel = {
      name: model.name ?? model.id,
      description: descriptionFor(model),
      attachment: input.includes("image"),
      reasoning: model.reasoning,
      tool_call: model.function_calling,
      structured_output: model.json_mode,
      temperature: true,
      release_date: date,
      last_updated: existing?.last_updated ?? date,
      modalities: { input: input as SyncedFullModel["modalities"]["input"], output: ["text"] },
      open_weights: false,
      limit: { context: contextLimit, output: outputLimit },
    };

    return { id: model.id, header: HEADER, model: translated, v2Set: SAMPLING_V2 };
  },
} satisfies SyncProvider<PlugskyModel>;

export function assertPlugskyInventory(models: PlugskyModel[]): void {
  const branded = models.filter(isBrandedChatModel);
  if (branded.length < MIN_LIVE_MODELS) {
    throw new Error(
      `Plugsky returned ${branded.length} branded chat models, below the ${MIN_LIVE_MODELS}`
        + " needed to distinguish a retirement from a truncated response",
    );
  }
}
