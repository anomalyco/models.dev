import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.aiand.com/v1/models";

// Maps ai& org prefixes to the canonical metadata prefixes understood by
// resolveCanonicalBaseModel. Mirrors CANONICAL_ORG_PREFIXES in huggingface.ts.
const CANONICAL_ORG_PREFIXES: Record<string, string> = {
  "deepseek-ai": "deepseek",
  moonshotai: "moonshotai",
  "zai-org": "zai",
};

// ai& /v1/models pricing block. The API has been observed shipping both
// OpenRouter-style keys (prompt/completion) and OpenAI-style keys
// (input/output) — accept both so the adapter is not broken by a rename.
const AiandPricing = z.object({
  // input token price
  prompt: z.string().optional(),
  input: z.string().optional(),
  // output token price
  completion: z.string().optional(),
  output: z.string().optional(),
  // reasoning / cache fields (stable across naming conventions)
  internal_reasoning: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
}).passthrough();

// ai& /v1/models architecture block. Accept both naming styles for modalities.
const AiandArchitecture = z.object({
  // OpenRouter-style
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  // alternate style observed in some providers
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
}).passthrough();

export const AiandModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number().optional(),
  architecture: AiandArchitecture.optional(),
  pricing: AiandPricing.optional(),
  // The live API field is `context_window` (documented in hand-authored TOMLs,
  // e.g. glm-5.1: "exact context_window is only visible via GET /v1/models").
  // Accept `context_length` as a fallback in case the key is ever normalised.
  context_window: z.number().optional(),
  context_length: z.number().optional(),
  // Accept both naming conventions for the capability list.
  supported_parameters: z.array(z.string()).optional(),
  parameters: z.array(z.string()).optional(),
  structured_outputs: z.boolean().optional(),
}).passthrough();

export const AiandResponse = z.object({
  data: z.array(AiandModel),
}).passthrough();

export type AiandModel = z.infer<typeof AiandModel>;

