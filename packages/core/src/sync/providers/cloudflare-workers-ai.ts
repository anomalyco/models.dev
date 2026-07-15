import { z } from "zod";
import { readdirSync } from "node:fs";
import path from "node:path";

import type { ExistingModel, SyncedModel, SyncProvider } from "../index.js";
import {
  buildOpenRouterModel,
  OpenRouterModel,
  OpenRouterResponse,
} from "./openrouter.js";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const metadataFilesByPublisher = new Map<string, string[]>();
const METADATA_PUBLISHERS: Record<string, string> = {
  "deepseek-ai": "deepseek",
  google: "google",
  meta: "meta",
  mistralai: "mistral",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  openai: "openai",
  qwen: "alibaba",
  "zai-org": "zhipuai",
};

const CloudflareOpenRouterResponse = z.object({
  result: z.union([OpenRouterResponse, z.array(OpenRouterModel)]).optional(),
  result_info: z.object({
    page: z.number().optional(),
    total_pages: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

const CloudflareModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  hugging_face_id: z.string().nullable().optional(),
  context_length: z.number(),
  max_output_length: z.number().nullable().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    internal_reasoning: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }),
  supported_features: z.array(z.string()).optional(),
  supported_sampling_parameters: z.array(z.string()).optional(),
}).passthrough();

const CloudflareResponse = z.object({
  data: z.array(CloudflareModel),
}).passthrough();

type CloudflareModel = z.infer<typeof CloudflareModel>;

// Native `ai/models/search` shape (no `format` param). Everything schema-relevant
// lives in the sparse `properties[]` array; see `flattenProperties`.
const NativeModel = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  task: z.object({ name: z.string() }),
  created_at: z.string(),
  properties: z.array(
    z.object({
      property_id: z.string(),
      value: z.unknown(),
    }),
  ),
});

const NativeResponse = z.object({
  result: z.array(NativeModel),
}).passthrough();

// The merged fetch result: every openrouter-format model, every native-format model,
// tagged so `parseModels`/`translateModel` know which reshape path to take.
const WorkersAiFetchResultSchema = z.object({
  openrouter: z.array(CloudflareModel),
  native: z.array(NativeModel),
});
type WorkersAiFetchResult = z.infer<typeof WorkersAiFetchResultSchema>;

type WorkersAiSourceModel =
  | { format: "openrouter"; model: CloudflareModel }
  | { format: "native"; model: NativeModel };
export type NativeModel = z.infer<typeof NativeModel>;

const NativePrice = z.object({
  unit: z.string(),
  price: z.number(),
  currency: z.string(),
});

type TaskModality = "text" | "audio" | "image" | "video" | "pdf";

// task.name -> modalities. Covers all 10 native task classes observed on the
// `ai/models/search` endpoint (see the plan this leaf inherits from).
export const TASK_MODALITIES: Record<string, { input: TaskModality[]; output: TaskModality[] }> = {
  "Text Generation": { input: ["text"], output: ["text"] },
  "Text Embeddings": { input: ["text"], output: ["text"] },
  "Text Classification": { input: ["text"], output: ["text"] },
  Translation: { input: ["text"], output: ["text"] },
  Summarization: { input: ["text"], output: ["text"] },
  "Automatic Speech Recognition": { input: ["audio"], output: ["text"] },
  "Text-to-Speech": { input: ["text"], output: ["audio"] },
  "Image-to-Text": { input: ["image", "text"], output: ["text"] },
  "Text-to-Image": { input: ["text"], output: ["image"] },
  "Image Classification": { input: ["image"], output: ["text"] },
  "Dumb Pipe": { input: ["audio"], output: ["text"] },
};

// Native price is per-MILLION tokens; `price()` in openrouter.ts multiplies its
// string input by 1e6, so divide by 1e6 here to round-trip to the same per-token cost.
function tokenPriceString(amount: number) {
  return String(amount / 1_000_000);
}

function tokenSidePrice(amount: number | undefined, sibling: number | undefined) {
  if (amount !== undefined) return tokenPriceString(amount);
  return sibling !== undefined ? "0" : "-1";
}

export function flattenProperties(model: NativeModel): Record<string, unknown> {
  return Object.fromEntries(model.properties.map((property) => [property.property_id, property.value]));
}

