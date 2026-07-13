import { z } from "zod";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://api.anyapi.ai/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const modelMetadataByID = new Map<string, Record<string, unknown>>();

const CANONICAL_PROVIDER_PREFIXES: Record<string, { provider: string; metadata: string }> = {
  anthropic: { provider: "anthropic", metadata: "anthropic" },
  cohere: { provider: "cohere", metadata: "cohere" },
  deepseek: { provider: "deepseek", metadata: "deepseek" },
  google: { provider: "google", metadata: "google" },
  "meta-llama": { provider: "meta", metadata: "meta" },
  minimax: { provider: "minimax", metadata: "minimax" },
  mistralai: { provider: "mistral", metadata: "mistral" },
  mistral: { provider: "mistral", metadata: "mistral" },
  moonshotai: { provider: "moonshotai", metadata: "moonshotai" },
  nvidia: { provider: "nvidia", metadata: "nvidia" },
  openai: { provider: "openai", metadata: "openai" },
  perplexity: { provider: "perplexity", metadata: "perplexity" },
  qwen: { provider: "alibaba", metadata: "alibaba" },
  stepfun: { provider: "stepfun", metadata: "stepfun" },
  tencent: { provider: "tencent", metadata: "tencent" },
  "x-ai": { provider: "xai", metadata: "xai" },
  xai: { provider: "xai", metadata: "xai" },
  xiaomi: { provider: "xiaomi", metadata: "xiaomi" },
  "z-ai": { provider: "zhipuai", metadata: "zhipuai" },
  morph: { provider: "morph", metadata: "morph" },
  inception: { provider: "inception", metadata: "inception" },
};

function loadModelMetadata() {
  if (modelMetadataByID.size > 0) return;
  const entries = readdirSync(MODELS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const providerDir = path.join(MODELS_DIR, entry.name);
    const files = readdirSync(providerDir);
    for (const file of files) {
      if (!file.endsWith(".toml")) continue;
      const modelID = entry.name + "/" + file.replace(".toml", "");
      modelMetadataByID.set(modelID, {});
    }
  }
}

function normalizeModelName(provider: string, model: string): string {
  if (provider === "anthropic") {
    return model.replace(/^([a-z]+-[a-z]+-)(\d+)\.(\d+)/, "$1$2-$3");
  }
  return model;
}

const AnyAPIModel = z.object({
  id: z.string(),
});

const AnyAPIResponse = z.object({
  data: z.array(AnyAPIModel.passthrough()),
}).passthrough();

export type AnyAPIModel = z.infer<typeof AnyAPIModel>;

