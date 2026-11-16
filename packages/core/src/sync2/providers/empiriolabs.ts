// EmpirioLabs AI: https://api.empiriolabs.ai/v1/models (public). Text models
// only, without `:` variants. Authoritative for the name, token and cache read
// prices (context tiers as bands), context and output limits, input and output
// kinds, reasoning controls (enable_thinking, reasoning_effort,
// thinking_budget parameters) and deprecation. Reasoning, tools, structured
// output and temperature can only be turned on: a file that has them keeps
// them. A model that caches keeps the file's cache kinds or gets
// `{ implicit = true }`. Standalone files also take the release date. New
// models are created from a lab file only; dropped models are deleted.

import { z } from "zod";

import { inherited, Labs, REPO_ROOT } from "../catalog.js";
import { getPath } from "../fields.js";
import { fetchJSON } from "../http.js";
import { labHints, namespaceHints } from "../labs.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.empiriolabs.ai/v1/models";
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];
const KINDS = ["text", "audio", "image", "video", "pdf"];

const CANONICAL_BASE_MODELS: Record<string, string> = {
  "mistral-medium-3": "mistral/mistral-medium-2505",
  "mistral-small-4": "mistral/mistral-small-2603",
};

const Parameter = z.object({ name: z.string(), options: z.array(z.string()).optional(), min: z.number().optional(), max: z.number().optional() }).passthrough();

const PricingTier = z.object({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  input_cache_read: z.string().optional(),
  min_context: z.number().nullable().optional(),
}).passthrough();
type PricingTier = z.infer<typeof PricingTier>;

const EmpiriolabsModel = z.object({
  id: z.string(),
  display_name: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  context_length: z.number().nullable().optional(),
  context_window: z.number().nullable().optional(),
  max_output_tokens: z.number().nullable().optional(),
  model_released_at: z.string().nullable().optional(),
  deprecated: z.boolean().nullable().optional(),
  pricing: z.union([z.array(PricingTier), PricingTier]).optional(),
  capabilities: z.record(z.unknown()).optional(),
  features: z.array(z.string()).optional(),
  structured_output: z.string().nullable().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  supported_parameters: z.array(Parameter).optional(),
}).passthrough();
type EmpiriolabsModel = z.infer<typeof EmpiriolabsModel>;

const EmpiriolabsResponse = z.object({ data: z.array(EmpiriolabsModel) }).passthrough();

let labs: Labs | undefined;

export const empiriolabs: SyncModule<unknown> = {
  id: "empiriolabs",
  name: "EmpirioLabs AI",
  policy: {
    owns: [
      "name",
      { path: "release_date", standalone: true },
      { path: "last_updated", standalone: true },
      { path: "status", merge: "deprecated" },
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "capabilities.structured_output",
      "capabilities.temperature",
      { path: "capabilities.cache.implicit", merge: "seed" },
      "limit.context",
      "limit.output",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      { path: "cost.text.input.overrides", merge: "bands" },
      "cost.text.output.price",
      { path: "cost.text.output.overrides", merge: "bands" },
    ],
    creates: "auto",
    removals: "delete",
    omitLabInput: true,
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "EmpirioLabs models" }),
  observe(raw) {
    return EmpiriolabsResponse.parse(raw).data
      .filter((model) => (model.category ?? "").toLowerCase() === "text" && !model.id.includes(":"))
      .flatMap((model) => observe(model));
  },
  // Reasoning controls follow the source whenever the model reasons, which a
  // file (or its lab) can say on its own.
  refine(observation, file) {
    const reasoning = observation.capabilities?.reasoning;
    if (reasoning?.supported === true) return observation;
    labs ??= new Labs(REPO_ROOT);
    const fileReasons = file !== undefined
      && (getPath(file, "capabilities.reasoning.supported") ?? getPath(typeof file.base_model === "string" ? inherited(file, labs) : undefined, "capabilities.reasoning.supported")) === true;
    return { ...observation, capabilities: { ...observation.capabilities, reasoning: fileReasons ? { ...reasoning, supported: true } : { supported: false } } };
  },
};

function observe(model: EmpiriolabsModel): Observation[] {
  const context = model.context_length ?? model.context_window ?? undefined;
  // Without a context window there is no file to write; it's dropped.
  if (context === undefined) return [];
  const features = new Set(model.features ?? []);
  const parameters = model.supported_parameters ?? [];
  const has = (name: string) => parameters.some((parameter) => parameter.name === name);
  const reasoning = model.capabilities?.reasoning === true || features.has("reasoning");
  const structured = model.structured_output === "none" ? false : (model.structured_output != null || features.has("structured_output")) ? true : undefined;
  const outputLimit = model.max_output_tokens ?? parameterOutputLimit(model);
  const standalone = model.model_released_at ?? undefined;
  const base = CANONICAL_BASE_MODELS[model.id];
  return [{
    id: model.id,
    base: base === undefined ? baseHints(model.id) : [base],
    name: model.display_name ?? model.name ?? model.id,
    ...(standalone === undefined ? {} : { release_date: standalone, last_updated: null }),
    ...(model.deprecated === true ? { status: "deprecated" as const } : {}),
    modalities: { input: kinds(model.input_modalities), output: kinds(model.output_modalities) },
    capabilities: {
      ...(features.has("function_calling") || features.has("tools") ? { tools: { supported: true } } : {}),
      reasoning: { supported: reasoning, ...controls(parameters) },
      ...(structured === undefined ? {} : { structured_output: structured }),
      ...(has("temperature") ? { temperature: true } : {}),
      ...(features.has("cache") || features.has("prompt_cache") ? { cache: { implicit: true } } : {}),
    },
    limit: { context, ...(outputLimit === undefined ? {} : { output: outputLimit }) },
    ...cost(model.pricing),
    defaults: { limit: { output: context } },
  } as Observation];
}