function parsePrices(value: unknown): z.infer<typeof NativePrice>[] {
  const parsed = z.array(NativePrice).safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function reshapeNative(model: NativeModel): OpenRouterModel {
  const properties = flattenProperties(model);
  const modalities = TASK_MODALITIES[model.task.name];
  if (modalities === undefined) {
    throw new Error(`Unknown Cloudflare Workers AI native task: ${model.task.name}`);
  }

  // Neither API shape reports an output-token limit or open-weights status for any
  // model; fabricating them (0 / false) rather than skipping the model matches this
  // codebase's existing practice for a provider that doesn't report a required field
  // (see e.g. digitalocean.ts, chutes.ts, wandb.ts for output; chutes/digitalocean/
  // pioneer/llmgateway/vercel for open_weights).
  const contextWindow = typeof properties.context_window === "string"
    ? Number(properties.context_window)
    : undefined;

  const prices = parsePrices(properties.price);
  const tokenPrice = (unit: string) => prices.find((entry) => entry.unit === unit)?.price;
  const inputTokenPrice = tokenPrice("per M input tokens");
  const outputTokenPrice = tokenPrice("per M output tokens");
  const cachedInputTokenPrice = tokenPrice("per M cached input tokens");

  const supported_parameters: string[] = [];
  if (properties.function_calling === "true") supported_parameters.push("tools", "tool_choice");
  if (properties.reasoning === "true") supported_parameters.push("reasoning");

  // Native has no separate display name (unlike openrouter's "Publisher: Model"); the
  // slug in `name` is the only human-readable identifier available.
  const record: OpenRouterModel = {
    id: model.name,
    name: model.name,
    created: Math.floor(new Date(`${model.created_at.replace(" ", "T")}Z`).getTime() / 1000),
    hugging_face_id: null,
    knowledge_cutoff: null,
    context_length: contextWindow ?? 0,
    architecture: { input_modalities: modalities.input, output_modalities: modalities.output },
    pricing: {
      // Absent token pricing (audio/image-priced or free models) is deliberately left
      // unfabricated: "-1" mirrors OpenRouter's own unavailable-price sentinel and keeps
      // `price()` from inventing a false token cost. When only one side of a token
      // price pair is present (e.g. an embeddings model has no output tokens), the
      // other side is a real "0", not a fabrication -- there is nothing to bill.
      prompt: tokenSidePrice(inputTokenPrice, outputTokenPrice),
      completion: tokenSidePrice(outputTokenPrice, inputTokenPrice),
      input_cache_read: cachedInputTokenPrice !== undefined ? tokenPriceString(cachedInputTokenPrice) : undefined,
    },
    top_provider: {
      context_length: contextWindow ?? 0,
      max_completion_tokens: null,
    },
    supported_parameters,
  };

  return record;
}

// Audio/1k-character pricing (ASR, TTS) is outside the token-priced OpenRouter
// shape and must be applied to the built model after `buildWorkersAiModel`.
// Image-priced units (`per step`, `per 512 by 512 tile`, `per inference request`)
// and no-price models are left untouched: no token cost is invented for them.
export function applyAudioPricing(model: SyncedModel, native: NativeModel): SyncedModel {
  const modalities = TASK_MODALITIES[native.task.name];
  const prices = parsePrices(flattenProperties(native).price);
  const inputAudio = prices.find((entry) => entry.unit === "per audio minute")?.price
    ?? prices.find((entry) => entry.unit === "per audio minute (websocket)")?.price;
  const outputAudio = prices.find((entry) => entry.unit === "per audio minute")?.price
    ?? prices.find((entry) => entry.unit === "per 1k characters")?.price;

  if (modalities?.input.includes("audio") && inputAudio !== undefined) {
    return {
      ...model,
      cost: { input: 0, output: 0, ...model.cost, input_audio: inputAudio },
    } as SyncedModel;
  }
  if (modalities?.output.includes("audio") && outputAudio !== undefined) {
    return {
      ...model,
      cost: { input: 0, output: 0, ...model.cost, output_audio: outputAudio },
    } as SyncedModel;
  }
  return model;
}

export const cloudflareWorkersAi = {
  id: "cloudflare-workers-ai",
  name: "Cloudflare Workers AI",
  modelsDir: "providers/cloudflare-workers-ai/models",
  async fetchModels(): Promise<WorkersAiFetchResult> {
    const accountID = process.env.CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN;
    if (accountID === undefined || token === undefined) {
      throw new Error(
        "Cloudflare Workers AI sync requires CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID and CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN",
      );
    }

    const [openrouter, native] = await Promise.all([
      fetchAllOpenRouterModels(accountID, token),
      fetchAllNativeModels(accountID, token),
    ]);

    return { openrouter, native };
  },
  parseModels(raw) {
    const { openrouter, native } = WorkersAiFetchResultSchema.parse(raw);
    // Merge by id: native fills the whole catalog, openrouter's rich chat-model records
    // (structured_output, temperature, max_completion_tokens, hugging_face_id) win where
    // both formats report the same model, so populate native first and let the
    // openrouter pass overwrite matching keys.
    const byID = new Map<string, WorkersAiSourceModel>();
    for (const model of native) byID.set(stripWorkersAiPrefix(model.name), { format: "native", model });
    for (const model of openrouter) byID.set(stripWorkersAiPrefix(model.id), { format: "openrouter", model });
    return [...byID.values()];
  },
  translateModel(source, context) {
    if (source.format === "native") {
      const parsed = OpenRouterModel.parse(reshapeNative(source.model));
      const id = stripWorkersAiPrefix(parsed.id);
      return {
        id,
        model: applyAudioPricing(buildWorkersAiModel(parsed, context.existing(id)), source.model),
      };
    }

    const normalized = normalizeModel(source.model);
    const id = stripWorkersAiPrefix(normalized.id);
    return {
      id,
      model: buildWorkersAiModel(normalized, context.existing(id)),
    };
  },
} satisfies SyncProvider<WorkersAiSourceModel>;

export function buildWorkersAiModel(
  model: z.infer<typeof OpenRouterModel>,
  existing: ExistingModel | undefined,
): SyncedModel {
  const source = {
    ...model,
    name: existing?.name ?? model.name,
    top_provider: {
      ...model.top_provider,
      max_completion_tokens: existing?.limit?.output ?? model.top_provider.max_completion_tokens,
    },
  };
  const synced = {
    ...buildOpenRouterModel(
      source,
      existing,
      existing?.base_model ?? resolveCloudflareBaseModel(model),
    ),
    reasoning_options: existing?.reasoning_options,
  };
  if ("base_model" in synced) return synced;
  return {
    ...synced,
    name: existing?.name ?? synced.name,
    release_date: existing?.release_date ?? synced.release_date,
    last_updated: existing?.last_updated ?? synced.last_updated,
    limit: {
      ...synced.limit,
      output: existing?.limit?.output ?? synced.limit.output,
    },
  };
}

export function resolveCloudflareBaseModel(model: z.infer<typeof OpenRouterModel>) {
  const [, publisher] = stripWorkersAiPrefix(model.id).split("/");
  if (publisher === undefined) return undefined;

  const metadataPublisher = METADATA_PUBLISHERS[publisher];
  if (metadataPublisher === undefined) return undefined;

  let files = metadataFilesByPublisher.get(metadataPublisher);
  if (files === undefined) {
    try {
      files = readdirSync(path.join(MODELS_DIR, metadataPublisher))
        .filter((file) => file.endsWith(".toml"))
        .map((file) => file.slice(0, -5));
    } catch {
      files = [];
    }
    metadataFilesByPublisher.set(metadataPublisher, files);
  }

  const identity = new Set(identityTokens(`${model.id} ${model.name}`));
  const matches = files.filter((file) => identityTokens(file).every((token) => identity.has(token)));
  return matches.length === 1 ? `${metadataPublisher}/${matches[0]}` : undefined;
}

function identityTokens(value: string) {
  return value.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [];
}

// Strips the AI Gateway `workers-ai/` routing prefix Cloudflare's openrouter-format
// endpoint puts on every id; native `name`s never carry it. Doubles as the merge key
// for matching an openrouter-format record against its native counterpart.
function stripWorkersAiPrefix(id: string): string {
  return id.replace(/^workers-ai\//, "");
}

async function fetchAllOpenRouterModels(accountID: string, token: string): Promise<CloudflareModel[]> {
  const first = await fetchOpenRouterPage(accountID, token, 1);
  const models = parseCloudflareModels(first);
  const pageInfo = CloudflareOpenRouterResponse.safeParse(first).success
    ? CloudflareOpenRouterResponse.parse(first).result_info
    : undefined;

  for (let page = 2; page <= (pageInfo?.total_pages ?? 1); page++) {
    models.push(...parseCloudflareModels(await fetchOpenRouterPage(accountID, token, page)));
  }

  return models;
}

// Native pagination reports no `total_pages` (and `total_count` is the GLOBAL catalog,
// not this token's) -- page until the API returns an empty result array.
async function fetchAllNativeModels(accountID: string, token: string): Promise<NativeModel[]> {
  const models: NativeModel[] = [];
  for (let page = 1; ; page++) {
    const pageModels = NativeResponse.parse(await fetchNativePage(accountID, token, page)).result;
    if (pageModels.length === 0) break;
    models.push(...pageModels);
  }
  return models;
}

async function fetchOpenRouterPage(accountID: string, token: string, page: number) {
  const url = new URL(`${API_BASE}/${accountID}/ai/models/search`);
  url.searchParams.set("format", "openrouter");
  url.searchParams.set("per_page", "1000");
  url.searchParams.set("page", String(page));
  return fetchModelsPage(url, token);
}

async function fetchNativePage(accountID: string, token: string, page: number) {
  const url = new URL(`${API_BASE}/${accountID}/ai/models/search`);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));
  return fetchModelsPage(url, token);
}

