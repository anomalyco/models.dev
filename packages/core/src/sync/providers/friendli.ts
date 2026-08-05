import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import { ReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.friendli.ai/serverless/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Friendli catalog pricing is USD per-token; catalog cost is USD per-million.
const PER_TOKEN_TO_PER_MILLION = 1_000_000;

const InterleavedField = z.enum(["reasoning_content", "reasoning_details"]);

// Raw API reasoning_options shape — stripped of budget_tokens (the API derives
// max from max_completion_tokens, which is not a real reasoning budget control
// on this host; provider.toml documents only enable_thinking as a toggle).
const FriendliReasoningOption = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("toggle") }).passthrough(),
    z
      .object({ type: z.literal("effort"), values: z.array(z.string()) })
      .passthrough(),
    z
      .object({
        type: z.literal("budget_tokens"),
        min: z.number().optional(),
        max: z.number().optional(),
      })
      .passthrough(),
  ])
  .optional();

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

// HuggingFace-style API orgs that are not catalog lab ids. Map them onto the
// catalog metadata tree so self-referential or HF-style base_model values
// resolve to the right lab directory.
const LAB_PREFIX_MAP: Record<string, string> = {
  "deepseek-ai": "deepseek",
  "zai-org": "zhipuai",
  "LGAI-EXAONE": "lgai-exaone",
  "MiniMaxAI": "minimax",
  "meta-llama": "meta",
  "mistralai": "mistral",
  "moonshotai": "moonshotai",
  "Qwen": "alibaba",
};

// Resolve an API `base_model` id to the on-disk `models/<lab>/<file>.toml` id.
// Friendli declares a base_model for every entry, but only models with an
// existing lab metadata file can be factored (override-only). Self-referential
// base_model values (==id) resolve to the model's own lab id when a metadata
// file exists under the mapped lab prefix.
//
// Case-insensitive lookup: the API lowercases ids (e.g. "minimax/minimax-m2.5")
// that exist on disk as mixed-case ("minimax/MiniMax-M2.5.toml"). On macOS
// existsSync is case-insensitive, so we never trust a raw API id and always
// read the directory.
const baseModelCache = new Map<string, string | null>();

function resolveBaseModelID(baseModel: string | undefined): string | undefined {
  if (baseModel === undefined || baseModel.length === 0) return undefined;
  const cached = baseModelCache.get(baseModel);
  if (cached !== undefined) return cached ?? undefined;

  let resolved = lookupLabFile(baseModel);
  if (resolved === undefined) {
    const [org, ...parts] = baseModel.split("/");
    const mapped = org !== undefined ? LAB_PREFIX_MAP[org] : undefined;
    if (mapped !== undefined && parts.length > 0) {
      resolved = lookupLabFile(`${mapped}/${parts.join("/")}`);
    }
  }

  baseModelCache.set(baseModel, resolved ?? null);
  return resolved;
}

// Resolve a Friendli entry to its catalog lab metadata id.
// 1) explicit alias (handles HF id → catalog slug mismatches)
// 2) slug lookup against the models tree
// 3) HF-URL scan against the lab [[weights]] table as a last resort
function resolveLabModelSync(model: FriendliModel): string | undefined {
  return resolveBaseModelID(model.base_model);
}

