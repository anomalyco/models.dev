import { readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.friendli.ai/serverless/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Friendli catalog pricing is USD per-token; catalog cost is USD per-million.
const PER_TOKEN_TO_PER_MILLION = 1_000_000;

const ReasoningEffortValues = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
] as const;
const ReasoningEfforts = new Set<string>(ReasoningEffortValues);

const InterleavedField = z.enum(["reasoning_content", "reasoning_details"]);

const FriendliReasoningOption = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }).passthrough(),
  z.object({ type: z.literal("effort"), values: z.array(z.string()) }).passthrough(),
  z
    .object({
      type: z.literal("budget_tokens"),
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .passthrough(),
]);

export const FriendliModel = z
  .object({
    id: z.string(),
    hugging_face_id: z.string().optional(),
    name: z.string(),
    created: z.number(),
    context_length: z.number(),
    max_completion_tokens: z.number(),
    functionality: z
      .object({
        tool_call: z.boolean(),
        parallel_tool_call: z.boolean().optional(),
        structured_output: z.boolean(),
        tool_choice: z.boolean().optional(),
        system_messages: z.boolean().optional(),
      })
      .passthrough(),
    pricing: z
      .object({
        input: z.union([z.string(), z.number()]),
        output: z.union([z.string(), z.number()]),
        prompt: z.union([z.string(), z.number()]).optional(),
        completion: z.union([z.string(), z.number()]).optional(),
        input_cache_read: z.union([z.string(), z.number()]).optional(),
        input_cache_write: z.union([z.string(), z.number()]).optional(),
      })
      .passthrough(),
    description: z.string().optional(),
    hugging_face_url: z.string().optional(),
    license: z.string().optional(),
    policy: z.string().nullable().optional(),
    deprecation_date: z.string().nullable().optional(),
    reasoning: z.boolean().optional(),
    reasoning_options: z.array(FriendliReasoningOption).optional(),
    interleaved: z.union([InterleavedField, z.boolean()]).optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
    base_model: z.string().optional(),
    mode: z.string().optional(),
  })
  .passthrough();

export const FriendliResponse = z
  .object({
    data: z.array(FriendliModel),
  })
  .passthrough();

export type FriendliModel = z.infer<typeof FriendliModel>;

// Resolve an API `base_model` id to the on-disk `models/<lab>/<file>.toml` id.
// Friendli declares a base_model for every entry, but only models with an
// existing lab metadata file can be factored (override-only). Self-referential
// base_model values (==id) or labs we have no metadata for fall through to
// undefined → full inline provider model.
//
// Case-insensitive lookup is required: the API lowercases ids (e.g.
// "minimax/minimax-m2.5") that exist on disk as mixed-case
// ("minimax/MiniMax-M2.5.toml"). On macOS `existsSync` happily matches the
// wrong case, so we never trust a raw API id and always read the directory.
const baseModelCache = new Map<string, string | null>();

function resolveBaseModelID(baseModel: string | undefined): string | undefined {
  if (baseModel === undefined || baseModel.length === 0) return undefined;
  const cached = baseModelCache.get(baseModel);
  if (cached !== undefined) return cached ?? undefined;

  const [lab, ...modelParts] = baseModel.split("/");
  const modelSlug = modelParts.join("/");
  if (lab === undefined || modelSlug.length === 0) {
    baseModelCache.set(baseModel, null);
    return undefined;
  }

  let labDir: string | undefined;
  try {
    const dirs = readdirSync(MODELS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    labDir = dirs.find((dir) => dir.toLowerCase() === lab.toLowerCase());
  } catch {
    baseModelCache.set(baseModel, null);
    return undefined;
  }
  if (labDir === undefined) {
    baseModelCache.set(baseModel, null);
    return undefined;
  }

  const expected = `${modelSlug}.toml`.toLowerCase();
  let fileMatch: string | undefined;
  try {
    fileMatch = readdirSync(path.join(MODELS_DIR, labDir))
      .filter((file) => file.endsWith(".toml"))
      .find((file) => file.toLowerCase() === expected);
  } catch {
    // fall through
  }
  if (fileMatch === undefined) {
    baseModelCache.set(baseModel, null);
    return undefined;
  }

  const resolved = `${labDir}/${fileMatch.slice(0, -".toml".length)}`;
  baseModelCache.set(baseModel, resolved);
  return resolved;
}

export const friendli = {
  id: "friendli",
  name: "Friendli",
  modelsDir: "providers/friendli/models",
  // Friendli occasionally rotates models in and out of its catalog; retain
  // local files for entries the API no longer advertises instead of deleting.
  deleteMissing: false,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(
        `Friendli request failed: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  },
  parseModels(raw: unknown) {
    return FriendliResponse.parse(raw).data;
  },
  translateModel(model: FriendliModel, context) {
    return {
      id: model.id,
      model: buildFriendliModel(model, context.existing(model.id)),
    };
  },
  missingNotice(paths: string[]) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local model(s) retained after being removed from the Friendli API: ${paths.join(", ")}`,
    ];
  },
} satisfies SyncProvider<FriendliModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function translateModalities(values: string[] | undefined): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = [...new Set(
    (values ?? ["text"])
      .map((value) => value.toLowerCase())
      .filter((value): value is Modality => allowed.has(value as Modality)),
  )];
  return result.length > 0 ? result : ["text"];
}

function dateFromTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function perMillion(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  const perM = number * PER_TOKEN_TO_PER_MILLION;
  return Math.round(perM * 1_000_000) / 1_000_000;
}

function buildCost(
  model: FriendliModel,
  existing: ExistingModel["cost"] | undefined,
): ExistingModel["cost"] | NonNullable<ExistingModel["cost"]> | undefined {
  const input = perMillion(model.pricing.input);
  const output = perMillion(model.pricing.output);
  if (input === undefined || output === undefined) return existing;
  return {
    input,
    output,
    cache_read: perMillion(model.pricing.input_cache_read) ?? existing?.cache_read,
    cache_write: perMillion(model.pricing.input_cache_write) ?? existing?.cache_write,
  };
}

function translateReasoningOptions(
  api: FriendliModel["reasoning_options"],
): NonNullable<SyncedFullModel["reasoning_options"]> | undefined {
  if (api === undefined || api.length === 0) return undefined;
  const options: NonNullable<SyncedFullModel["reasoning_options"]> = [];
  for (const option of api) {
    if (option.type === "toggle") {
      options.push({ type: "toggle" });
    } else if (option.type === "effort") {
      const values = [...new Set((option.values ?? []).filter(isReasoningEffort))];
      if (values.length > 0) options.push({ type: "effort", values });
    } else if (option.type === "budget_tokens") {
      const entry: { type: "budget_tokens"; min?: number; max?: number } = {
        type: "budget_tokens",
      };
      if (option.min !== undefined) entry.min = option.min;
      if (option.max !== undefined) entry.max = option.max;
      options.push(entry);
    }
  }
  return options.length > 0 ? options : undefined;
}

function isReasoningEffort(value: string): value is (typeof ReasoningEffortValues)[number] {
  return ReasoningEfforts.has(value);
}

function translateInterleaved(
  value: FriendliModel["interleaved"],
): SyncedFullModel["interleaved"] {
  if (value === undefined || value === false) return undefined;
  if (value === true) return true;
  return { field: value };
}

function inferFamily(modelID: string, name: string): SyncedFullModel["family"] {
  const kimiFamily = inferKimiFamily(modelID, name);
  if (kimiFamily !== undefined) return kimiFamily;
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

function displayModelName(apiName: string): string {
  return apiName.split("/").at(-1) ?? apiName;
}

function buildFriendliModel(
  model: FriendliModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  // base_model is only factored when it points at a real, distinct lab metadata
  // file. Self-referential base_model (== id) with no lab metadata → full inline.
  const resolvedBase = resolveBaseModelID(model.base_model);
  const baseModel =
    resolvedBase !== undefined && resolvedBase !== model.id ? resolvedBase : undefined;

  const input = translateModalities(model.input_modalities);
  const output = translateModalities(model.output_modalities);
  const attachment = input.some((value) => value !== "text");
  const limit = {
    context: model.context_length,
    input: existing?.limit?.input,
    output: model.max_completion_tokens,
  };
  const reasoning = model.reasoning === true;
  const reasoningOptions = translateReasoningOptions(model.reasoning_options);
  const interleaved = translateInterleaved(model.interleaved);
  const structuredOutput = model.functionality.structured_output;
  const cost = buildCost(model, existing?.cost);
  const releaseDate = existing?.release_date ?? dateFromTimestamp(model.created);
  const today = new Date().toISOString().slice(0, 10);
  const lastUpdated = existing?.last_updated ?? today;

  if (baseModel !== undefined) {
    return factorBaseModel(
      baseModel,
      {
        attachment,
        reasoning,
        reasoning_options: reasoningOptions,
        interleaved,
        structured_output: structuredOutput,
        description: model.description,
        limit,
        modalities: { input, output },
        cost,
      },
      limit,
      existing?.base_model === baseModel ? existing.base_model_omit : undefined,
    );
  }

  const name = existing?.name ?? displayModelName(model.name);
  return {
    name,
    description:
      existing?.description ??
      model.description ??
      describeModel({
        id: model.id,
        providerId: "friendli",
        name,
        family: existing?.family,
        reasoning,
        tool_call: model.functionality.tool_call,
        structured_output: structuredOutput,
        open_weights: Boolean(model.hugging_face_url),
        modalities: { input, output },
      }),
    family: existing?.family ?? inferFamily(model.id, name),
    attachment,
    reasoning,
    reasoning_options: reasoningOptions,
    tool_call: model.functionality.tool_call,
    structured_output: structuredOutput,
    temperature: existing?.temperature ?? true,
    release_date: releaseDate,
    last_updated: lastUpdated,
    open_weights: Boolean(model.hugging_face_url),
    interleaved,
    knowledge: existing?.knowledge,
    cost,
    limit: { context: model.context_length, output: model.max_completion_tokens },
    modalities: { input, output },
    status: existing?.status,
  };
}
