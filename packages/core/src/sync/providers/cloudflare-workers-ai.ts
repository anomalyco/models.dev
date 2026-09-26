import { z } from "zod";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { buildOpenRouterModel, OpenRouterModel } from "./openrouter.js";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const TOGGLE_HEADER = "# Toggle: chat_template_kwargs.enable_thinking = true|false\n";
// Models with a verified enable_thinking control. DeepSeek/Kimi use other wire paths;
// their authored comments are preserved below, never inferred from generic schemas.
// These are exact model IDs, not a default for future models or whole publishers.
const ENABLE_THINKING_MODELS = new Set([
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/qwen/qwen3.8-27b",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/zai-org/glm-5.2",
]);
const ROOT_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..");
const MODELS_DIR = path.join(ROOT_DIR, "models");
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

const WorkersAiReasoning = OpenRouterModel.shape.reasoning.unwrap().partial({ mandatory: true });
const WorkersAiModel = OpenRouterModel.extend({ reasoning: WorkersAiReasoning.optional() });
type WorkersAiModel = z.infer<typeof WorkersAiModel>;

const CloudflareModel = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  created: z.number().int().nonnegative(),
  hugging_face_id: z.string().nullable().optional(),
  context_length: z.number().int().positive(),
  max_output_length: z.number().int().positive().nullable().optional(),
  input_modalities: z.array(z.string().min(1)).min(1).optional(),
  output_modalities: z.array(z.string().min(1)).min(1).optional(),
  pricing: OpenRouterModel.shape.pricing.extend({
    prompt: z.string().refine(validPrice),
    completion: z.string().refine(validPrice),
  }),
  supported_features: z.array(z.string()).optional(),
  supported_sampling_parameters: z.array(z.string()).optional(),
  // Validate reasoning separately so malformed controls do not discard the model.
  reasoning: z.unknown().optional(),
}).passthrough();

const CloudflareResponse = z.object({
  data: z.array(z.unknown()).optional(),
  result: z.union([
    z.array(z.unknown()),
    z.object({ data: z.array(z.unknown()) }),
  ]).optional(),
  success: z.literal(true).optional(),
  result_info: z.object({
    total_pages: z.number().int().positive().optional(),
  }).optional(),
}).refine((response) => response.data !== undefined || response.result !== undefined, {
  message: "Cloudflare Workers AI response did not include model data",
});

function modelRows(response: z.infer<typeof CloudflareResponse>) {
  return response.data ?? (Array.isArray(response.result) ? response.result : response.result!.data);
}

function validPrice(value: string) {
  return value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
}

type CloudflareModel = z.infer<typeof CloudflareModel>;

export const cloudflareWorkersAi = {
  id: "cloudflare-workers-ai",
  name: "Cloudflare Workers AI",
  modelsDir: "providers/cloudflare-workers-ai/models",
  deleteMissing: false,
  authoritativeHeaders: true,
  async fetchModels() {
    const accountID = process.env.CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN;
    if (accountID === undefined || token === undefined) {
      throw new Error(
        "Cloudflare Workers AI sync requires CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID and CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN",
      );
    }

    const first = await fetchPage(accountID, token, 1);
    if (first === undefined) throw new Error("Cloudflare Workers AI search returned no usable models");
    const rows = modelRows(first);
    for (let page = 2; page <= (first.result_info?.total_pages ?? 1); page++) {
      const response = await fetchPage(accountID, token, page);
      // Keep successful pages; deleteMissing: false retains models on failed pages.
      if (response !== undefined) rows.push(...modelRows(response));
    }

    return { data: rows };
  },
  parseModels(raw) {
    const models = parseCloudflareModels(raw);
    if (models.length === 0) throw new Error("Cloudflare Workers AI search returned no usable models");
    return models;
  },
  translateModel(model, context) {
    const id = model.id;
    const existing = context.existing(id);
    if (existing === undefined && hasReasoning(model) && workersAiReasoningOptions(model) === undefined) {
      throw new MissingReasoningOptionsError(id, "Workers AI Search does not specify concrete reasoning controls; manual authoring is needed");
    }
    const translated = buildWorkersAiModel(model, existing);
    // Only read paths already present in the sync runner's catalogue map.
    const header = existing === undefined ? "" : modelHeader(path.resolve(ROOT_DIR, this.modelsDir, `${id}.toml`));
    if (header === undefined) return undefined;
    // Remove only the exact generated line; preserve every other leading comment.
    const preservedHeader = header.replace(TOGGLE_HEADER, "");
    // Respect curated model-specific wire instructions, including Qwen's split lines.
    const hasToggleWire = /\b(?:thinking\.type|chat_template_kwargs\.thinking|enable_thinking)\b/.test(preservedHeader);
    const toggleHeader = ENABLE_THINKING_MODELS.has(id) ? TOGGLE_HEADER : "";
    if (translated.reasoning_options?.some((option) => option.type === "toggle") && !hasToggleWire && !toggleHeader) {
      if (existing === undefined) {
        throw new MissingReasoningOptionsError(id, "Workers AI toggle wire path needs manual verification");
      }
      console.warn(`Keeping catalogue reasoning for ${id}: Workers AI toggle wire path is unknown`);
      // Keep the reasoning boundary small: other usable properties still update.
      return {
        id,
        model: buildWorkersAiModel({ ...model, reasoning: undefined }, existing),
        header,
      };
    }
    return {
      id,
      model: translated,
      header: (translated.reasoning_options?.some((option) => option.type === "toggle") && !hasToggleWire ? toggleHeader : "")
        + preservedHeader,
    };
  },
} satisfies SyncProvider<WorkersAiModel>;

