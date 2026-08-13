import { z } from "zod";

import type { SyncedFullModel, SyncProvider, SyncedModel } from "../index.js";
import {
  factorBaseModel,
  resolveModelMetadataBaseModel,
} from "./openrouter.js";

const API_ENDPOINT = "https://router.nexforce.ai/v1/models";

/**
 * Catalog IDs that do not match their canonical metadata filename but describe
 * the same underlying model. Nexforce serves the branded/streamlined ids;
 * metadata resolution maps them onto the canonical file.
 */
const NEXFORCE_BASE_MODEL_OVERRIDES = {
  "google/gemma-4-26b": "google/gemma-4-26b-a4b-it",
  "meta-llama/llama-3.3-70b": "meta/llama-3.3-70b-instruct",
  "meta-llama/llama-4-scout-17b": "meta/llama-4-scout-17b-instruct",
  "mistralai/mistral-small-3.1-24b": "mistral/mistral-small-3-1-24b-instruct-2503",
  "nvidia/nemotron-3-120b": "nvidia/nemotron-3-super-120b-a12b",
} as const;

/**
 * Reasoning controls per canonical model, mirroring the underlying model's
 * OpenAI-compatible surface (first-party labs and same-surface relays:
 * provider files for deepseek/alibaba/zhipuai/moonshotai/google, OpenRouter and
 * FastRouter for the OpenAI-compat relay surface). Nexforce passes chat
 * completion parameters through to the upstream model.
 */