async function fetchModelsPage(url: URL, token: string) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      `Cloudflare Workers AI models request failed: ${response.status} ${response.statusText}${await responseDetails(response)}`,
    );
  }
  return response.json();
}

function parseCloudflareModels(raw: unknown): CloudflareModel[] {
  const cloudflare = CloudflareResponse.safeParse(raw);
  if (cloudflare.success) return cloudflare.data.data;

  const direct = OpenRouterResponse.safeParse(raw);
  if (direct.success) return direct.data.data.map((model) => CloudflareModel.parse(model));

  const wrapped = CloudflareOpenRouterResponse.parse(raw);
  if (wrapped.result === undefined) {
    throw new Error("Cloudflare Workers AI response did not include model data");
  }
  const models = Array.isArray(wrapped.result) ? wrapped.result : wrapped.result.data;
  return models.map((model) => CloudflareModel.parse(model));
}

function normalizeModel(model: CloudflareModel) {
  if ("architecture" in model && "top_provider" in model && "supported_parameters" in model) {
    return OpenRouterModel.parse(model);
  }

  return OpenRouterModel.parse({
    id: model.id.startsWith("@cf/") ? model.id : `@cf/${model.id.replace(/^@cf\//, "")}`,
    name: model.name,
    created: model.created,
    hugging_face_id: model.hugging_face_id ?? null,
    knowledge_cutoff: null,
    context_length: model.context_length,
    architecture: {
      input_modalities: model.input_modalities ?? ["text"],
      output_modalities: model.output_modalities ?? ["text"],
    },
    pricing: model.pricing,
    top_provider: {
      context_length: model.context_length,
      max_completion_tokens: model.max_output_length ?? null,
    },
    supported_parameters: [
      ...model.supported_sampling_parameters ?? [],
      ...model.supported_features ?? [],
    ],
  });
}

async function responseDetails(response: Response) {
  const text = await response.text();
  if (text.length === 0) return "";

  try {
    const body = z.object({
      errors: z.array(z.object({
        code: z.union([z.string(), z.number()]).optional(),
        message: z.string().optional(),
      }).passthrough()).optional(),
    }).passthrough().parse(JSON.parse(text));
    const details = body.errors
      ?.map((error) => [error.code, error.message].filter(Boolean).join(": "))
      .filter((message) => message.length > 0)
      .join("; ");
    return details === undefined || details.length === 0 ? "" : ` (${details})`;
  } catch {
    return "";
  }
}