function hasReasoning(model: WorkersAiModel) {
  return model.supported_parameters.includes("reasoning") || model.supported_parameters.includes("include_reasoning")
    || model.reasoning?.mandatory !== undefined || model.reasoning?.supported_efforts !== undefined
    || model.reasoning?.supports_max_tokens === true;
}

function modelHeader(file: string) {
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    const firstKey = lines.findIndex((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    return lines.slice(0, firstKey === -1 ? lines.length : firstKey).join("\n") + "\n";
  } catch (error) {
    console.warn(`Skipping Workers AI model with an unreadable catalogue header: ${file}`, error);
    return undefined;
  }
}

export function buildWorkersAiModel(
  model: WorkersAiModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const reasoningOptions = workersAiReasoningOptions(model);
  const reasoning = reasoningOptions !== undefined
    ? true
    : existing?.reasoning ?? hasReasoning(model);
  const source = {
    ...model,
    reasoning: undefined,
    supported_parameters: [
      ...model.supported_parameters.filter((parameter) => !["reasoning", "include_reasoning"].includes(parameter)),
      ...(reasoning ? ["reasoning"] : []),
    ],
    name: existing?.name ?? model.name,
    top_provider: {
      ...model.top_provider,
      max_completion_tokens: existing?.limit?.output ?? model.top_provider.max_completion_tokens,
    },
  };
  // The shared builder uses these options when source.reasoning is omitted.
  const existingWithReasoningOptions = reasoningOptions === undefined
    ? existing
    : { ...existing, reasoning_options: reasoningOptions };
  const synced = buildOpenRouterModel(
    source,
    existingWithReasoningOptions,
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

function workersAiReasoningOptions({ id, reasoning }: WorkersAiModel): SyncedFullModel["reasoning_options"] {
  // A null gateway allowlist does not identify concrete model controls.
  // Preserve the catalogue instead of expanding it to every effort in the schema.
  if (reasoning === undefined || reasoning.supported_efforts === null) return undefined;

  const options: NonNullable<SyncedFullModel["reasoning_options"]> = [];
  const efforts = reasoning.supported_efforts;
  if (efforts?.length === 0) return undefined;
  if (efforts === undefined && reasoning.supports_max_tokens !== true) {
    // GLM-4.7-Flash's verified ConfigAPI/Search shape is { mandatory: false,
    // default_enabled: true }; its only control is enable_thinking. The generic
    // input schema's low/medium/high enum is not a model capability.
    // Creator: https://huggingface.co/zai-org/GLM-4.7-Flash/blob/main/chat_template.jinja
    // Require the explicit off-capability flag; absence of efforts alone says nothing.
    return id === "@cf/zai-org/glm-4.7-flash" && reasoning.mandatory === false
      ? [{ type: "toggle" }]
      : undefined;
  }
  // Without either an explicit mandatory flag or a named off setting, a partial
  // effort list cannot tell us whether replacing the catalogue would lose a toggle.
  if (reasoning.mandatory === undefined && !efforts?.includes("none")) return undefined;

  if (reasoning.mandatory === false && !efforts?.includes("none")) {
    options.push({ type: "toggle" });
  }

  const values = reasoning.mandatory ? efforts?.filter((value) => value !== "none") : efforts;
  // One mandatory effective effort offers no caller choice. Unlike missing or
  // empty metadata, a concrete singleton establishes this explicitly.
  const fixedEffort = reasoning.mandatory === true && values?.length === 1;
  if (values?.length && !fixedEffort) {
    options.push({ type: "effort", values: [...values] });
  }

  if (reasoning.supports_max_tokens === true) {
    // Explicit reasoning.max_tokens support, never inferred from output limits.
    options.push({ type: "budget_tokens" });
  }

  // Empty control metadata never clears authored controls; a known fixed effort can.
  return options.length > 0 || fixedEffort ? options : undefined;
}

export function resolveCloudflareBaseModel(model: WorkersAiModel) {
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

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}${await responseDetails(response)}`);
      }
      return CloudflareResponse.parse(await response.json());
    } catch (error) {
      console.warn(
        `Workers AI search page ${page}, attempt ${attempt}/4 failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (attempt < 4) await Bun.sleep(30_000);
    }
  }
}

function parseCloudflareModels(raw: unknown): WorkersAiModel[] {
  const response = CloudflareResponse.parse(raw);
  return modelRows(response).flatMap((row) => {
    const parsed = CloudflareModel.safeParse(row);
    if (!parsed.success) {
      console.warn(`Skipping invalid Workers AI model: ${parsed.error.message}`);
      return [];
    }
    try {
      return [normalizeModel(parsed.data)];
    } catch (error) {
      console.warn(`Skipping invalid Workers AI model ${parsed.data.id}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
}

function normalizeModel(model: CloudflareModel) {
  const parsed = WorkersAiReasoning.safeParse(model.reasoning);
  const reasoning = parsed.success ? parsed.data : undefined;
  if (!parsed.success && model.reasoning != null) {
    console.warn(`Ignoring invalid Workers AI reasoning for ${model.id}: ${parsed.error.message}`);
  }
  const id = model.id.replace(/^workers-ai\//, "");
  const normalizedID = id.startsWith("@cf/") ? id : `@cf/${id}`;
  if ("architecture" in model || "top_provider" in model || "supported_parameters" in model) {
    const normalized = WorkersAiModel.parse({ ...model, id: normalizedID, reasoning });
    z.number().int().positive().nullable().parse(normalized.top_provider.max_completion_tokens);
    if (normalized.architecture.input_modalities.length === 0 || normalized.architecture.output_modalities.length === 0) {
      throw new Error("Model modalities must not be empty");
    }
    return normalized;
  }

  return WorkersAiModel.parse({
    id: normalizedID,
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
    reasoning,
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
