// LLM Gateway: https://api.llmgateway.io/v1/models (LLMGATEWAY_API_KEY
// optional), text models only. Two providers read it:
//
// - `llmgateway` (DevPass) lists one entry per model. Existing files take the
//   token, cache and reasoning prices (a zero or missing cache or reasoning
//   price keeps the file's), the context window, an output limit only where
//   neither the file nor its lab has one, and the effort levels any route
//   advertises (a file with a toggle keeps its controls; other controls stay).
// - `llmgateway-providers` reads the mapped view (`?mapped=true`): one entry
//   per upstream route, `<provider>/<model>`. Existing files also take the
//   route's vision (no vision drops image and PDF input), tools, reasoning,
//   structured output, max output and audio input price. Its effort levels
//   (or a bare toggle for `["none"]`) replace the file's, which otherwise come
//   from the file or the matching DevPass file; that file also lends its
//   reasoning field and context bands to a file without them.
//
// New models are created from a lab file (by family namespace), or
// standalone; dropped models are deleted.

import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { describeModel } from "../../describe.js";
import { readProviderModel, toV1Modality } from "../../translate.js";
import { inherited, Labs, REPO_ROOT } from "../catalog.js";
import { getPath, isTable } from "../fields.js";
import { bearer, fetchJSON } from "../http.js";
import { labHints } from "../labs.js";
import type { Doc, Observation, SyncModule } from "../types.js";
import { inferFamily } from "../units.js";

const API_ENDPOINT = "https://api.llmgateway.io/v1/models";
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];
const KINDS = ["text", "audio", "image", "video", "pdf"];
const CANONICAL_FAMILY_ALIASES: Record<string, string> = { grok: "xai", mistral: "mistralai", moonshot: "moonshotai" };
const BASE_MODEL_ALIASES: Record<string, string> = { "glm-5-2": "zhipuai/glm-5.2", "grok-4-6": "xai/grok-4.6" };
const TOGGLE_HEADER = `# Toggle: $.reasoning_effort = "none" disables thinking; any other accepted
# value (or omitting the field) leaves it on. The gateway maps it to the
# deployment's thinking switch.
# https://docs.llmgateway.io/features/reasoning
`;

const LLMGatewayModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  family: z.string().optional(),
  architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }).passthrough(),
  providers: z.array(z.object({
    vision: z.boolean().optional(),
    tools: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    reasoning_efforts: z.array(z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"])).optional(),
  }).passthrough()).optional(),
  pricing: z.object({
    prompt: z.string().optional(),
    completion: z.string().optional(),
    internal_reasoning: z.string().optional(),
    input_audio: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }).passthrough(),
  context_length: z.number().optional(),
  max_output: z.number().optional(),
  supported_parameters: z.array(z.string()),
  structured_outputs: z.boolean().optional(),
}).passthrough();
type LLMGatewayModel = z.infer<typeof LLMGatewayModel>;

const LLMGatewayResponse = z.object({ data: z.array(LLMGatewayModel) }).passthrough();

const OWNS = [
  { path: "name", createOnly: true },
  { path: "description", standalone: true, createOnly: true },
  { path: "family", standalone: true, createOnly: true },
  { path: "release_date", standalone: true, createOnly: true },
  { path: "open_weights", standalone: true, createOnly: true },
  { path: "modalities.input", merge: "kinds" },
  { path: "modalities.output", merge: "kinds" },
  "capabilities.tools.supported",
  "capabilities.reasoning.supported",
  "capabilities.reasoning.toggle",
  "capabilities.reasoning.effort",
  "capabilities.reasoning.budget",
  "capabilities.structured_output",
  { path: "capabilities.temperature", standalone: true, createOnly: true },
  "limit.context",
  "limit.output",
  "api.chat-completions.legacy_interleaved",
  "api.chat-completions.compatibility.reasoning_field",
  "cost.text.input.price",
  "cost.text.input.cache.read",
  "cost.text.input.cache.write",
  { path: "cost.text.input.overrides", merge: "bands" },
  "cost.text.output.price",
  "cost.text.output.reasoning",
  { path: "cost.text.output.overrides", merge: "bands" },
  "cost.audio.input.price",
] as const;

let labs: Labs | undefined;
const sources = new Map<string, LLMGatewayModel>();

