import path from "node:path";
import { readdirSync } from "node:fs";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import { ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";

const MODELS_INFO_ENDPOINT = "https://api.tensorx.ai/v1/model/info";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// TensorX /v1/model/info prices are USD per-token; the catalog cost is USD
// per-million tokens.
const PER_TOKEN_TO_PER_MILLION = 1_000_000;

const TensorxModelInfo = z
  .object({
    mode: z.string().nullish(),
    max_input_tokens: z.number().nullish(),
    max_output_tokens: z.number().nullish(),
    max_tokens: z.number().nullish(),
    supports_reasoning: z.boolean().nullish(),
    supports_function_calling: z.boolean().nullish(),
    supports_tool_choice: z.boolean().nullish(),
    supports_vision: z.boolean().nullish(),
    supports_prompt_caching: z.boolean().nullish(),
    input_cost_per_token: z.number().nullish(),
    output_cost_per_token: z.number().nullish(),
    cache_read_input_token_cost: z.number().nullish(),
    cache_creation_input_token_cost: z.number().nullish(),
    supported_openai_params: z.array(z.string()).nullish(),
  })
  .passthrough();

export const TensorxModel = z
  .object({
    model_name: z.string(),
    model_info: TensorxModelInfo.optional(),
  })
  .passthrough();

export const TensorxResponse = z
  .object({
    data: z.array(TensorxModel),
  })
  .passthrough();

type TensorxSourceModel = {
  id: string;
  mode: string | undefined;
  maxInput: number | undefined;
  maxOutput: number | undefined;
  reasoning: boolean;
  toolCall: boolean;
  vision: boolean;
  inputCost: number | undefined;
  outputCost: number | undefined;
  cacheRead: number | undefined;
};

type Modality = "text" | "audio" | "image" | "video" | "pdf";

// TensorX /v1/model/info exposes only a `supports_reasoning` boolean — not the
// control shape (toggle vs effort) nor the accepted effort levels. Those are
// host-specific and can't be derived from the API, so they are maintained here,
// keyed by TensorX model id. Models not in this map rely on the authored
// reasoning_options already on disk; a brand-new reasoner with no entry is
// skipped (MissingReasoningOptionsError) rather than written without controls.
const REASONING_OPTIONS_BY_ID: Record<string, NonNullable<SyncedFullModel["reasoning_options"]>> = {
  "z-ai/glm-5.3": [{ type: "effort", values: ["low", "high", "max"] }],
  "z-ai/glm-5.3-flash": [{ type: "effort", values: ["low", "high", "max"] }],
  "z-ai/glm-5": [{ type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] }],
  "z-ai/glm-5.1": [
    { type: "toggle" },
    { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  ],
  "z-ai/glm-5.2": [
    { type: "toggle" },
    { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  ],
  "z-ai/glm-5-turbo": [
    { type: "toggle" },
    { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  ],
  "z-ai/glm-5v-turbo": [
    { type: "toggle" },
    { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  ],
  "qwen/qwen3.8-2.4t-a95b": [{ type: "effort", values: ["low", "medium", "xhigh"] }],
  "qwen/qwen3.8-27b": [{ type: "effort", values: ["low", "medium", "xhigh"] }],
  "qwen/qwen3.8-flash-next": [{ type: "effort", values: ["low", "medium", "xhigh"] }],
  "qwen/qwen3.5-122b-a10b": [{ type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] }],
  "qwen/qwen3.5-9b": [{ type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] }],
  "deepseek/deepseek-r1-0528": [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh", "max"] }],
  "deepseek/deepseek-v3.2": [{ type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] }],
  "deepseek/deepseek-v4.1-flash": [{ type: "toggle" }],
  "deepseek/deepseek-v4-flash-0731": [{ type: "toggle" }],
  "deepseek/deepseek-v4-pro": [{ type: "toggle" }],
  "deepseek/deepseek-v4-pro-0813": [{ type: "toggle" }],
  "moonshotai/kimi-k2.6": [{ type: "toggle" }],
  "moonshotai/kimi-k2.7-code": [{ type: "toggle" }],
  "moonshotai/kimi-k3": [{ type: "toggle" }],
  "minimax/minimax-m3": [{ type: "toggle" }],
  "minimax/minimax-m2.5": [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh", "max"] }],
};

// TensorX uses its own vendor prefixes that differ from the catalog lab ids.
// Orgs absent from this map are resolved as identity (e.g. openai, nvidia),
// so identity labs already on disk keep receiving API cost/limit updates.
const LAB_PREFIX_MAP: Record<string, string> = {
  "z-ai": "zhipuai",
  qwen: "alibaba",
  deepseek: "deepseek",
  moonshotai: "moonshotai",
  minimax: "minimax",
};

const baseModelCache = new Map<string, string | null>();

function resolveLabModelID(modelID: string): string | undefined {
  const cached = baseModelCache.get(modelID);
  if (cached !== undefined) return cached ?? undefined;

  const [org, ...parts] = modelID.split("/");
  if (org === undefined || parts.length === 0) return undefined;
  const mapped = LAB_PREFIX_MAP[org] ?? org;

  let labDir: string | undefined;
  try {
    const dirs = readdirSync(MODELS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    labDir = dirs.find((dir) => dir.toLowerCase() === mapped.toLowerCase());
  } catch {
    return undefined;
  }
  if (labDir === undefined) return undefined;

  const modelSlug = parts.join("/");
  const expected = `${modelSlug}.toml`.toLowerCase();
  let fileMatch: string | undefined;
  try {
    fileMatch = readdirSync(path.join(MODELS_DIR, labDir))
      .filter((file) => file.endsWith(".toml"))
      .find((file) => file.toLowerCase() === expected);
  } catch {
    // fall through
  }

  const resolved = fileMatch === undefined ? undefined : `${labDir}/${fileMatch.slice(0, -".toml".length)}`;
  baseModelCache.set(modelID, resolved ?? null);
  return resolved;
}

function normalizeModel(model: TensorxSourceModel, existing: ExistingModel | undefined): SyncedModel {
  const factorBase = resolveLabModelID(model.id);
  const reasoning = model.reasoning;
  const reasoningOptions = reasoning
    ? (REASONING_OPTIONS_BY_ID[model.id] ?? existing?.reasoning_options)
    : undefined;
  const toolCall = model.toolCall;
  const vision = model.vision;
  const cost = model.inputCost !== undefined && model.outputCost !== undefined
    ? {
        input: model.inputCost,
        output: model.outputCost,
        cache_read: model.cacheRead ?? existing?.cost?.cache_read,
        cache_write: existing?.cost?.cache_write,
      }
    : existing?.cost;
  const limit = {
    context: model.maxInput ?? existing?.limit?.context,
    output: model.maxOutput ?? existing?.limit?.output,
  };
  const inlineLimit: NonNullable<SyncedFullModel["limit"]> = {
    context: limit.context ?? 0,
    output: limit.output ?? 0,
  };

  if (factorBase !== undefined) {
    return factorBaseModel(
      factorBase,
      {
        attachment: vision === true ? true : undefined,
        reasoning: reasoning ? true : undefined,
        reasoning_options: reasoningOptions,
        tool_call: toolCall,
        limit,
        cost,
      },
      limit,
      existing?.base_model === factorBase ? existing.base_model_omit : undefined,
    );
  }

  const name = existing?.name ?? model.id.split("/").at(-1) ?? model.id;
  const inlineReasoning = reasoning;
  const family = existing?.family ?? inferFamily(model.id, name);
  const textOnly: { input: Modality[]; output: Modality[] } = { input: ["text"], output: ["text"] };
  return {
    name,
    description:
      existing?.description ??
      describeModel({
        id: model.id,
        providerId: "tensorx",
        name,
        family,
        reasoning: inlineReasoning,
        tool_call: toolCall,
        structured_output: false,
        open_weights: true,
        modalities: textOnly,
      }),
    family,
    attachment: vision === true,
    reasoning: inlineReasoning,
    reasoning_options: reasoningOptions,
    tool_call: toolCall,
    temperature: existing?.temperature ?? true,
    release_date: existing?.release_date ?? new Date().toISOString().slice(0, 10),
    last_updated: existing?.last_updated ?? new Date().toISOString().slice(0, 10),
    open_weights: true,
    knowledge: existing?.knowledge,
    cost,
    limit: inlineLimit,
    modalities: textOnly,
  };
}

function inferFamily(modelID: string, name: string): SyncedFullModel["family"] {
  const target = `${modelID} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const escaped = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") {
        return new RegExp(`(^|[^a-z0-9])${escaped}(?=\\d|$|[^a-z0-9])`).test(target);
      }
      return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`).test(target);
    });
}

// Toggle wire path per model id; models absent here use the DeepSeek/Kimi
// `chat_template_kwargs.thinking` path.
const TOGGLE_WIRE_BY_ID: Record<string, string> = {
  "z-ai/glm-5.1": "enable_thinking",
  "z-ai/glm-5.2": "enable_thinking",
  "z-ai/glm-5-turbo": "enable_thinking",
  "z-ai/glm-5v-turbo": "enable_thinking",
  "minimax/minimax-m3": "thinking_mode",
};

function reasoningHeader(modelID: string, model: SyncedModel): string | undefined {
  const options = model.reasoning_options;
  if (options === undefined || options.length === 0) return undefined;
  const lines: string[] = [];
  for (const option of options) {
    if (option.type === "toggle") {
      const field = TOGGLE_WIRE_BY_ID[modelID] ?? "thinking";
      lines.push(`# Toggle: chat_template_kwargs.${field} = true | false`);
    }
    if (option.type === "effort") {
      const values = option.values.map((value) => `"${value}"`).join(" | ");
      lines.push(`# Effort: reasoning_effort = ${values}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : undefined;
}

export const tensorx = {
  id: "tensorx",
  name: "TensorX",
  modelsDir: "providers/tensorx/models",
  // /v1/model/info is authoritative for what this host serves; models that
  // disappear from it are removed rather than retained as live-looking routes.
  deleteMissing: true,
  preserveBaseModels: false,
  preserveDescriptions: false,
  authoritativeHeaders: true,
  async fetchModels() {
    const apiKey = process.env.TENSORX_API_KEY;
    if (!apiKey) {
      throw new Error("TENSORX_API_KEY is required to sync the TensorX provider");
    }
    const response = await fetch(MODELS_INFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`TensorX request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw: unknown): TensorxSourceModel[] {
    const seen = new Set<string>();
    const models: TensorxSourceModel[] = [];
    for (const entry of TensorxResponse.parse(raw).data) {
      // The endpoint can return multiple rows per model; dedupe by id.
      if (seen.has(entry.model_name)) continue;
      seen.add(entry.model_name);
      const info = entry.model_info ?? {};
      // Only sync chat models; embeddings and audio routes are not catalog targets.
      if (info.mode !== "chat") continue;
      models.push({
        id: entry.model_name,
        mode: info.mode,
        maxInput: info.max_input_tokens ?? undefined,
        maxOutput: info.max_output_tokens ?? undefined,
        reasoning: info.supports_reasoning === true,
        toolCall: info.supports_function_calling === true || info.supports_tool_choice === true,
        vision: info.supports_vision === true,
        inputCost: info.input_cost_per_token == null
          ? undefined
          : Math.round(info.input_cost_per_token * PER_TOKEN_TO_PER_MILLION * 1_000_000) / 1_000_000,
        outputCost: info.output_cost_per_token == null
          ? undefined
          : Math.round(info.output_cost_per_token * PER_TOKEN_TO_PER_MILLION * 1_000_000) / 1_000_000,
        cacheRead: info.cache_read_input_token_cost == null
          ? undefined
          : Math.round(info.cache_read_input_token_cost * PER_TOKEN_TO_PER_MILLION * 1_000_000) / 1_000_000,
      });
    }
    if (models.length === 0) {
      throw new Error("TensorX returned no chat models; refusing destructive sync");
    }
    return models;
  },
  translateModel(model: TensorxSourceModel, context) {
    const existing = context.existing(model.id);
    const authored = context.authored(model.id);
    const factorBase = resolveLabModelID(model.id);
    if (factorBase === undefined && (existing === undefined || authored?.base_model !== undefined)) {
      return undefined;
    }
    const built = normalizeModel(model, existing);
    // A brand-new reasoner has no authored controls to inherit and no API
    // signal for the correct control shape; require a REASONING_OPTIONS_BY_ID
    // entry before writing a reasoning=true file that would fail validation.
    if (
      existing === undefined
      && built.reasoning === true
      && built.reasoning_options === undefined
    ) {
      throw new MissingReasoningOptionsError(
        model.id,
        "TensorX /v1/model/info only reports supports_reasoning (no control shape or effort levels); add an entry to REASONING_OPTIONS_BY_ID in providers/tensorx.ts, then re-sync",
      );
    }
    return {
      id: model.id,
      model: built,
      header: reasoningHeader(model.id, built),
    };
  },
  sourceID(model: TensorxSourceModel) {
    return model.id;
  },
  missingModelID(model: TensorxSourceModel) {
    return model.id;
  },
  missingNotice(paths: string[]) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local model(s) deleted after being removed from the TensorX API: ${paths.join(", ")}`,
    ];
  },
  skippedNotice(ids: string[]) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} TensorX model(s) skipped: no provider-agnostic lab metadata to factor onto (add models/<lab>/<model>.toml, then re-sync): ${ids.join(", ")}`,
    ];
  },
} satisfies SyncProvider<TensorxSourceModel>;