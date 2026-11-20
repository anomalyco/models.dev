import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncProvider } from "../index.js";
import { exactInput } from "./keln.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.neuralwatt.com/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const DOCS = "https://docs.neuralwatt.com/api";
const SYSTEMONE_DOCS = "https://portal.neuralwatt.com/docs/api/systemone";
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];
const MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);
// Hugging Face repos whose lab model publishes different weights, so the
// weights index can't find it. Keyed by lowercased `metadata.huggingface_id`.
const LAB_OVERRIDES: Record<string, string> = {
  // Xiaomi's MOPD build of MiMo-V2.6-Pro; the lab file lists the -RL weights.
  "xiaomimimo/mimo-v2.6-pro-mopd": "xiaomi/mimo-v2.6-pro",
};
// Quantized republications (Qwen/Qwen3.8-27B-FP8, nvidia/Gemma-4-31B-IT-NVFP4)
// serve the lab model named without the suffix.
const QUANT_SUFFIX = /-(fp8|fp4|nvfp4|mxfp4|int4|int8|awq|gptq|bf16|w4a16|w8a8)$/i;

const Price = z.number().nonnegative();
const Effort = z.string().min(1);

export const NeuralwattModel = z.object({
  id: z.string().min(1),
  max_model_len: z.number().int().positive(),
  metadata: z.object({
    display_name: z.string().nullish(),
    huggingface_id: z.string().nullish(),
    pricing: z.object({
      input_per_million: Price.nullish(),
      output_per_million: Price.nullish(),
      cached_input_per_million: Price.nullish(),
      pricing_tbd: z.boolean(),
      service_tier: z.string().nullish(),
    }).passthrough(),
    capabilities: z.object({
      tools: z.boolean(),
      json_mode: z.boolean(),
      reasoning: z.boolean(),
      // Only decision models set it ("decision").
      task: z.string().nullish(),
    }).passthrough(),
    // The reasoning_effort contract; null when the model publishes no levels.
    reasoning: z.object({
      mandatory: z.boolean(),
      supported_efforts: z.array(Effort).nullish(),
      default_effort: Effort.nullish(),
    }).passthrough().nullish(),
    limits: z.object({
      max_context_length: z.number().int().positive().nullish(),
      // null: no host cap (the request may use whatever context is left).
      max_output_tokens: z.number().int().nonnegative().nullish(),
    }).passthrough(),
    deprecated: z.boolean(),
  }).passthrough(),
  architecture: z.object({
    input_modalities: z.array(z.string()).min(1),
    output_modalities: z.array(z.string()).min(1),
  }).passthrough(),
}).passthrough();

export const NeuralwattResponse = z.object({
  object: z.literal("list"),
  // An authenticated list adds the account's private grants. Only the public
  // list may feed the catalog, so anything else fails the run.
  scope: z.literal("public"),
  data: z.array(NeuralwattModel).min(1, "Neuralwatt returned an empty catalog; refusing to remove local models"),
}).passthrough().refine(
  (response) => new Set(response.data.map((model) => model.id)).size === response.data.length,
  "Neuralwatt returned duplicate model IDs",
);

export type NeuralwattModel = z.infer<typeof NeuralwattModel>;

