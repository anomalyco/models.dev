import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

// Repo-level base-model metadata directory (mirrors openrouter.ts MODELS_DIR).
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

function baseModelExists(modelID: string): boolean {
  return existsSync(path.join(MODELS_DIR, `${modelID}.toml`));
}

// CrossModel is an OpenAI- and Anthropic-compatible multi-provider gateway. Its
// public catalog endpoint carries the volatile, gateway-specific data we sync:
// served price (USD micro / 1M tokens, threshold-tiered), modalities, context /
// output limits, and a `capabilities.reasoning` object describing the reasoning
// controls CrossModel itself exposes (the internal shape behind models.dev's
// reasoning_options). https://www.crossmodel.ai/api/models
// CROSSMODEL_MODELS_URL overrides the endpoint (e.g. a local backend) for testing.
const API_ENDPOINT = process.env.CROSSMODEL_MODELS_URL ?? "https://www.crossmodel.ai/api/models";

const ReasoningCapability = z
  .object({
    toggle: z.boolean().optional(),
    effort: z.array(z.string()).optional(),
    budget_tokens: z
      .object({ min: z.number().optional(), max: z.number().optional() })
      .optional(),
  })
  .passthrough();

const PriceTier = z
  .object({
    threshold: z.number().nullable().optional(),
    input_micro_per_1m: z.number().nullable().optional(),
    output_micro_per_1m: z.number().nullable().optional(),
    cache_read_micro_per_1m: z.number().nullable().optional(),
    cache_creation_micro_per_1m: z.number().nullable().optional(),
  })
  .passthrough();

export const CrossModelModel = z
  .object({
    id: z.string(),
    vendor_code: z.string(),
    display_name: z.string().optional(),
    context_window_tokens: z.number().nullable().optional(),
    max_output_tokens: z.number().nullable().optional(),
    modalities: z
      .object({ input: z.array(z.string()), output: z.array(z.string()) })
      .optional(),
    capabilities: z
      .object({ reasoning: ReasoningCapability.optional() })
      .passthrough()
      .nullable()
      .optional(),
    status: z.string().optional(),
    currency: z.string().nullable().optional(),
    pricing: z.object({ tiers: z.array(PriceTier).nullable() }).nullable().optional(),
  })
  .passthrough();

export const CrossModelResponse = z.object({ data: z.array(CrossModelModel) }).passthrough();

export type CrossModelModel = z.infer<typeof CrossModelModel>;

// vendor_code -> models.dev base_model author prefix. Used only for brand-new
// models without an existing factored TOML; existing rows reuse their base_model.
const AUTHOR_BY_VENDOR: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  moonshot: "moonshotai",
  deepseek: "deepseek",
  qwen: "alibaba",
  xiaomi: "xiaomi",
  minimax: "minimax",
  "z-ai": "zhipuai",
  tencent: "tencent",
};