export const llmgateway: SyncModule<unknown> = {
  id: "llmgateway",
  name: "DevPass (LLM Gateway)",
  policy: { owns: [...OWNS], creates: "auto", removals: "delete" },
  fetch: () => fetchModels(API_ENDPOINT),
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    const data = LLMGatewayResponse.parse(raw).data.filter(textOnly);
    if (data.length === 0) throw new Error("LLM Gateway returned no text models");
    // IDs differing only in case are one model; the last one listed wins.
    const unique = [...new Map(data.map((model) => [model.id.toLowerCase(), model])).values()];
    return unique.flatMap((model) => {
      sources.set(`llmgateway:${model.id}`, model);
      return createAggregated(model, labs!);
    });
  },
  refine(observation, file) {
    if (file === undefined) return observation;
    return updateAggregated(sources.get(`llmgateway:${observation.id}`)!, file, labs!);
  },
};

export const llmgatewayProviders: SyncModule<unknown> = {
  id: "llmgateway-providers",
  name: "LLM Gateway",
  policy: { owns: [...OWNS], creates: "auto", removals: "delete" },
  fetch: () => fetchModels(`${API_ENDPOINT}?mapped=true`),
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    const data = LLMGatewayResponse.parse(raw).data;
    if (data.length === 0 || !data.every((model) => model.id.includes("/"))) {
      throw new Error("LLM Gateway mapped view unavailable: response is empty or contains unprefixed model ids");
    }
    const mapped = data.filter((model) => !model.id.startsWith("llmgateway/") && textOnly(model));
    if (mapped.length === 0) throw new Error("LLM Gateway mapped view returned no text models");
    const malformed = mapped.filter((model) => model.providers?.length !== 1);
    if (malformed.length > 0) {
      throw new Error(`LLM Gateway mapped view returned entries without exactly one provider mapping: ${malformed.map((model) => model.id).join(", ")}`);
    }
    return mapped.flatMap((model) => {
      sources.set(`mapped:${model.id}`, model);
      return createMapped(model, labs!);
    });
  },
  refine(observation, file) {
    if (file === undefined) return observation;
    return updateMapped(sources.get(`mapped:${observation.id}`)!, file, labs!);
  },
};

function fetchModels(url: string) {
  const key = process.env.LLMGATEWAY_API_KEY;
  return fetchJSON(url, { source: "LLM Gateway models", headers: key ? bearer(key) : {} });
}

function textOnly(model: LLMGatewayModel) {
  const output = model.architecture.output_modalities;
  return output.length === 1 && output[0] === "text";
}

// ---------------------------------------------------------------------------
// DevPass (aggregated)
// ---------------------------------------------------------------------------

function createAggregated(model: LLMGatewayModel, labs: Labs): Observation[] {
  const context = served(model);
  const canonical = resolveBase(model, model.id, labs);
  const efforts = advertisedEfforts(model);
  if (canonical !== undefined) {
    const labOutput = getPath(labs.get(canonical), "limit.output");
    return [{
      id: model.id,
      base: [canonical],
      name: model.name,
      ...(efforts === undefined ? {} : { capabilities: { reasoning: { effort: efforts as never } } }),
      ...(context === undefined ? {} : { limit: { context, ...(labOutput === undefined ? { output: context } : {}) } }),
      ...cost(model, false),
    } as Observation];
  }
  // A standalone file needs a context window; without one the model is skipped.
  if (context === undefined) return [{ id: model.id, updateOnly: true }];
  const reasoning = reasons(model);
  const tools = model.supported_parameters.includes("tools") || model.supported_parameters.includes("tool_choice");
  const input = kinds(model.architecture.input_modalities);
  const output = kinds(model.architecture.output_modalities);
  const family = inferFamily(model.id, model.name);
  return [{
    id: model.id,
    base: [],
    name: model.name,
    description: describeModel({
      id: model.id, name: model.name, family, reasoning, tool_call: tools, structured_output: model.structured_outputs ?? false,
      open_weights: false, limit: { context, output: context }, modalities: { input: input as never, output: output as never },
    }),
    ...(family === undefined ? {} : { family: family as never }),
    release_date: date(model.created),
    open_weights: false,
    modalities: { input: mime(input), output: mime(output) },
    capabilities: {
      tools: { supported: tools },
      reasoning: { supported: reasoning, ...(efforts === undefined ? {} : { effort: efforts as never }) },
      structured_output: model.structured_outputs ?? false,
      temperature: model.supported_parameters.includes("temperature"),
    },
    limit: { context, output: context },
    ...cost(model, reasoning),
  } as Observation];
}

