import { z } from "zod";
import { readdirSync } from "node:fs";
import path from "node:path";

import { ReasoningOption } from "../../schema.js";
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
  reasoning: OpenRouterModel.shape.reasoning.catch(undefined),
  input_schema: z.record(z.unknown()).optional(),
}).passthrough();

const CloudflareResponse = z.object({
  data: z.array(CloudflareModel),
}).passthrough();

type CloudflareModel = z.infer<typeof CloudflareModel>;

export const cloudflareWorkersAi = {
  id: "cloudflare-workers-ai",
  name: "Cloudflare Workers AI",
  modelsDir: "providers/cloudflare-workers-ai/models",
  updateHeader(current, generated) {
    const notes = current.split("\n").filter((line) => line.trim() &&
      (/https?:\/\//.test(line) || !/reasoning|thinking|effort|toggle|budget/i.test(line)));
    return [...new Set([...generated.trim().split("\n"), ...notes])].join("\n") + "\n";
  },
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

    for (let i = 0; i < models.length; i += 4) {
      await Promise.all(models.slice(i, i + 4).map(async (model) => {
        model.input_schema = await fetchSchema(accountID, token, model.id.replace(/^workers-ai\//, ""));
      }));
    }

    return { data: models };
  },
  parseModels(raw) {
    return parseCloudflareModels(raw);
  },
  translateModel(model, context) {
    const normalized = normalizeModel(model);
    const id = normalized.id.replace(/^workers-ai\//, "");
    const controls = normalized.supported_parameters.some((value) => value === "reasoning" || value === "include_reasoning")
      ? schemaReasoningOptions(model.input_schema)
      : undefined;
    return {
      id,
      model: {
        ...buildWorkersAiModel(normalized, context.existing(id)),
        ...(controls && { reasoning_options: controls.options }),
      },
      header: controls?.header,
    };
  },
} satisfies SyncProvider<CloudflareModel>;

const SchemaNode = z.object({
  type: z.string().optional(),
  enum: z.array(z.unknown()).optional(),
  const: z.unknown().optional(),
  properties: z.record(z.unknown()).optional(),
  anyOf: z.array(z.unknown()).optional(),
  oneOf: z.array(z.unknown()).optional(),
});

// Follow request properties and alternatives, not arbitrary nested message/tool schemas.
function schemaFields(input: unknown, path: string[]): z.infer<typeof SchemaNode>[] {
  const parsed = SchemaNode.safeParse(input);
  if (!parsed.success) return [];
  const node = parsed.data;
  const fields = path.length === 0 ? [node] : schemaFields(node.properties?.[path[0]!], path.slice(1));
  return fields.concat((node.anyOf ?? []).concat(node.oneOf ?? []).flatMap((branch) => schemaFields(branch, path)));
}

function schemaReasoningOptions(input: unknown) {
  const options: z.infer<typeof ReasoningOption>[] = [];
  const paths = [["reasoning_effort"], ["reasoning", "effort"]];
  const values = [...new Set(paths.flatMap((path) => schemaFields(input, path))
    .flatMap((node) => node.enum ?? []).filter((value) => typeof value === "string"))];
  const effort = ReasoningOption.safeParse({ type: "effort", values });
  const toggle = schemaFields(input, ["chat_template_kwargs", "enable_thinking"])
    .some((node) => node.type === "boolean" && node.const === undefined &&
      (node.enum === undefined || (node.enum.includes(true) && node.enum.includes(false))));
  const comments = ["# Reasoning controls declared by Cloudflare's model input schema."];
  if (toggle && !values.includes("none")) {
    options.push({ type: "toggle" });
    comments.push("# Toggle: chat_template_kwargs.enable_thinking = true|false");
  }
  if (effort.success && values.some((value) => value !== "none")) {
    options.push(effort.data);
    for (const path of paths) {
      if (schemaFields(input, path).some((node) => node.enum?.length)) {
        comments.push(`# Effort: ${path.join(".")} = ${values.join("|")}`);
      }
    }
  }
  if (options.length === 0) return undefined;
  return { options, header: comments.join("\n") + "\n" };
}

async function fetchSchema(accountID: string, token: string, model: string) {
  const url = new URL(`${API_BASE}/${accountID}/ai/models/schema`);
  url.searchParams.set("model", model);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare Workers AI schema request failed for ${model}: ${response.status}`);
  }
  return z.object({
    success: z.literal(true),
    result: z.object({ input: z.record(z.unknown()) }),
  }).parse(await response.json()).result.input;
}

export function buildWorkersAiModel(
  model: z.infer<typeof OpenRouterModel>,
  existing: ExistingModel | undefined,
): SyncedModel {
  const source = {
    ...model,
    // Cloudflare has no verified "null means every effort" contract.
    reasoning: model.reasoning === undefined ? undefined : {
      ...model.reasoning,
      supported_efforts: model.reasoning.supported_efforts ?? undefined,
    },
    name: existing?.name ?? model.name,
    top_provider: {
      ...model.top_provider,
      max_completion_tokens: existing?.limit?.output ?? model.top_provider.max_completion_tokens,
    },
  };
  const synced = buildOpenRouterModel(
    source,
    existing,
    existing?.base_model ?? resolveCloudflareBaseModel(model),
  );
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
  const [, publisher] = model.id.replace(/^workers-ai\//, "").split("/");
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
    reasoning: model.reasoning,
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
