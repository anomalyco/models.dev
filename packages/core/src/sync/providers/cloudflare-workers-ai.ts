import { z } from "zod";

import type { ExistingModel, SyncProvider } from "../index.js";
import {
  buildOpenRouterModel,
  OpenRouterModel,
  OpenRouterResponse,
} from "./openrouter.js";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";

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

export const cloudflareWorkersAi = {
  id: "cloudflare-workers-ai",
  name: "Cloudflare Workers AI",
  modelsDir: "providers/cloudflare-workers-ai/models",
  async fetchModels() {
    const accountID = process.env.CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN;
    if (accountID === undefined || token === undefined) {
      throw new Error(
        "Cloudflare Workers AI sync requires CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID and CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN",
      );
    }

    const first = await fetchPage(accountID, token, 1);
    const models = parseCloudflareModels(first);
    const pageInfo = CloudflareOpenRouterResponse.safeParse(first).success
      ? CloudflareOpenRouterResponse.parse(first).result_info
      : undefined;

    for (let page = 2; page <= (pageInfo?.total_pages ?? 1); page++) {
      models.push(...parseCloudflareModels(await fetchPage(accountID, token, page)));
    }

    return { data: models };
  },
  parseModels(raw) {
    return parseCloudflareModels(raw);
  },
  translateModel(model, context) {
    const normalized = normalizeModel(model);
    const id = normalized.id.replace(/^workers-ai\//, "");
    return {
      id,
      model: buildWorkersAiModel(normalized, context.existing(id)),
    };
  },
} satisfies SyncProvider<CloudflareModel>;

function buildWorkersAiModel(model: z.infer<typeof OpenRouterModel>, existing: ExistingModel | undefined) {
  const synced = buildOpenRouterModel(model, existing);
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

async function fetchPage(accountID: string, token: string, page: number) {
  const url = new URL(`${API_BASE}/${accountID}/ai/models/search`);
  url.searchParams.set("format", "openrouter");
  url.searchParams.set("per_page", "1000");
  url.searchParams.set("page", String(page));

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

function parseCloudflareModels(raw: unknown) {
  const cloudflare = CloudflareResponse.safeParse(raw);
  if (cloudflare.success) return cloudflare.data.data;

  const direct = OpenRouterResponse.safeParse(raw);
  if (direct.success) return direct.data.data;

  const wrapped = CloudflareOpenRouterResponse.parse(raw);
  if (wrapped.result === undefined) {
    throw new Error("Cloudflare Workers AI response did not include model data");
  }
  return Array.isArray(wrapped.result) ? wrapped.result : wrapped.result.data;
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
