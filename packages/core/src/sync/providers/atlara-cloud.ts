import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { SyncProvider, SyncedModel, SyncedV2Model } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

// Atlara is an OpenAI-compatible inference API (https://cloud.atlara.ai/docs). Its public catalogue
// (no key) carries the data synced here: hosted price (USD per 1M tokens), context window, which
// reasoning_effort levels Atlara forwards for the model, and a measured coding score per model.
// https://api.atlara.ai/v1/model-catalogue
// ATLARA_MODELS_URL overrides the endpoint for testing.
const API_ENDPOINT = process.env.ATLARA_MODELS_URL ?? "https://api.atlara.ai/v1/model-catalogue";

// Only models a coding agent can use are listed: chat with tools, priced, and measured as
// coding-capable. Atlara's `task_fit.coding` is its own eval score (0-1) for coding work.
const MIN_CODING_SCORE = 0.6;

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

function baseModelExists(modelID: string): boolean {
  return existsSync(path.join(MODELS_DIR, `${modelID}.toml`));
}

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const AtlaraModel = z
  .object({
    model_id: z.string(),
    /** models.dev lab model id, when Atlara's catalogue states it. */
    models_dev_id: z.string().nullish(),
    capabilities: z.array(z.string()).nullish(),
    context_window: z.number().nullish(),
    deprecated: z.boolean().nullish(),
    price_in_hosted: z.number().nullish(),
    price_out_hosted: z.number().nullish(),
    supported_reasoning_efforts: z.array(z.string()).nullish(),
    task_fit: z.object({ coding: z.number().nullish() }).passthrough().nullish(),
  })
  .passthrough();

export type AtlaraModel = z.infer<typeof AtlaraModel>;

export const AtlaraResponse = z.object({ data: z.array(AtlaraModel) }).passthrough();

// Atlara catalogue id -> models.dev lab model, for rows whose catalogue entry has no models_dev_id.
const BASE_MODEL: Record<string, string> = {
  "Claude-Opus-5.5": "anthropic/claude-opus-5-5",
  "claude-fable-5-1": "anthropic/claude-fable-5-1",
  "sonnet-5.5": "anthropic/claude-sonnet-5-5",
  "claude-haiku-5.5": "anthropic/claude-haiku-5-5",
  "gpt-6-astra": "openai/gpt-6-astra",
  "gpt-6.1-sol": "openai/gpt-6.1-sol",
  "gpt-sol-6.2": "openai/gpt-6.2-sol",
  "gpt-6-1-terra": "openai/gpt-6.1-terra",
  "gpt-6-luna": "openai/gpt-6-luna",
  "gpt-5.5": "openai/gpt-5.5",
  "gemini-4-argon": "google/gemini-4-argon",
  "gemini-3.8-flash": "google/gemini-3.8-flash",
  "gemini-3.7-flash": "google/gemini-3.7-flash",
  "gemini-3.1-pro-preview": "google/gemini-3.1-pro-preview",
  "gemma4:26b": "google/gemma-4-26b-a4b-it",
  "grok-4.6": "xai/grok-4.6",
  kimi3: "moonshotai/kimi-k3",
  "GLM-5.3": "zhipuai/glm-5.3",
  "DeepSeek-V4.1-Flash": "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "qwen/qwen3.8-27b": "alibaba/qwen3.8-27b",
  "qwen3.5:122b": "alibaba/qwen3.5-122b-a10b",
  "qwen3.6:35b": "alibaba/qwen3.6-35b-a3b",
  "qwen3-coder:30b": "alibaba/qwen3-coder-30b-a3b-instruct",
  "NVIDIA-Nemotron-3-Ultra-550B-A55B": "nvidia/nemotron-3-ultra-550b-a55b",
  "muse-glimmer": "meta/muse-glimmer-30b",
  "mistralai/Devstral-Small-2-24B-Instruct-2512": "mistral/devstral-small-2",
};

// "auto" is Atlara's router, not a catalogue row: it is kept as a full file of its own.
const AUTO_ID = "auto";

function listed(model: AtlaraModel): boolean {
  const capabilities = model.capabilities ?? [];
  return (
    model.deprecated !== true &&
    capabilities.includes("chat") &&
    capabilities.includes("tool_use") &&
    (model.price_in_hosted ?? 0) > 0 &&
    (model.price_out_hosted ?? 0) > 0 &&
    (model.task_fit?.coding ?? 0) >= MIN_CODING_SCORE
  );
}

function baseModel(model: AtlaraModel): string | undefined {
  const id = model.models_dev_id ?? BASE_MODEL[model.model_id];
  return id !== undefined && baseModelExists(id) ? id : undefined;
}

// Atlara forwards reasoning_effort only at the levels it lists for the model and drops it
// otherwise, so a reasoning model with no listed levels has no caller control.
// Listed levels decide on their own: a model can have them without Atlara's coarse "reasoning" tag.
function reasoningOptions(model: AtlaraModel): SyncedModel["reasoning_options"] {
  const values = REASONING_EFFORTS.filter((effort) => model.supported_reasoning_efforts?.includes(effort));
  if (values.length > 0) return [{ type: "effort", values }];
  return (model.capabilities ?? []).includes("reasoning") ? [] : undefined;
}

const AUTO: SyncedV2Model = {
  id: AUTO_ID,
  header: [
    '# Atlara\'s router: "auto" picks a model per request from the workspace\'s enabled models, so tools,',
    "# images and reasoning depend on the model it picks (https://cloud.atlara.ai/docs).",
    "# Billed at the picked model's hosted price; no price of its own.",
  ].join("\n"),
  v2: {
    schema: 2,
    name: "Atlara Auto",
    description: "Router that picks an Atlara model for each request",
    family: "auto",
    open_weights: false,
    release_date: "2026-06-19",
    modalities: { input: ["text", "image/png", "image/jpeg", "image/webp"], output: ["text"] },
    capabilities: { tools: { supported: true }, reasoning: { supported: true }, temperature: true },
    limit: { context: 200_000, output: 32_000 },
  },
};

type Source = AtlaraModel | { model_id: typeof AUTO_ID; auto: true };

export const atlaraCloud = {
  id: "atlara-cloud",
  name: "Atlara Cloud",
  modelsDir: "providers/atlara-cloud/models",
  deleteMissing: true,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Atlara request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const models: Source[] = AtlaraResponse.parse(raw).data.filter(listed);
    return [{ model_id: AUTO_ID, auto: true }, ...models];
  },
  // A listed model whose lab model models.dev lacks gets a missing-model issue.
  missingModelID(model) {
    return "auto" in model ? undefined : model.model_id;
  },
  translateModel(model, context) {
    if ("auto" in model) return AUTO;
    const base = context.existing(model.model_id)?.base_model ?? baseModel(model);
    if (base === undefined) return undefined;
    const existing = context.existing(model.model_id);
    const context_window = model.context_window ?? existing?.limit?.context;
    const limit = context_window === undefined
      ? undefined
      // Atlara states no output limit: the lab model's stays unless a file already overrides it.
      : { context: context_window, input: existing?.limit?.input, output: existing?.limit?.output };
    return {
      id: model.model_id,
      model: factorBaseModel(
        base,
        {
          reasoning_options: reasoningOptions(model),
          limit,
          cost: { input: model.price_in_hosted!, output: model.price_out_hosted! },
        },
        limit,
        existing?.base_model_omit,
      ),
    };
  },
} satisfies SyncProvider<Source>;