// toggle (enable_thinking), effort (reasoning_effort options) and budget
// (thinking_budget); a toggle goes when effort can say `none`.
function controls(parameters: z.infer<typeof Parameter>[]) {
  const effortParameter = parameters.find((parameter) => parameter.name === "reasoning_effort");
  const effort = (effortParameter?.options ?? []).filter((value) => EFFORTS.includes(value)).sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  const budget = parameters.find((parameter) => parameter.name === "thinking_budget");
  const toggle = parameters.some((parameter) => parameter.name === "enable_thinking") && !effort.includes("none");
  return {
    toggle: toggle ? true : null,
    effort: effort.length > 0 ? effort : null,
    budget: budget === undefined ? null : Object.fromEntries(Object.entries({ min: budget.min, max: budget.max }).filter(([, value]) => value !== undefined)),
  };
}

function parameterOutputLimit(model: EmpiriolabsModel) {
  const parameter = (model.supported_parameters ?? []).find((item) => item.name === "max_tokens" || item.name === "max_completion_tokens");
  return parameter?.max !== undefined && parameter.max > 0 ? parameter.max : undefined;
}

function cost(pricing: EmpiriolabsModel["pricing"]) {
  const tiers = pricing === undefined ? [] : Array.isArray(pricing) ? [...pricing].sort((a, b) => (a.min_context ?? 0) - (b.min_context ?? 0)) : [pricing];
  const base = tierCost(tiers[0]);
  if (base === undefined) return {};
  const bands = tiers.slice(1).flatMap((tier) => {
    const prices = tierCost(tier);
    return prices === undefined || tier.min_context == null ? [] : [{ size: tier.min_context, ...prices }];
  });
  const when = (size: number) => ({ context: { gt: size } });
  return {
    cost: {
      text: {
        input: {
          price: base.input,
          cache: { read: base.read ?? null },
          overrides: bands.length === 0 ? null : bands.map((band) => ({ when: when(band.size), price: band.input, ...(band.read === undefined ? {} : { cache: { read: band.read } }) })),
        },
        output: { price: base.output, overrides: bands.length === 0 ? null : bands.map((band) => ({ when: when(band.size), price: band.output })) },
      },
    },
  };
}

function tierCost(tier: PricingTier | undefined) {
  const input = price(tier?.prompt);
  const output = price(tier?.completion);
  if (input === undefined || output === undefined) return undefined;
  const read = price(tier?.input_cache_read);
  return { input, output, read: read !== undefined && read > 0 ? read : undefined };
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000_000_000) / 1_000_000 : undefined;
}

function kinds(values: string[] | undefined) {
  const result = (values ?? []).map((value) => value.toLowerCase()).map((value) => (value === "file" ? "pdf" : value)).filter((value) => KINDS.includes(value));
  return [...new Set(result.length > 0 ? result : ["text"])].map((value) => (value === "pdf" ? "application/pdf" : value));
}

// Lab hints for EmpirioLabs' bare IDs: dotted versions (`glm-5-3` → `glm-5.3`),
// without product suffixes, under the lab their prefix names.
function baseHints(id: string) {
  const hints: string[] = [];
  for (const variant of variants(id)) {
    for (const prefix of prefixes(variant)) {
      hints.push(...namespaceHints(`${prefix}/${variant}`));
      if (prefix === "google" && !variant.endsWith("-it")) hints.push(...namespaceHints(`${prefix}/${variant}-it`));
    }
    hints.push(...labHints(variant));
  }
  return [...new Set(hints)];
}

function dotted(id: string) {
  return id
    .replace(/^(qwen\d+)-(\d+)/, "$1.$2")
    .replace(/^(seed-\d+)-(\d+)/, "$1.$2")
    .replace(/^(muse-[a-z]+)-(\d+)-(\d+)$/, "$1-$2.$3")
    .replace(/^(glm-\d+)-(\d+)/, "$1.$2")
    .replace(/^(kimi-k\d+)-(\d+)/, "$1.$2")
    .replace(/^(minimax-m\d+)-(\d+)/, "$1.$2")
    .replace(/^(mimo-v\d+)-(\d+)/, "$1.$2")
    .replace(/^(deepseek-v\d+)-(\d+)/, "$1.$2")
    .replace(/^(step-\d+)-(\d+)/, "$1.$2");
}

function variants(id: string) {
  const result = [id, dotted(id)];
  const stripped: string[] = [];
  if (/-v\d+(-\d+)?$/.test(id)) {
    const dropPatch = id.replace(/-\d+$/, "");
    if (dropPatch !== id) stripped.push(dropPatch);
    stripped.push(id.replace(/-v\d+(-\d+)?$/, ""));
  }
  if (/-\d{4}$/.test(id)) stripped.push(id.replace(/-\d{4}$/, ""));
  for (const value of stripped) result.push(value, dotted(value));
  return [...new Set(result)];
}

function prefixes(id: string) {
  if (id.startsWith("deepseek-")) return ["deepseek"];
  if (id.startsWith("glm-")) return ["z-ai"];
  if (id.startsWith("kimi-")) return ["moonshotai"];
  if (id.startsWith("minimax-")) return ["minimax"];
  if (id.startsWith("mimo-")) return ["xiaomi"];
  if (id.startsWith("qwen")) return ["qwen"];
  if (id.startsWith("muse-")) return ["meta"];
  if (id.startsWith("seed-")) return ["bytedance-seed"];
  if (id.startsWith("fugu-")) return ["sakana"];
  if (id.startsWith("gemma-")) return ["google"];
  if (id.startsWith("step") && !id.startsWith("stepaudio")) return ["stepfun"];
  if (id.startsWith("mistral-")) return ["mistralai"];
  return [];
}