// ai& model IDs use the form "org/model-id" (e.g. "zai-org/glm-5.2").
function splitModelId(id: string): { org: string; modelId: string } | undefined {
  const slash = id.indexOf("/");
  if (slash === -1) return undefined;
  return { org: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

function resolveAiandBaseModel(model: AiandModel): string | undefined {
  const parts = splitModelId(model.id);
  if (parts === undefined) return undefined;
  const canonicalOrg = CANONICAL_ORG_PREFIXES[parts.org] ?? parts.org;
  return resolveCanonicalBaseModel(`${canonicalOrg}/${parts.modelId}`);
}

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

function nonZeroPrice(value: string | undefined) {
  const result = price(value);
  return result !== undefined && result > 0 ? result : undefined;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((v) => v.toLowerCase())
    .map((v) => (v === "file" ? "pdf" : v))
    .filter((v): v is Modality => allowed.has(v as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

function defaultModalities(model: AiandModel) {
  // Accept both naming conventions; prefer the OpenRouter-style keys.
  const input = model.architecture?.input_modalities
    ?? model.architecture?.inputs
    ?? ["text"];
  const output = model.architecture?.output_modalities
    ?? model.architecture?.outputs
    ?? ["text"];
  return {
    input: modalities(input, ["text"]),
    output: modalities(output, ["text"]),
  };
}

// Resolve the effective parameter list regardless of naming convention.
function resolveParams(model: AiandModel): string[] {
  return model.supported_parameters ?? model.parameters ?? [];
}

// Resolve the context window from whichever field the API ships.
// `context_window` is the documented live field (per hand-authored TOML
// comments); `context_length` is accepted as a fallback.
function resolveContext(model: AiandModel): number {
  return model.context_window ?? model.context_length ?? 0;
}

// Resolve input/output token prices accepting both naming styles.
function resolvePricing(model: AiandModel) {
  return {
    prompt: model.pricing?.prompt ?? model.pricing?.input,
    completion: model.pricing?.completion ?? model.pricing?.output,
    internal_reasoning: model.pricing?.internal_reasoning,
    input_cache_read: model.pricing?.input_cache_read,
    input_cache_write: model.pricing?.input_cache_write,
  };
}

function inferFamily(model: AiandModel, name: string) {
  const kimiFamily = inferKimiFamily(model.id, name);
  if (kimiFamily !== undefined) return kimiFamily;
  const parts = splitModelId(model.id);
  const target = `${parts?.modelId ?? model.id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") {
        return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      }
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

export function buildAiandModel(
  model: AiandModel,
  existing: ExistingModel | undefined,
): SyncedModel | undefined {
  const params = resolveParams(model);
  const reasoning = params.includes("reasoning_effort");
  const pricing = resolvePricing(model);

  // Resolve context: prefer context_window (real API field), fall back to
  // context_length, then fall back to the existing curated value.
  const rawContext = resolveContext(model);
  const context = rawContext > 0
    ? rawContext
    : existing?.limit?.context ?? 0;

  const prompt = price(pricing.prompt);
  const completion = price(pricing.completion);

  const cost = prompt !== undefined && completion !== undefined
    ? {
        input: prompt,
        output: completion,
        reasoning: reasoning
          ? nonZeroPrice(pricing.internal_reasoning) ?? existing?.cost?.reasoning
          : existing?.cost?.reasoning,
        cache_read: nonZeroPrice(pricing.input_cache_read) ?? existing?.cost?.cache_read,
        cache_write: nonZeroPrice(pricing.input_cache_write) ?? existing?.cost?.cache_write,
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;

  // [fix 1] The ai& API has no dedicated output-limit field, so do NOT fall
  // back to `context` — that was overwriting hand-authored output limits
  // (e.g. deepseek-v4-flash: 384_000, glm-5.2: 131_072). Strictly preserve
  // the existing hand-authored value. Mirrors the Kilo adapter pattern.
  const limit = {
    context,
    input: existing?.limit?.input,
    output: existing?.limit?.output,
  };

  // [fix 2] Always resolve modalities from the API response so the output
  // modality is never dropped. Previously, factored models passed
  // `existing.modalities` which is undefined when only `modalities.input` is
  // set in the TOML, causing the entire block to be removed on every sync run.
  const apiModalities = defaultModalities(model);

  // Existing factored model: refresh cost + limit, preserve authored overrides.
  if (existing?.base_model !== undefined) {
    return factorBaseModel(
      existing.base_model,
      {
        attachment: existing.attachment,
        description: existing.description,
        reasoning: existing.reasoning,
        temperature: existing.temperature,
        tool_call: existing.tool_call,
        structured_output: existing.structured_output,
        status: existing.status,
        interleaved: existing.interleaved,
        knowledge: existing.knowledge,
        // [fix 2] Use API-resolved modalities instead of existing.modalities
        // so output: ["text"] is never silently dropped for factored models.
        modalities: existing.modalities ?? apiModalities,
        limit,
        cost,
      },
      limit,
      existing.base_model_omit,
    );
  }

  // Existing full model: refresh cost + limit, preserve curated metadata.
  if (existing !== undefined) {
    return {
      name: existing.name ?? model.name,
      description: existing.description,
      family: existing.family,
      release_date: existing.release_date
        ?? (model.created ? dateFromTimestamp(model.created) : undefined),
      last_updated: existing.last_updated
        ?? (model.created ? dateFromTimestamp(model.created) : undefined),
      attachment: existing.attachment ?? false,
      reasoning: existing.reasoning ?? reasoning,
      temperature: existing.temperature ?? false,
      tool_call: existing.tool_call ?? false,
      structured_output: existing.structured_output,
      knowledge: existing.knowledge,
      open_weights: existing.open_weights ?? false,
      status: existing.status,
      interleaved: existing.interleaved,
      cost,
      limit,
      // [fix 2] Fall back to API-resolved modalities for full models too.
      modalities: existing.modalities ?? apiModalities,
    } satisfies SyncedFullModel;
  }

  // New model (no existing TOML). Require usable input+output pricing before
  // any create — factored or standalone. Writing a row without [cost] would
  // publish an unpriced catalog entry; matches deepinfra/baseten/huggingface.
  if (prompt === undefined || completion === undefined) return undefined;

  // New model: attempt to factor against canonical base.
  // Also skip if there is no usable context — writing limit.context = 0 would
  // override any valid context inherited from the base model.
  const canonical = resolveAiandBaseModel(model);
  if (canonical !== undefined) {
    if (context === 0) return undefined;
    const factoredLimit = { context, input: undefined, output: undefined };
    // [fix] When the API signals reasoning_effort, pass it through so the
    // created row does not inherit an incorrect reasoning=false from the base.
    // reasoning_options is left as [] — exact effort values need hand-authoring.
    const factoredOverrides: Parameters<typeof factorBaseModel>[1] = {
      limit: factoredLimit,
      cost,
      ...(reasoning ? { reasoning: true, reasoning_options: [] } : {}),
    };
    return factorBaseModel(canonical, factoredOverrides, factoredLimit);
  }

  // Brand-new model with no existing TOML and no canonical base.
  // Guard: skip creates that are missing context or created timestamp.
  // (pricing guard already applied above)
  if (context === 0 || model.created === undefined) return undefined;

  // reasoning_options is deliberately left as [] — the allowed effort values
  // vary per model and must be verified by a live probe before publishing.
  // (e.g. gpt-oss-120b: low|medium|high; kimi-k3: none|low|high|max)
  const { input, output } = apiModalities;
  return {
    name: model.name,
    description: describeModel({
      id: model.id,
      name: model.name,
      family: inferFamily(model, model.name),
      reasoning,
      tool_call: params.includes("tools") || params.includes("tool_choice"),
      structured_output: model.structured_outputs ?? false,
      open_weights: false,
      limit,
      modalities: { input, output },
    }),
    family: inferFamily(model, model.name),
    release_date: dateFromTimestamp(model.created),
    last_updated: dateFromTimestamp(model.created),
    attachment: input.some((v) => v !== "text"),
    reasoning,
    // Safe placeholder — per-model effort values must be probed and hand-authored.
    reasoning_options: reasoning ? [] : undefined,
    temperature: params.includes("temperature"),
    tool_call: params.includes("tools") || params.includes("tool_choice"),
    structured_output: model.structured_outputs ?? false,
    open_weights: false,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

export const aiand = {
  id: "aiand",
  name: "ai&",
  modelsDir: "providers/aiand/models",
  // Do not auto-delete local TOMLs absent from GET /v1/models. The ai& catalog
  // is account/org-scoped — a model absent from the automation key's view may
  // still be live for other orgs or curated by hand (e.g. glm-5.1, kimi-k2.6).
  // Matches the pattern used by openai, deepinfra, baseten, huggingface.
  deleteMissing: false,
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local ai& model(s) were absent from GET /v1/models and were retained for manual lifecycle review.`,
      `Retained: ${paths.map((p) => `\`${p}\``).join(", ")}`,
    ];
  },
  // Surface skipped remote models in sync PR notices so maintainers can tell
  // which API rows were withheld (missing pricing/context) vs genuinely absent.
  // Matches the sourceID + skippedNotice pattern in baseten/deepinfra.
  sourceID: (model: AiandModel) => model.id,
  skippedNotice(ids: string[]) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} ai& model(s) from GET /v1/models were skipped (missing pricing, context, or created timestamp) and were not written to the catalog.`,
      `Skipped: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const apiKey = process.env.AIAND_API_KEY;
    if (!apiKey) {
      throw new Error("AIAND_API_KEY environment variable is not set");
    }
    const response = await fetch(API_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`ai& request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // Only sync text-output models. Accept both modality naming conventions.
    return AiandResponse.parse(raw).data.filter((model) => {
      const output = model.architecture?.output_modalities
        ?? model.architecture?.outputs
        ?? ["text"];
      return output.includes("text");
    });
  },
  translateModel(model, context) {
    const built = buildAiandModel(model, context.existing(model.id));
    if (built === undefined) return undefined;
    return { id: model.id, model: built };
  },
} satisfies SyncProvider<AiandModel>;