function lookupLabFile(baseModel: string): string | undefined {
  const [lab, ...modelParts] = baseModel.split("/");
  const modelSlug = modelParts.join("/");
  if (lab === undefined || modelSlug.length === 0) return undefined;

  let labDir: string | undefined;
  try {
    const dirs = readdirSync(MODELS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    labDir = dirs.find((dir) => dir.toLowerCase() === lab.toLowerCase());
  } catch {
    return undefined;
  }
  if (labDir === undefined) return undefined;

  const expected = `${modelSlug}.toml`.toLowerCase();
  let fileMatch: string | undefined;
  try {
    fileMatch = readdirSync(path.join(MODELS_DIR, labDir))
      .filter((file) => file.endsWith(".toml"))
      .find((file) => file.toLowerCase() === expected);
  } catch {
    // fall through
  }
  if (fileMatch === undefined) return undefined;

  return `${labDir}/${fileMatch.slice(0, -".toml".length)}`;
}

export const friendli = {
  id: "friendli",
  name: "Friendli",
  modelsDir: "providers/friendli/models",
  // Friendli occasionally rotates models in and out of its catalog; retain
  // local files for entries the API no longer advertises instead of deleting.
  deleteMissing: false,
  // Friendli's catalog describes real reasoning controls and limits directly;
  // do not carry over a stale base_model when a model switches lab → full inline.
  preserveBaseModels: false,
  // The runner's default preserveDescription re-injects the
  // resolved base description when the translator omits it, recreating an
  // identical override. Friendli descriptions come from the API verbatim and
  // match the lab's, so drop the re-injection.
  preserveDescriptions: false,
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
    if (isDeprecated(model)) return undefined;
    return {
      id: model.id,
      model: buildFriendliModel(
        model,
        context.existing(model.id),
        resolveLabModelSync(model),
      ),
    };
  },
  sourceID(model: FriendliModel) {
    return model.id;
  },
  skippedNotice(ids: string[]) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} deprecated model(s) skipped (deprecation_date passed): ${ids.join(", ")}`,
    ];
  },
  missingNotice(paths: string[]) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local model(s) retained after being removed from the Friendli API: ${paths.join(", ")}`,
    ];
  },
  newFileHeader(model, content) {
    // Toggle is the only documented reasoning control on Friendli
    // (chat_template_kwargs.enable_thinking = true | false). Any toggle-bearing
    // file written by the sync gets a leading wire-path comment so the
    // rationale is not lost when there is no existing header.
    if (model.reasoning !== true) return undefined;
    if (!/^\[\[reasoning_options\]\]\n.*type = "toggle"/m.test(content)) return undefined;
    return "# Toggle: chat_template_kwargs.enable_thinking = true | false\n# https://friendli.ai/docs/guides/reasoning\n";
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

// Skip models whose deprecation_date has passed. Friendli returns an ISO
// timestamp (e.g. "2026-08-20T00:00:00Z"); we compare against now at sync time.
function isDeprecated(model: FriendliModel): boolean {
  if (model.deprecation_date === undefined || model.deprecation_date === null) return false;
  const dep = Date.parse(model.deprecation_date);
  return Number.isFinite(dep) && dep <= Date.now();
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
): NonNullable<ExistingModel["cost"]> | undefined {
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

// Translate API reasoning_options into host-accurate catalog options.
// The API always emits a budget_tokens entry derived from max_completion_tokens
// (min=-1 "unlimited", max=completion cap). That is not a real reasoning-budget
// wire field on Friendli (provider.toml documents only enable_thinking as a
// toggle), so we strip it. On a relay, keep effort only when the API reports it
// verbatim AND the lab/peers use it on this host; toggle is preserved.
function translateReasoningOptions(
  api: FriendliModel["reasoning_options"],
): SyncedFullModel["reasoning_options"] {
  if (api === undefined) return undefined;
  const options: NonNullable<SyncedFullModel["reasoning_options"]> = [];
  for (const option of api) {
    if (option === undefined) continue;
    // Pass toggle, effort, and budget_tokens through; the API is authoritative
    // for this host's reasoning controls (budget_tokens.min = -1 means
    // unlimited; max corresponds to max_completion_tokens but callers may set
    // a smaller cap).
    options.push(option as NonNullable<SyncedFullModel["reasoning_options"]>[number]);
  }
  return options.length > 0 ? options : [];
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
  factorBase: string | undefined,
): SyncedModel {
  // factorBase is pre-resolved by translateModel: looks up the lab metadata
  // file by slug first, then by matching the API hugging_face_url against
  // the lab's [[weights]] table (handles slug mismatches like
  // deepseek-ai/DeepSeek-V3.2 → deepseek/deepseek-chat).

  // Only override modalities when the API explicitly provides them; otherwise
  // omit the override so lab metadata (e.g. gemma vision) is inherited.
  const apiInput = model.input_modalities !== undefined ? translateModalities(model.input_modalities) : undefined;
  const apiOutput = model.output_modalities !== undefined ? translateModalities(model.output_modalities) : undefined;
  const attachment = apiInput !== undefined && apiInput.some((value) => value !== "text");
  const limit = {
    context: model.context_length,
    input: existing?.limit?.input,
    output: model.max_completion_tokens,
  };
  const reasoning = model.reasoning === true;
  const reasoningOptions = reasoning ? translateReasoningOptions(model.reasoning_options) : undefined;
  const interleaved = translateInterleaved(model.interleaved);
  const structuredOutput = model.functionality.structured_output;
  const cost = buildCost(model, existing?.cost);
  const releaseDate = existing?.release_date ?? dateFromTimestamp(model.created);
  const today = new Date().toISOString().slice(0, 10);
  const lastUpdated = existing?.last_updated ?? today;

  if (factorBase !== undefined) {
    return factorBaseModel(
      factorBase,
      {
        attachment,
        reasoning,
        reasoning_options: reasoningOptions,
        interleaved,
        structured_output: structuredOutput,
        description: model.description,
        limit,
        modalities: apiInput !== undefined || apiOutput !== undefined ? { input: apiInput ?? [], output: apiOutput ?? [] } : undefined,
        cost,
      },
      limit,
      existing?.base_model === factorBase ? existing.base_model_omit : undefined,
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
        modalities: apiInput !== undefined || apiOutput !== undefined ? { input: apiInput ?? [], output: apiOutput ?? [] } : undefined,
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
    modalities: { input: apiInput ?? ["text"], output: apiOutput ?? ["text"] },
    status: existing?.status,
  };
}