function resolveBaseModel(apiModelID: string): string | undefined {
  const [provider, ...modelParts] = apiModelID.split("/");
  const model = modelParts.join("/");
  const prefix = CANONICAL_PROVIDER_PREFIXES[provider];
  if (!prefix) return undefined;

  loadModelMetadata();
  const cleanModel = model.replace(/:free$/, "");

  // Check overrides first so explicit mappings take priority
  const overrides: Record<string, string> = {
    "anthropic/claude-3-haiku": "anthropic/claude-3-haiku-20240307",
    "anthropic/claude-3.5-haiku": "anthropic/claude-3-5-haiku-20241022",
    "anthropic/claude-3-5-haiku-20241022": "anthropic/claude-3-5-haiku-20241022",
    "anthropic/claude-sonnet-4": "anthropic/claude-sonnet-4-20250514",
    "anthropic/claude-opus-4": "anthropic/claude-opus-4-20250514",
    "deepseek/deepseek-r1": "deepseek/deepseek-reasoner",
    "cohere/command-a": "cohere/command-a-03-2025",
    "cohere/command-r": "cohere/command-r-08-2024",
    "cohere/command-r-plus": "cohere/command-r-plus-08-2024",
    "openai/gpt-3.5-turbo-0613": "openai/gpt-3.5-turbo",
    "openai/gpt-3.5-turbo-16k": "openai/gpt-3.5-turbo",
    "openai/gpt-3.5-turbo-instruct": "openai/gpt-3.5-turbo",
    "openai/gpt-4o-mini-2024-07-18": "openai/gpt-4o-mini",
    "openai/gpt-5-chat": "openai/gpt-5",
    "openai/gpt-5-image": "openai/gpt-5",
    "openai/gpt-5-image-mini": "openai/gpt-5",
    "openai/gpt-5.1-chat": "openai/gpt-5.1",
    "openai/gpt-5.2-chat": "openai/gpt-5.2",
    "openai/gpt-5.4-image-2": "openai/gpt-5.4",
    "openai/gpt-chat-latest": "openai/gpt-5",
    "openai/o3-mini-high": "openai/o3-mini",
    "openai/o4-mini-high": "openai/o4-mini",
    "moonshotai/kimi-k2": "moonshotai/kimi-k2-0711",
    "moonshotai/kimi-k2-0905": "moonshotai/kimi-k2-0905",
    "meta/llama-4-maverick": "meta/llama-4-maverick-17b-instruct",
    "meta/llama-4-scout": "meta/llama-4-scout-17b-instruct",
    "perplexity/sonar-pro-search": "perplexity/sonar-pro",
    "mistral/codestral-2508": "mistral/codestral-latest",
    "mistral/mistral-large-2407": "mistral/mistral-large-2512",
    "mistral/mistral-large-2407-v1": "mistral/mistral-large-2512",
    "mistral/mistral-large-3-675b-instruct": "mistral/mistral-large-2512",
    "mistral/mistral-small-2402": "mistral/mistral-small-2506",
    "mistral/mistral-small-24b-instruct-2501": "mistral/mistral-small-2506",
    "mistral/mistral-large": "mistral/mistral-large-latest",
    "mistral/mistral-medium-3": "mistral/mistral-medium-2505",
    "mistral/mistral-medium-3-5": "mistral/mistral-medium-2508",
    "mistral/ministral-3b-2512": "mistral/ministral-3b-latest",
    "mistral/ministral-8b-2512": "mistral/ministral-8b-latest",
    "mistral/ministral-14b-2512": "mistral/ministral-8b-latest",
    "mistral/mixtral-8x22b-instruct": "mistral/open-mixtral-8x22b",
    "upstage/solar-pro-3": "upstage/solar-pro3",
  };

  const cleanID = provider + "/" + cleanModel;
  if (overrides[cleanID] && modelMetadataByID.has(overrides[cleanID])) return overrides[cleanID];

  // Try direct canonical match
  const normalizedModel = normalizeModelName(provider, cleanModel);
  const canonicalID = prefix.metadata + "/" + normalizedModel;
  if (modelMetadataByID.has(canonicalID)) return canonicalID;

  return undefined;
}

export const anyapi = {
  id: "anyapi",
  name: "AnyAPI",
  modelsDir: "providers/anyapi/models",
  async fetchModels() {
    const key = process.env.ANYAPI_API_KEY;
    if (!key) {
      throw new Error("ANYAPI_API_KEY environment variable is required");
    }
    const response = await fetch(API_ENDPOINT, {
      headers: { Authorization: "Bearer " + key },
    });
    if (!response.ok) {
      throw new Error("AnyAPI request failed: " + response.status + " " + response.statusText);
    }
    return response.json();
  },
  parseModels(raw) {
    return AnyAPIResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const baseModel = resolveBaseModel(model.id);
    if (!baseModel) return undefined;

    const existing = context.existing(model.id);

    const canonFile = path.join(MODELS_DIR, baseModel + ".toml");
    let hasReasoning = false;
    try {
      const content = readFileSync(canonFile, "utf8");
      hasReasoning = /^reasoning\s*=\s*true/m.test(content);
    } catch {}

    const result: any = {
      base_model: baseModel,
      base_model_omit: ["cost"],
    };

    // Preserve hand-authored fields the API is not authoritative for
    if (existing?.interleaved) {
      result.interleaved = existing.interleaved;
    }
    if (existing?.experimental) {
      result.experimental = existing.experimental;
    }
    if (existing?.status !== undefined) {
      result.status = existing.status;
    }

    // Preserve existing reasoning_options, only default to [] for new models
    if (hasReasoning) {
      if (existing?.reasoning_options !== undefined) {
        result.reasoning_options = existing.reasoning_options;
      } else {
        result.reasoning_options = [];
      }
    }

    return { id: model.id, model: result as SyncedModel };
  },
} satisfies SyncProvider<AnyAPIModel>;
