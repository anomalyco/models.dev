import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { AuthoredModelShape, ReasoningOption } from "../../schema.js";
import type { SyncProvider } from "../index.js";
import { perTokenToPerMillion } from "./inceptron.js";
import { exactInput } from "./keln.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

// The keyless copy of Reka's customer `/v1/models`: the models a customer key can
// call on api.reka.ai (active, public), with the same entries byte for byte, so
// the sync needs no repository secret. A model Reka retires leaves the list; one
// it launches appears. `REKA_MODELS_URL` points a dry run at staging.
const API_ENDPOINT = "https://api.reka.ai/v1/site/chat-models";
const DOCS_URL = "https://docs.reka.ai/chat/models.md";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const PerTokenPrice = z.string().regex(/^(0|[1-9]\d*)(?:\.\d+)?$/);

export const RekaModel = z.object({
  id: z.string().min(1),
  created: z.number().int().nonnegative(),
  name: z.string().min(1),
  description: z.string(),
  input_modalities: z.array(z.string()).min(1),
  output_modalities: z.array(z.string()).min(1),
  context_length: z.number().int().positive().optional(),
  // An OpenRouter eligibility figure, not a generation cap (see translateModel).
  max_output_length: z.number().int().positive().optional(),
  // USD per token as decimal strings (OpenRouter's flat shape). Absent on a model
  // Reka lists without a price.
  pricing: z.object({
    prompt: PerTokenPrice,
    completion: PerTokenPrice,
    // "0" when the model prices no prefix-cache read.
    input_cache_read: PerTokenPrice.optional(),
  }).passthrough().optional(),
  supported_features: z.array(z.string()).optional(),
  supported_sampling_parameters: z.array(z.string()).optional(),
  // The reasoning_effort values a caller can usefully send, lowest to highest.
  // `[]` = the model always reasons and takes no control. Absent on a model
  // that does not reason, or whose controls Reka has not declared yet.
  reasoning_efforts: z.array(z.string()).optional(),
  hugging_face_id: z.string().min(1).optional(),
  is_ready: z.boolean().optional(),
}).passthrough();

export const RekaResponse = z.object({
  object: z.literal("list"),
  data: z.array(RekaModel).min(1, "Reka returned an empty model list; refusing to remove local models"),
}).passthrough().refine(
  (response) => new Set(response.data.map((model) => model.id)).size === response.data.length,
  "Reka returned duplicate model IDs",
);

export type RekaModel = z.infer<typeof RekaModel>;

// Hugging Face organisations whose lab id on models.dev differs from the org name.
// Every other org resolves as spelled (case-insensitively) against `models/`.
const LAB_PREFIXES: Record<string, string> = {
  Qwen: "alibaba",
  "deepseek-ai": "deepseek",
  "zai-org": "zhipuai",
  RekaAI: "rekaai",
  MiniMaxAI: "minimax",
  mistralai: "mistral",
  "meta-llama": "meta",
};

// Hub repos whose lab file is not named after the repo.
const BASE_MODEL_ALIASES: Record<string, string> = {
  // The lab entry carries the undated id; 2603 is the only Reka Edge release.
  "RekaAI/reka-edge-2603": "rekaai/reka-edge",
};

/** The lab entry a Reka model inherits from, found through its Hugging Face repo. */
export function rekaBaseModel(model: Pick<RekaModel, "id" | "hugging_face_id">) {
  const hub = model.hugging_face_id;
  if (hub === undefined) return undefined;
  const alias = BASE_MODEL_ALIASES[hub];
  if (alias !== undefined) return alias;
  const [org = "", ...rest] = hub.split("/");
  if (rest.length === 0) return undefined;
  return resolveModelMetadataBaseModel([LAB_PREFIXES[org] ?? org.toLowerCase(), ...rest].join("/"));
}