function updateAggregated(model: LLMGatewayModel, file: Doc, labs: Labs): Observation {
  const resolved = resolveFile(file, labs);
  const context = served(model);
  const efforts = advertisedEfforts(model);
  const toggle = getPath(file, "capabilities.reasoning.toggle") === true;
  const outputLimit = getPath(resolved, "limit.output");
  return {
    id: model.id,
    ...(efforts === undefined || toggle ? {} : { capabilities: { reasoning: { effort: efforts as never } } }),
    limit: {
      ...(context === undefined ? {} : { context }),
      ...(outputLimit === undefined && (context ?? getPath(resolved, "limit.context")) !== undefined ? { output: context ?? getPath(resolved, "limit.context") } : {}),
    },
    ...cost(model, true),
  } as Observation;
}

// ---------------------------------------------------------------------------
// LLM Gateway (mapped routes)
// ---------------------------------------------------------------------------

function createMapped(model: LLMGatewayModel, labs: Labs): Observation[] {
  const mapping = model.providers?.[0];
  const root = model.id.split("/").slice(1).join("/");
  const sibling = siblingCuration(root);
  const context = served(model);
  const reasoning = mapping?.reasoning ?? reasons(model);
  const options = deploymentOptions(mapping?.reasoning_efforts) ?? sibling.reasoning;
  const controls = reasoning ? options : undefined;
  const interleaved = reasoning ? sibling.interleaved : undefined;
  const canonical = resolveBase(model, root, labs);
  const header = (doc: Doc) => (getPath(doc, "capabilities.reasoning.toggle") === true ? TOGGLE_HEADER : "");
  if (canonical !== undefined) {
    const labOutput = getPath(labs.get(canonical), "limit.output");
    const outputLimit = model.max_output ?? (labOutput === undefined ? context : undefined);
    return [{
      id: model.id,
      base: [canonical],
      name: model.name,
      ...(mapping?.vision === false ? { modalities: deploymentModalities(model, false) } : {}),
      capabilities: {
        ...(mapping?.tools === undefined ? {} : { tools: { supported: mapping.tools } }),
        ...(mapping?.reasoning === undefined && controls === undefined ? {} : { reasoning: { ...(mapping?.reasoning === undefined ? {} : { supported: mapping.reasoning }), ...(controls ?? {}) } }),
        ...(model.structured_outputs === undefined ? {} : { structured_output: model.structured_outputs }),
      },
      ...(context === undefined ? {} : { limit: { context, ...(outputLimit === undefined ? {} : { output: outputLimit }) } }),
      ...field(interleaved),
      ...mappedCost(model, reasoning, sibling.bands),
      header,
    } as Observation];
  }
  if (context === undefined) return [{ id: model.id, updateOnly: true }];
  const modalities = deploymentModalities(model, mapping?.vision);
  const family = inferFamily(model.id, model.name);
  const outputLimit = model.max_output || context;
  return [{
    id: model.id,
    base: [],
    name: model.name,
    description: describeModel({
      id: model.id, name: model.name, family, reasoning, tool_call: mapping?.tools ?? false, structured_output: model.structured_outputs ?? false,
      open_weights: false, limit: { context, output: outputLimit }, modalities: { input: modalities.input.map(toV1Modality) as never, output: modalities.output as never },
    }),
    ...(family === undefined ? {} : { family: family as never }),
    release_date: date(model.created),
    open_weights: false,
    modalities,
    capabilities: {
      tools: { supported: mapping?.tools ?? false },
      reasoning: { supported: reasoning, ...(controls ?? {}) },
      structured_output: model.structured_outputs ?? false,
      temperature: model.supported_parameters.includes("temperature"),
    },
    limit: { context, output: outputLimit },
    ...field(interleaved),
    ...mappedCost(model, reasoning, sibling.bands),
    header,
  } as Observation];
}