export const neuralwatt = {
  id: "neuralwatt",
  name: "Neuralwatt",
  modelsDir: "providers/neuralwatt/models",
  fetchModels: fetchNeuralwattModels,
  parseModels(raw) {
    return NeuralwattResponse.parse(raw).data;
  },
  sourceID(model) {
    return model.id;
  },
  // A priced model without a lab file or published reasoning levels gets a
  // missing-model issue, and an existing file for it is kept meanwhile.
  missingModelID(model) {
    if (!priced(model)) return undefined;
    // Embedding rows (task "embed") have no catalog shape here; skip them quietly.
    const task = model.metadata.capabilities.task;
    if (task !== "decision" && !model.architecture.output_modalities.includes("text")) return undefined;
    const unpublished = model.metadata.capabilities.reasoning && reasoningOptions(model.metadata.reasoning, undefined) === undefined;
    return neuralwattBaseModel(model.metadata.huggingface_id) === undefined || unpublished ? model.id : undefined;
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `Neuralwatt models not synced (no lab model for their huggingface_id, unpriced, or no published reasoning levels): ${ids.join(", ")}`,
    ];
  },
  translateModel(model, context) {
    if (!priced(model)) return undefined;
    const authored = context.authored(model.id);
    const baseModel = neuralwattBaseModel(model.metadata.huggingface_id) ?? authored?.base_model;
    if (baseModel === undefined) return undefined;

    if (model.metadata.capabilities.task === "decision") {
      const v2 = buildDecisionModel(model, baseModel);
      return v2 === undefined ? undefined : { id: model.id, v2, header: DECISION_HEADER };
    }
    if (!model.architecture.output_modalities.includes("text")) return undefined;

    const reasoning = model.metadata.capabilities.reasoning;
    const controls = reasoning ? reasoningOptions(model.metadata.reasoning, authored) : undefined;
    // A thinking model needs its levels published; never invent them. An
    // existing file keeps its authored controls (the runner preserves them).
    if (reasoning && controls === undefined && authored?.reasoning_options === undefined) return undefined;

    const input = kinds(model.architecture.input_modalities);
    const pricing = model.metadata.pricing;
    const limit = {
      context: model.metadata.limits.max_context_length ?? model.max_model_len,
      output: outputLimit(model, authored),
    };
    const deprecated = model.metadata.deprecated;
    const translated = factorBaseModel(baseModel, {
      name: model.metadata.display_name?.trim() || undefined,
      attachment: input.some((value) => value !== "text"),
      tool_call: model.metadata.capabilities.tools,
      structured_output: model.metadata.capabilities.json_mode,
      reasoning,
      reasoning_options: controls,
      // The reasoning trace comes back on `reasoning`; see provider.toml.
      interleaved: reasoning ? true : authored?.interleaved,
      status: deprecated ? "deprecated" : authored?.status === "deprecated" ? undefined : authored?.status,
      cost: {
        input: pricing.input_per_million!,
        output: pricing.output_per_million!,
        cache_read: pricing.cached_input_per_million ?? undefined,
      },
      limit,
      modalities: { input, output: ["text"] },
    }, limit);

    const v2Set: Record<string, unknown> = {};
    const labInput = labInputModalities(baseModel);
    if (translated.modalities?.input !== undefined && labInput !== undefined) {
      // Keep the file's exact MIME types while it lists the same kinds;
      // otherwise take the lab's for each kind the API lists.
      v2Set["modalities.input"] = (current: unknown) =>
        Array.isArray(current) && sameKinds(current, input) ? current : exactInput(input, labInput);
    }

    return {
      id: model.id,
      model: translated,
      header: chatHeader(model, controls),
      v2Set,
    };
  },
} satisfies SyncProvider<NeuralwattModel>;

function priced(model: NeuralwattModel) {
  const pricing = model.metadata.pricing;
  return !pricing.pricing_tbd && pricing.input_per_million != null && pricing.output_per_million != null;
}

/** The API's levels, low to high, plus a budget the file already documents. */
export function reasoningOptions(
  reasoning: NeuralwattModel["metadata"]["reasoning"],
  authored: ExistingModel | undefined,
) {
  if (reasoning == null) return undefined;
  const values = [...new Set(reasoning.supported_efforts ?? [])]
    .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  // No published levels: reasoning is always on and nothing controls it.
  if (values.length === 0) return reasoning.mandatory ? [] : undefined;
  const effort = ReasoningOption.safeParse({ type: "effort", values });
  if (!effort.success) return undefined;
  // `thinking_token_budget` is accepted per model but /v1/models doesn't say
  // where, so a budget is only ever carried over from the authored file.
  const budget = authored?.reasoning_options?.filter((option) => option.type === "budget_tokens") ?? [];
  return [effort.data, ...budget];
}

// A published cap wins; with none (null), keep the file's limit, else inherit the lab's.
function outputLimit(model: NeuralwattModel, authored: ExistingModel | undefined) {
  const cap = model.metadata.limits.max_output_tokens;
  return cap != null && cap > 0 ? cap : authored?.limit?.output;
}

function kinds(values: string[]) {
  return [...new Set(values.map((value) => (value === "file" ? "pdf" : value.toLowerCase())))]
    .filter((value): value is "text" | "audio" | "image" | "video" | "pdf" => MODALITIES.has(value));
}

function kindOf(item: string) {
  return item === "application/pdf" ? "pdf" : item.split("/")[0]!;
}

function sameKinds(current: unknown[], expected: string[]) {
  const have = new Set(current.map((item) => kindOf(String(item))));
  return have.size === expected.length && expected.every((kind) => have.has(kind));
}

function chatHeader(model: NeuralwattModel, controls: z.infer<typeof ReasoningOption>[] | undefined) {
  const lines = [
    `# Generated by bun models:sync neuralwatt from ${API_ENDPOINT} (public list).`,
    "# Prices are USD per million tokens from metadata.pricing; lab facts are inherited via base_model.",
  ];
  const effort = controls?.find((option) => option.type === "effort");
  if (effort?.type === "effort") {
    lines.push(`# Effort: top-level reasoning_effort = ${effort.values.join("|")} (${DOCS}/chat-completions#reasoning-effort).`);
  }
  if (model.metadata.pricing.service_tier === "flex") {
    lines.push("# Flex tier: requires stream = true, and the listed prices already include the flex discount.");
  }
  if (model.id.endsWith("-speed")) {
    lines.push("# Speed lane: billed for measured energy and priced above the listed token price on purpose (https://portal.neuralwatt.com/docs/energy-methodology).");
  }
  return `${lines.join("\n")}\n`;
}