/** Reasoning controls as Reka publishes them; undefined when a reasoner's are missing or unknown. */
export function rekaReasoningControls(model: Pick<RekaModel, "supported_features" | "reasoning_efforts">) {
  const reasoning = (model.supported_features ?? []).includes("reasoning");
  if (!reasoning) return { reasoning: false as const, options: undefined, header: "" };
  const efforts = model.reasoning_efforts;
  if (efforts === undefined) return undefined;
  if (efforts.length === 0) {
    return {
      reasoning: true as const,
      options: [] as z.infer<typeof ReasoningOption>[],
      header: "# Always on: no request field switches thinking off; reasoning_effort is accepted and ignored.\n",
    };
  }
  if (efforts.some((effort) => !EFFORT_ORDER.includes(effort))) return undefined;
  const sorted = [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  const effort = ReasoningOption.safeParse({ type: "effort", values: sorted });
  if (!effort.success) return undefined;
  const off = sorted.includes("none")
    ? ' "none" turns thinking off; silence is the model\'s default.'
    : " Thinking cannot be switched off.";
  return {
    reasoning: true as const,
    options: [effort.data],
    header: `# Effort: top-level reasoning_effort = ${sorted.join("|")}.${off}\n`,
  };
}

export const reka = {
  id: "reka",
  name: "Reka",
  modelsDir: "providers/reka/models",
  preserveBaseModels: false,
  preserveDescriptions: false,
  // Rows without a lab base or published reasoning controls are reported and keep their files.
  trackMissingModels: false,
  fetchModels: fetchRekaModels,
  parseModels(raw) {
    // Reka lists chat models only, so every row outputs text; filter all the same so
    // a future media row never gets a chat file.
    return RekaResponse.parse(raw).data.filter((model) => model.output_modalities.includes("text"));
  },
  sourceID(model) {
    return model.id;
  },
  missingModelID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `Reka models awaiting a lab base or published reasoning controls: ${ids.join(", ")}`,
    ];
  },
  sourceNotices(models) {
    const notReady = models.filter((model) => model.is_ready === false).map((model) => model.id);
    return notReady.length === 0 ? [] : [
      `Reka reports is_ready=false (temporarily paused, still listed) for: ${notReady.join(", ")}`,
    ];
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const baseModel = context.authored(model.id)?.base_model ?? rekaBaseModel(model);
    if (baseModel === undefined) return undefined;
    const base = modelMetadata(baseModel);
    const controls = rekaReasoningControls(model);
    // A thinking model needs its controls published; never invent them. A lab
    // reasoner that Reka serves without reasoning is also held back for review.
    if (controls === undefined || (!controls.reasoning && base.reasoning === true)) return undefined;

    const schema = AuthoredModelShape.shape.modalities;
    const input = model.input_modalities.flatMap((value) => {
      const parsed = schema.shape.input.element.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    if (!input.includes("text")) return undefined;

    const features = new Set(model.supported_features ?? []);
    const sampling = new Set(model.supported_sampling_parameters ?? []);
    // `max_output_length` is not synced: Reka's catalog states it is an OpenRouter
    // eligibility figure (it must cover the served context so auctions are not
    // filtered out), not a generation ceiling. The output limit is the lab's,
    // capped at the context by the runner, or a hand-authored value.
    const limit = {
      context: model.context_length ?? existing?.limit?.context,
      output: existing?.limit?.output,
    };
    const cacheRead = model.pricing?.input_cache_read;
    const translated = factorBaseModel(baseModel, {
      name: model.name,
      attachment: input.some((value) => value !== "text"),
      reasoning: controls.reasoning,
      reasoning_options: controls.options,
      // Every Reka reasoner returns its thinking in message.reasoning_content: the
      // gateway mirrors vLLM's `reasoning` into the documented field.
      interleaved: controls.reasoning ? { field: "reasoning_content" } : undefined,
      tool_call: features.has("tools"),
      structured_output: features.has("structured_outputs") ? true : undefined,
      temperature: sampling.size > 0 ? sampling.has("temperature") : undefined,
      status: existing?.status,
      cost: model.pricing === undefined ? existing?.cost : {
        input: perTokenToPerMillion(model.pricing.prompt),
        output: perTokenToPerMillion(model.pricing.completion),
        cache_read: cacheRead === undefined || perTokenToPerMillion(cacheRead) === 0
          ? undefined
          : perTokenToPerMillion(cacheRead),
      },
      limit,
      modalities: { input, output: ["text"] },
    }, limit);

    const v2Set: Record<string, unknown> = {};
    // "Where a model supports prompt caching, repeated prompt prefixes are cached
    // automatically and billed at the model's cached-input rate"
    // (https://docs.reka.ai/pricing.md): a priced cache read is implicit caching.
    // Authored cache details are kept; the kind is only filled in where none is set.
    const cached = "cost" in translated && translated.cost?.cache_read !== undefined;
    const authoredCache = (context.v2?.(model.id)?.capabilities as { cache?: unknown } | undefined)?.cache;
    if (cached && authoredCache === undefined) v2Set["capabilities.cache"] = { implicit: true };

    // When the input differs from the lab, write the lab's exact MIME types for each
    // kind Reka lists, and say which of the lab's kinds this host does not take.
    const labInput = labInputModalities(baseModel);
    let inputNote = "";
    if (translated.modalities?.input !== undefined && labInput !== undefined) {
      v2Set["modalities.input"] = exactInput(input, labInput);
      const missing = [...new Set(labInput.map((item) => kindOf(item)))]
        .filter((kind) => !input.some((value) => value === kind));
      if (missing.length > 0) {
        inputNote = `# Input: ${input.join(" and ")} per Reka's listing; this host takes no ${missing.join(" or ")}.\n`;
      }
    }

    return {
      id: model.id,
      model: translated,
      header: `# Generated by bun models:sync reka from ${API_ENDPOINT}.\n`
        + "# Prices are USD per million tokens; lab facts are inherited via base_model.\n"
        + `# Reka model docs: ${DOCS_URL}\n`
        + controls.header
        + (cached ? "# Cache: prompt prefixes are cached automatically and billed at cache.read (https://docs.reka.ai/pricing.md).\n" : "")
        + inputNote,
      ...(Object.keys(v2Set).length > 0 && { v2Set }),
    };
  },
} satisfies SyncProvider<RekaModel>;

/** The lab file's v2 input list (MIME types), or undefined when it has none. */
function labInputModalities(modelID: string): string[] | undefined {
  try {
    const lab = Bun.TOML.parse(readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8")) as {
      modalities?: { input?: unknown };
    };
    const input = lab.modalities?.input;
    return Array.isArray(input) && input.every((item) => typeof item === "string") ? input : undefined;
  } catch {
    return undefined;
  }
}

function kindOf(item: string) {
  return item === "application/pdf" ? "pdf" : item.split("/")[0]!;
}

export async function fetchRekaModels(fetcher: typeof fetch = fetch, url = process.env.REKA_MODELS_URL ?? API_ENDPOINT) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Reka model list request failed: ${response.status} ${response.statusText}`);
  }
  return RekaResponse.parse(await response.json());
}