function updateMapped(model: LLMGatewayModel, file: Doc, labs: Labs): Observation {
  const mapping = model.providers?.[0];
  const root = model.id.split("/").slice(1).join("/");
  const sibling = siblingCuration(root);
  const resolved = resolveFile(file, labs);
  const base = typeof file.base_model === "string";
  const reasoning = mapping?.reasoning ?? (getPath(resolved, "capabilities.reasoning.supported") as boolean | undefined) ?? reasons(model);
  const own = controlsOf(getPath(file, "capabilities.reasoning"));
  const curated = own ?? sibling.reasoning;
  const deployment = deploymentOptions(mapping?.reasoning_efforts);
  const controls = !reasoning ? undefined : deployment !== undefined ? { ...(curated?.budget === undefined ? { budget: null } : { budget: curated.budget }), ...deployment } : curated;
  const ownField = getPath(file, "api.chat-completions.compatibility.reasoning_field") !== undefined || getPath(file, "api.chat-completions.legacy_interleaved") === true;
  const context = served(model);
  const servedOutput = model.max_output || undefined;
  const fileOutput = getPath(resolved, "limit.output");
  const labOutput = base ? getPath(inherited(file, labs), "limit.output") : undefined;
  const outputLimit = servedOutput ?? (fileOutput !== undefined ? undefined : base && labOutput !== undefined ? undefined : context ?? getPath(resolved, "limit.context"));
  const hasBands = Array.isArray(getPath(file, "cost.text.input.overrides"));
  return {
    id: model.id,
    ...(mapping?.vision === undefined ? {} : {
      modalities: mapping.vision
        ? (base ? { input: null, output: null } : deploymentModalities(model, true))
        : deploymentModalities(model, false),
    }),
    capabilities: {
      ...(mapping?.tools === undefined ? {} : { tools: { supported: mapping.tools } }),
      reasoning: reasoning
        ? { ...(mapping?.reasoning === undefined ? {} : { supported: true }), ...(controls === undefined ? {} : { toggle: controls.toggle ?? null, effort: controls.effort ?? null, budget: controls.budget ?? null }) }
        : { supported: false },
      ...(model.structured_outputs === undefined ? {} : { structured_output: model.structured_outputs }),
    },
    limit: { ...(context === undefined ? {} : { context }), ...(outputLimit === undefined ? {} : { output: outputLimit }) },
    ...(!reasoning ? { api: { "chat-completions": { legacy_interleaved: null, compatibility: { reasoning_field: null } } } } : ownField ? {} : field(sibling.interleaved)),
    ...mappedCost(model, true, hasBands ? undefined : sibling.bands),
  } as Observation;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

type Controls = { toggle?: true; effort?: string[]; budget?: Record<string, number> };

function controlsOf(table: unknown): Controls | undefined {
  if (!isTable(table)) return undefined;
  const controls: Controls = {};
  if (table.toggle === true) controls.toggle = true;
  if (Array.isArray(table.effort)) controls.effort = table.effort as string[];
  if (isTable(table.budget)) controls.budget = table.budget as Record<string, number>;
  return Object.keys(controls).length > 0 ? controls : undefined;
}

// A route's efforts: a bare toggle for `["none"]`, else the levels.
function deploymentOptions(efforts: string[] | undefined): Controls | undefined {
  if (efforts === undefined || efforts.length === 0) return undefined;
  if (efforts.length === 1 && efforts[0] === "none") return { toggle: true };
  return { effort: sortEfforts(efforts) };
}

function advertisedEfforts(model: LLMGatewayModel) {
  const advertised = new Set((model.providers ?? []).flatMap((provider) => provider.reasoning_efforts ?? []));
  return advertised.size === 0 ? undefined : sortEfforts([...advertised]);
}

function sortEfforts(efforts: string[]) {
  return [...efforts].sort((a, b) => {
    const order = (EFFORT_ORDER.indexOf(a) + 1 || Number.MAX_SAFE_INTEGER) - (EFFORT_ORDER.indexOf(b) + 1 || Number.MAX_SAFE_INTEGER);
    return order || a.localeCompare(b);
  });
}

// The matching DevPass file's reasoning controls, reasoning field and context bands.
const siblings = new Map<string, { reasoning?: Controls; interleaved?: string | true; bands?: { input: unknown[]; output: unknown[] } }>();

function siblingCuration(root: string) {
  let curation = siblings.get(root);
  if (curation === undefined) {
    const file = path.join(REPO_ROOT, "providers", "llmgateway", "models", `${root}.toml`);
    const model = existsSync(file) ? readProviderModel(file) as Record<string, any> : undefined;
    const options = model?.reasoning_options as Array<{ type: string; values?: string[]; min?: number; max?: number }> | undefined;
    const tiers = model?.cost?.tiers as Array<Record<string, any>> | undefined;
    curation = {
      reasoning: options?.length ? Object.assign({}, ...options.map((option) => option.type === "toggle" ? { toggle: true } : option.type === "effort" ? { effort: option.values } : option.type === "budget_tokens" ? { budget: Object.fromEntries(Object.entries({ min: option.min, max: option.max }).filter(([, value]) => value !== undefined)) } : {})) : undefined,
      interleaved: model?.interleaved === true ? true : model?.interleaved?.field,
      bands: tiers === undefined ? undefined : {
        input: tiers.map((tier) => ({ when: { context: { gt: tier.tier.size } }, price: tier.input, ...(tier.cache_read === undefined && tier.cache_write === undefined ? {} : { cache: { ...(tier.cache_read === undefined ? {} : { read: tier.cache_read }), ...(tier.cache_write === undefined ? {} : { write: tier.cache_write }) } }) })),
        output: tiers.map((tier) => ({ when: { context: { gt: tier.tier.size } }, price: tier.output, ...(tier.reasoning === undefined ? {} : { reasoning: tier.reasoning }) })),
      },
    };
    siblings.set(root, curation);
  }
  return curation;
}

function field(interleaved: string | true | undefined) {
  if (interleaved === undefined) return {};
  return { api: { "chat-completions": interleaved === true ? { legacy_interleaved: true } : { compatibility: { reasoning_field: interleaved } } } };
}

// Token prices; zero or missing cache and reasoning prices keep the file's.
function cost(model: LLMGatewayModel, _reasoning: boolean) {
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  if (prompt === undefined || completion === undefined) return {};
  const read = nonZero(model.pricing.input_cache_read);
  const write = nonZero(model.pricing.input_cache_write);
  const reasoning = nonZero(model.pricing.internal_reasoning);
  return {
    cost: {
      text: {
        input: { price: prompt, cache: { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) } },
        output: { price: completion, ...(reasoning === undefined ? {} : { reasoning }) },
      },
    },
  };
}