export const crossmodel = {
  id: "crossmodel",
  name: "CrossModel",
  modelsDir: "providers/crossmodel/models",
  async fetchModels() {
    const headers = process.env.CROSSMODEL_API_KEY
      ? { Authorization: `Bearer ${process.env.CROSSMODEL_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`CrossModel request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return CrossModelResponse.parse(raw).data.filter(
      (model) => model.status !== "hidden",
    );
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const built = buildCrossModel(model, existing);
    if (built === undefined) return undefined;
    return { id: model.id, model: built };
  },
} satisfies SyncProvider<CrossModelModel>;

/** Integer USD micro / 1M tokens -> USD / 1M tokens; undefined when absent. */
function price(micro: number | null | undefined): number | undefined {
  if (micro === undefined || micro === null) return undefined;
  return Math.round(micro) / 1_000_000;
}

function nonZeroPrice(micro: number | null | undefined): number | undefined {
  const value = price(micro);
  return value !== undefined && value > 0 ? value : undefined;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[] | undefined, fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = (values ?? [])
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

// Project CrossModel's capabilities.reasoning onto models.dev reasoning_options.
//   reasoning absent  -> undefined (non-reasoning model; option omitted)
//   reasoning === {}  -> [] (model reasons, no verified user-selectable control)
//   otherwise         -> toggle / effort / budget_tokens entries
function reasoningOptions(model: CrossModelModel): SyncedModel["reasoning_options"] {
  const reasoning = model.capabilities?.reasoning;
  if (reasoning === undefined) return undefined;
  const options: NonNullable<SyncedModel["reasoning_options"]> = [];
  if (reasoning.toggle === true) options.push({ type: "toggle" });
  if (reasoning.effort !== undefined && reasoning.effort.length > 0) {
    options.push({ type: "effort", values: reasoning.effort as never });
  }
  if (reasoning.budget_tokens !== undefined) {
    const budget: { type: "budget_tokens"; min?: number; max?: number } = { type: "budget_tokens" };
    if (reasoning.budget_tokens.min !== undefined) budget.min = reasoning.budget_tokens.min;
    if (reasoning.budget_tokens.max !== undefined) budget.max = reasoning.budget_tokens.max;
    options.push(budget);
  }
  return options;
}

function buildCrossModel(
  model: CrossModelModel,
  existing: ExistingModel | undefined,
): SyncedModel | undefined {
  // Base tier (smallest input-context threshold) drives the headline cost; any
  // hand-authored context tiers on the existing entry are preserved as-is.
  const tiers = model.pricing?.tiers ?? [];
  const base = [...tiers].sort(
    (a, b) => (a.threshold ?? 0) - (b.threshold ?? 0),
  )[0];
  const input = price(base?.input_micro_per_1m);
  const output = price(base?.output_micro_per_1m);
  const cost =
    input !== undefined && output !== undefined
      ? {
          input,
          output,
          cache_read: nonZeroPrice(base?.cache_read_micro_per_1m) ?? existing?.cost?.cache_read,
          cache_write: nonZeroPrice(base?.cache_creation_micro_per_1m) ?? existing?.cost?.cache_write,
          tiers: existing?.cost?.tiers,
        }
      : existing?.cost;

  const context = model.context_window_tokens ?? existing?.limit?.context ?? undefined;
  const limit = {
    context: context as number,
    input: existing?.limit?.input,
    output: model.max_output_tokens ?? existing?.limit?.output ?? (context as number),
  };

  const modality = {
    input: modalities(model.modalities?.input, existing?.modalities?.input ?? ["text"]),
    output: modalities(model.modalities?.output, existing?.modalities?.output ?? ["text"]),
  };

  const reasoning_options = reasoningOptions(model);

  // Resolve the base_model: prefer the existing factored entry; otherwise derive
  // from vendor_code. Skip models we can't map or whose base isn't in models.dev
  // yet — those need their author metadata hand-added first.
  const baseModel = existing?.base_model ?? deriveBaseModel(model);
  if (baseModel === undefined || !baseModelExists(baseModel)) return undefined;

  // Curated capability fields stay inherited from the base model (undefined here);
  // we only drive the volatile cost/limit/modalities plus the gateway-specific
  // reasoning_options.
  return factorBaseModel(
    baseModel,
    {
      attachment: existing?.attachment,
      reasoning: existing?.reasoning,
      temperature: existing?.temperature,
      tool_call: existing?.tool_call,
      structured_output: existing?.structured_output,
      knowledge: existing?.knowledge,
      modalities: modality,
      reasoning_options,
      limit,
      cost,
    },
    limit,
    existing?.base_model_omit,
  );
}

function deriveBaseModel(model: CrossModelModel): string | undefined {
  const author = AUTHOR_BY_VENDOR[model.vendor_code];
  if (author === undefined) return undefined;
  const short = model.id.includes("/") ? model.id.split("/").slice(1).join("/") : model.id;
  // MiniMax base ids are TitleCased incl. the model letter (e.g. minimax/MiniMax-M3).
  if (author === "minimax") {
    return `minimax/${short.replace(/^minimax-m/i, "MiniMax-M")}`;
  }
  return `${author}/${short}`;
}