const REASONING_OPTIONS: Record<string, SyncedFullModel["reasoning_options"]> = {
  "anthropic/claude-fable-5": [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  "anthropic/claude-haiku-4-5": [{ type: "budget_tokens", min: 1_024 }],
  "anthropic/claude-haiku-4-5-20251001": [{ type: "budget_tokens", min: 1_024 }],
  "anthropic/claude-opus-4-5": [{ type: "effort", values: ["low", "medium", "high"] }, { type: "budget_tokens", min: 1_024 }],
  "anthropic/claude-opus-4-5-20251101": [{ type: "effort", values: ["low", "medium", "high"] }, { type: "budget_tokens", min: 1_024 }],
  "anthropic/claude-opus-4-6": [{ type: "effort", values: ["low", "medium", "high", "max"] }, { type: "budget_tokens", min: 1_024 }],
  "anthropic/claude-opus-4-7": [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  "anthropic/claude-opus-4-8": [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  "anthropic/claude-opus-5": [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  "anthropic/claude-sonnet-4-5": [{ type: "budget_tokens", min: 1_024 }],
  "anthropic/claude-sonnet-4-5-20250929": [{ type: "budget_tokens", min: 1_024 }],
  "anthropic/claude-sonnet-4-6": [{ type: "effort", values: ["low", "medium", "high", "max"] }, { type: "budget_tokens", min: 1_024 }],
  "anthropic/claude-sonnet-5": [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  "deepseek/deepseek-v4-flash": [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
  "deepseek/deepseek-v4-pro": [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
  "deepseek/deepseek-r1-distill-32b": [],
  "google/deep-research-max-preview-04-2026": [],
  "google/deep-research-preview-04-2026": [],
  "google/gemini-2.5-computer-use-preview-10-2025": [],
  "google/gemini-2.5-flash": [{ type: "toggle" }, { type: "budget_tokens", min: 0, max: 24_576 }],
  "google/gemini-2.5-flash-image": [],
  "google/gemini-2.5-flash-lite": [{ type: "toggle" }, { type: "budget_tokens", min: 512, max: 24_576 }],
  "google/gemini-2.5-pro": [{ type: "budget_tokens", min: 128, max: 32_768 }],
  "google/gemini-3-flash-preview": [{ type: "toggle" }, { type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "google/gemini-3-pro-image": [],
  "google/gemini-3-pro-image-preview": [],
  "google/gemini-3.1-flash-image": [{ type: "toggle" }, { type: "effort", values: ["minimal", "high"] }],
  "google/gemini-3.1-flash-image-preview": [{ type: "toggle" }, { type: "effort", values: ["minimal", "high"] }],
  "google/gemini-3.1-flash-lite": [{ type: "toggle" }, { type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "google/gemini-3.1-flash-lite-image": [{ type: "toggle" }, { type: "effort", values: ["minimal", "high"] }],
  "google/gemini-3.1-flash-lite-preview": [{ type: "toggle" }, { type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "google/gemini-3.1-pro-preview": [{ type: "effort", values: ["low", "medium", "high"] }],
  "google/gemini-3.1-pro-preview-customtools": [{ type: "effort", values: ["low", "medium", "high"] }],
  "google/gemini-3.5-flash": [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "google/gemini-3.5-flash-lite": [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "google/gemini-3.6-flash": [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "google/gemini-flash-latest": [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "google/gemini-flash-lite-latest": [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "google/gemini-robotics-er-1.6-preview": [{ type: "toggle" }, { type: "budget_tokens", min: 0 }],
  "google/gemma-4-26b-a4b-it": [{ type: "toggle" }],
  "minimax/MiniMax-M2": [],
  "minimax/MiniMax-M2.1": [],
  "minimax/MiniMax-M2.1-highspeed": [],
  "minimax/MiniMax-M2.5": [],
  "minimax/MiniMax-M2.5-highspeed": [],
  "minimax/MiniMax-M2.7": [],
  "minimax/MiniMax-M2.7-highspeed": [],
  "minimax/MiniMax-M3": [{ type: "toggle" }],
  "moonshotai/kimi-k2.5": [{ type: "toggle" }],
  "moonshotai/kimi-k2.6": [{ type: "toggle" }],
  "moonshotai/kimi-k2.7-code": [],
  "moonshotai/kimi-k2.7-code-highspeed": [],
  "moonshotai/kimi-k3": [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
  "nvidia/nemotron-3-super-120b-a12b": [],
  "openai/gpt-5": [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "openai/gpt-5-mini": [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "openai/gpt-5-nano": [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "openai/gpt-5-pro": [{ type: "effort", values: ["high"] }],
  "openai/gpt-5.1": [{ type: "effort", values: ["none", "low", "medium", "high"] }],
  "openai/gpt-5.2": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "openai/gpt-5.2-chat-latest": [{ type: "effort", values: ["medium"] }],
  "openai/gpt-5.2-pro": [{ type: "effort", values: ["medium", "high", "xhigh"] }],
  "openai/gpt-5.3-codex": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "openai/gpt-5.3-codex-spark": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "openai/gpt-5.4": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "openai/gpt-5.4-mini": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "openai/gpt-5.4-nano": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "openai/gpt-5.4-pro": [{ type: "effort", values: ["medium", "high", "xhigh"] }],
  "openai/gpt-5.5": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "openai/gpt-5.5-pro": [{ type: "effort", values: ["medium", "high", "xhigh"] }],
  "openai/gpt-5.6": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
  "openai/gpt-5.6-luna": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
  "openai/gpt-5.6-sol": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
  "openai/gpt-5.6-terra": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
  "openai/o1": [{ type: "effort", values: ["low", "medium", "high"] }],
  "openai/o1-pro": [{ type: "effort", values: ["low", "medium", "high"] }],
  "openai/o3": [{ type: "effort", values: ["low", "medium", "high"] }],
  "openai/o3-mini": [{ type: "effort", values: ["low", "medium", "high"] }],
  "openai/o3-pro": [{ type: "effort", values: ["low", "medium", "high"] }],
  "openai/o4-mini": [{ type: "effort", values: ["low", "medium", "high"] }],
  "xai/grok-4.20-0309-reasoning": [],
  "xai/grok-4.20-multi-agent-0309": [],
  "xai/grok-4.3": [{ type: "effort", values: ["none", "low", "medium", "high"] }],
  "xai/grok-4.5": [{ type: "effort", values: ["low", "medium", "high"] }],
  "xai/grok-build-0.1": [],
  "zhipuai/glm-4.5": [{ type: "toggle" }],
  "zhipuai/glm-4.5-air": [{ type: "toggle" }],
  "zhipuai/glm-4.5-flash": [{ type: "toggle" }],
  "zhipuai/glm-4.5v": [{ type: "toggle" }],
  "zhipuai/glm-4.6": [{ type: "toggle" }],
  "zhipuai/glm-4.6v": [{ type: "toggle" }],
  "zhipuai/glm-4.7": [{ type: "toggle" }],
  "zhipuai/glm-4.7-flash": [{ type: "toggle" }],
  "zhipuai/glm-4.7-flashx": [{ type: "toggle" }],
  "zhipuai/glm-5": [{ type: "toggle" }],
  "zhipuai/glm-5-turbo": [{ type: "toggle" }],
  "zhipuai/glm-5.1": [{ type: "toggle" }],
  "zhipuai/glm-5.2": [{ type: "effort", values: ["high", "max"] }],
  "alibaba/qwen3-30b": [{ type: "toggle" }],
  "alibaba/qwq-32b": [],
};

const NexforceArchitecture = z
  .object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  })
  .passthrough()
  .optional();

export const NexforceModel = z
  .object({
    id: z.string().min(1),
    object: z.literal("model"),
    kind: z.literal("chat").or(z.literal("embedding")),
    name: z.string().min(1).optional(),
    created: z.number().int().nonnegative(),
    context_length: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    architecture: NexforceArchitecture,
  })
  .passthrough();

export const NexforceResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(NexforceModel),
  })
  .passthrough();

export type NexforceModel = z.infer<typeof NexforceModel>;

export const nexforce = {
  id: "nexforce",
  name: "Nexforce",
  modelsDir: "providers/nexforce/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(
        `Nexforce models request failed: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  },
  parseModels(raw) {
    return NexforceResponse.parse(raw).data;
  },
  translateModel(model, context) {
    // Embeddings are served on a separate endpoint and are not chat models.
    if (model.kind !== "chat") return undefined;

    const canonical = resolveNexforceBaseModel(model.id);
    if (canonical === undefined) {
      // Host-only surfaces (e.g. `nexforce/smart-route`) stay hand-authored.
      const authored = context.authored(model.id);
      return authored === undefined
        ? undefined
        : { id: model.id, model: authored as SyncedModel };
    }

    const existing = context.existing(model.id);
    const limit = {
      context: model.context_length,
      output: model.max_output_tokens,
    };
    const values = {
      name: model.name,
      reasoning_options:
        REASONING_OPTIONS[canonical] ?? existing?.reasoning_options,
      limit,
      modalities: model.architecture === undefined
        ? undefined
        : {
            input: modalities(model.architecture.input_modalities),
            output: modalities(model.architecture.output_modalities),
          },
    };

    return {
      id: model.id,
      model: factorBaseModel(canonical, values, limit),
    };
  },
} satisfies SyncProvider<NexforceModel>;

export function resolveNexforceBaseModel(id: string) {
  const override = NEXFORCE_BASE_MODEL_OVERRIDES[
    id as keyof typeof NEXFORCE_BASE_MODEL_OVERRIDES
  ];
  return override ?? resolveModelMetadataBaseModel(id);
}

function modalities(values: string[]): SyncedFullModel["modalities"]["input"] {
  const allowed = new Set(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is SyncedFullModel["modalities"]["input"][number] =>
      allowed.has(value),
    );
  return [...new Set(result)];
}