const DECISION_HEADER = [
  `# Decision model: POST https://api.neuralwatt.com/v1/systemone with the System One {model, state, questions} body (${SYSTEMONE_DOCS}).`,
  "# Text only: a request with images or videos is a 400. Prices are USD per million tokens from GET /v1/models metadata.pricing.",
].join("\n") + "\n";

// Decision models only answer on /v1/systemone, so they are v2-only files.
export function buildDecisionModel(model: NeuralwattModel, baseModel: string) {
  const lab = labModel(baseModel);
  if (lab?.type !== "decision") return undefined;
  const pricing = model.metadata.pricing;
  const doc: Record<string, unknown> = { schema: 2, v2_only: true, base_model: baseModel };
  if (model.metadata.deprecated) doc.status = "deprecated";
  const input = model.architecture.input_modalities.includes("text") ? kinds(model.architecture.input_modalities) : undefined;
  const labModalities = lab.modalities as { input?: string[]; output?: string[] } | undefined;
  if (input !== undefined && labModalities?.input !== undefined && !sameKinds(labModalities.input, input)) {
    doc.modalities = { input: exactInput(input, labModalities.input), output: labModalities.output ?? ["decision"] };
  }
  const context = model.metadata.limits.max_context_length ?? model.max_model_len;
  if (context !== (lab.limit as { context?: number } | undefined)?.context) doc.limit = { context };
  // Neuralwatt has no @opencode/ai package of its own; see AGENTS.md "APIs".
  doc.api = {
    systemone: { sdk: { aisdk: "@ai-sdk/typesafe-ai", opencodeai: "@opencode/ai/providers/typesafe-ai/decisions" } },
  };
  const cacheRead = pricing.cached_input_per_million;
  doc.cost = {
    text: {
      input: { price: pricing.input_per_million!, ...(cacheRead != null && { cache: { read: cacheRead } }) },
      output: { price: pricing.output_per_million! },
    },
  };
  return doc;
}

let weightsIndex: Map<string, string[]> | undefined;

// Lab model IDs keyed by each Hugging Face repo their [[weights]] list.
function labWeights() {
  if (weightsIndex !== undefined) return weightsIndex;
  weightsIndex = new Map();
  for (const lab of readdirSync(MODELS_DIR, { withFileTypes: true })) {
    if (!lab.isDirectory()) continue;
    for (const file of readdirSync(path.join(MODELS_DIR, lab.name), { recursive: true }) as string[]) {
      if (!file.endsWith(".toml")) continue;
      const id = `${lab.name}/${file.slice(0, -5).split(path.sep).join("/")}`;
      const weights = (labModel(id)?.weights ?? []) as Array<{ url?: unknown }>;
      for (const { url } of weights) {
        const repo = typeof url === "string" ? /^https:\/\/huggingface\.co\/([^/]+\/[^/?#]+)/.exec(url)?.[1] : undefined;
        if (repo === undefined) continue;
        const key = repo.toLowerCase();
        weightsIndex.set(key, [...(weightsIndex.get(key) ?? []), id]);
      }
    }
  }
  return weightsIndex;
}

/** The lab model served under a `metadata.huggingface_id`, or undefined when no single one matches. */
export function neuralwattBaseModel(huggingfaceID: string | null | undefined) {
  if (huggingfaceID == null || !huggingfaceID.includes("/")) return undefined;
  const id = huggingfaceID.toLowerCase();
  if (LAB_OVERRIDES[id] !== undefined) return LAB_OVERRIDES[id];
  const index = labWeights();
  const unique = (ids: string[] | undefined) => (ids !== undefined && new Set(ids).size === 1 ? ids[0] : undefined);
  const exact = unique(index.get(id));
  if (exact !== undefined) return exact;

  const [org = "", repo = ""] = id.split("/");
  const bare = repo.replace(QUANT_SUFFIX, "");
  if (bare === repo) return undefined;
  const sameOrg = unique(index.get(`${org}/${bare}`));
  if (sameOrg !== undefined) return sameOrg;
  // A republisher's quantization (nvidia/...-NVFP4): match the repo name in any org.
  const matches = [...index.entries()]
    .filter(([key]) => key.split("/")[1] === bare)
    .flatMap(([, ids]) => ids);
  return unique(matches);
}

function labModel(modelID: string) {
  try {
    return Bun.TOML.parse(readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function labInputModalities(modelID: string): string[] | undefined {
  const input = (labModel(modelID)?.modalities as { input?: unknown } | undefined)?.input;
  return Array.isArray(input) && input.every((item) => typeof item === "string") ? input : undefined;
}

// Never sends credentials: an authenticated list would add private grants.
export async function fetchNeuralwattModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Neuralwatt catalog request failed: ${response.status} ${response.statusText}`);
  }
  return NeuralwattResponse.parse(await response.json());
}