function mappedCost(model: LLMGatewayModel, reasoning: boolean, bands: { input: unknown[]; output: unknown[] } | undefined) {
  const base = cost(model, reasoning);
  if (base.cost === undefined) return {};
  const audio = nonZero(model.pricing.input_audio);
  return {
    cost: {
      text: {
        input: { ...base.cost.text.input, ...(bands === undefined ? {} : { overrides: bands.input }) },
        output: { ...base.cost.text.output, ...(bands === undefined ? {} : { overrides: bands.output }) },
      },
      ...(audio === undefined ? {} : { audio: { input: { price: audio } } }),
    },
  };
}

function resolveBase(model: LLMGatewayModel, id: string, labs: Labs) {
  const alias = BASE_MODEL_ALIASES[id];
  if (alias !== undefined) return labs.find(alias) ?? alias;
  if (model.family === undefined) return undefined;
  const prefix = CANONICAL_FAMILY_ALIASES[model.family] ?? model.family;
  for (const hint of labHints(`${prefix}/${id}`)) {
    const found = labs.find(hint);
    if (found !== undefined) return found;
  }
  return undefined;
}

function resolveFile(file: Doc, labs: Labs): Doc {
  if (typeof file.base_model !== "string") return file;
  const lab = inherited(file, labs) ?? {};
  return { ...lab, ...file, limit: { ...(lab.limit as Doc | undefined), ...(file.limit as Doc | undefined) }, capabilities: { ...(lab.capabilities as Doc | undefined), ...(file.capabilities as Doc | undefined) } };
}

function reasons(model: LLMGatewayModel) {
  return model.supported_parameters.includes("reasoning") || model.supported_parameters.includes("include_reasoning");
}

function served(model: LLMGatewayModel) {
  return (model.context_length ?? 0) > 0 ? model.context_length : undefined;
}

// The model's kinds, without image and PDF input on a route without vision.
function deploymentModalities(model: LLMGatewayModel, vision: boolean | undefined) {
  const input = kinds(model.architecture.input_modalities);
  const output = kinds(model.architecture.output_modalities);
  const narrowed = vision === false ? input.filter((value) => value !== "image" && value !== "pdf") : input;
  return { input: mime(narrowed.length > 0 ? narrowed : ["text"]), output: mime(output) };
}

function kinds(values: string[]) {
  const result = values.map((value) => value.toLowerCase()).map((value) => (value === "file" ? "pdf" : value)).filter((value) => KINDS.includes(value));
  return [...new Set(result.length > 0 ? result : ["text"])];
}

function mime(values: string[]) {
  return values.map((value) => (value === "pdf" ? "application/pdf" : value));
}

function date(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000_000_000) / 1_000_000 : undefined;
}

function nonZero(value: string | undefined) {
  const result = price(value);
  return result !== undefined && result > 0 ? result : undefined;
}
