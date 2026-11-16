// CoreWeave (W&B Inference): https://trace.wandb.ai/inference/modelsdev/models
// (public), a models.dev-shaped provider list. Authoritative for the name,
// description (when listed), token, cache and audio prices, limits, kinds,
// tools, structured output, temperature, whether a model reasons and if it can
// be toggled, and the reasoning field. It never lists effort levels, so a
// file's efforts stay. A file without a status takes the source's. Files
// without a lab file also take the family, knowledge and open weights. New
// models are created from a lab file or standalone; dropped models are
// deleted.

import { z } from "zod";

import { inferKimiFamily, ModelFamily, ModelFamilyValues } from "../../family.js";
import { Labs, REPO_ROOT } from "../catalog.js";
import { getPath } from "../fields.js";
import { fetchJSON } from "../http.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://trace.wandb.ai/inference/modelsdev/models";
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const ReasoningOption = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }).strict(),
  z.object({ type: z.literal("effort"), values: z.array(z.string()) }).strict(),
  z.object({ type: z.literal("budget_tokens"), min: z.number().optional(), max: z.number().optional() }).strict(),
]);

const WandbModel = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  reasoning: z.boolean(),
  reasoning_options: z.array(ReasoningOption).optional(),
  tool_call: z.boolean(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  knowledge: z.string().optional(),
  release_date: z.string(),
  last_updated: z.string(),
  open_weights: z.boolean(),
  status: z.string().optional(),
  interleaved: z.union([z.boolean(), z.object({ field: z.string() }).passthrough()]).optional(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number().optional(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
    input_audio: z.number().optional(),
    output_audio: z.number().optional(),
  }).passthrough().optional(),
  limit: z.object({ context: z.number(), output: z.number() }).passthrough().optional(),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).passthrough().optional(),
}).passthrough();
type WandbModel = z.infer<typeof WandbModel>;

const WandbResponse = z.record(z.string(), z.object({ models: z.record(z.string(), WandbModel) }).passthrough());

// Host namespaces and the lab directory they name.
const CANONICAL_PREFIXES: Record<string, string> = {
  "deepseek-ai": "deepseek",
  google: "google",
  "meta-llama": "meta",
  MiniMaxAI: "minimax",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  openai: "openai",
  Qwen: "alibaba",
  "zai-org": "zhipuai",
};

const MODALITIES: Record<string, string> = { text: "text", image: "image", audio: "audio", video: "video", pdf: "pdf", file: "pdf", files: "pdf" };

let labs: Labs | undefined;

export const wandb: SyncModule<unknown> = {
  id: "wandb",
  name: "CoreWeave",
  policy: {
    owns: [
      "name",
      "description",
      { path: "family", standalone: true },
      { path: "release_date", standalone: true, createOnly: true },
      { path: "last_updated", standalone: true, createOnly: true },
      { path: "knowledge", standalone: true },
      { path: "open_weights", standalone: true },
      "status",
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "capabilities.structured_output",
      "capabilities.temperature",
      "limit.context",
      "limit.output",
      "api.chat-completions.compatibility.reasoning_field",
      "api.chat-completions.legacy_interleaved",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.output.price",
      "cost.text.output.reasoning",
      "cost.audio.input.price",
      "cost.audio.output.price",
    ],
    creates: "auto",
    removals: "delete",
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "CoreWeave Inference models" }),
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    return Object.values(WandbResponse.parse(raw)).flatMap((provider) => Object.values(provider.models)).map((model) => observe(model, labs!));
  },
  // A file's own status stays, and so do its efforts (the source lists none);
  // a toggle then only stays while the efforts can't turn reasoning off.
  refine(observation, file) {
    if (file === undefined) return observation;
    const { status, ...rest } = observation;
    const effort = getPath(file, "capabilities.reasoning.effort");
    const reasoning = observation.capabilities?.reasoning;
    if (!Array.isArray(effort) || reasoning?.supported !== true) return { ...rest, ...(file.status === undefined ? { status } : {}) } as Observation;
    const toggle = reasoning.toggle === true && !effort.includes("none") ? true : null;
    return {
      ...rest,
      ...(file.status === undefined ? { status } : {}),
      capabilities: { ...observation.capabilities, reasoning: { supported: true, toggle, effort: undefined, budget: null } },
    } as Observation;
  },
};

function observe(model: WandbModel, labs: Labs): Observation {
  const input = kinds(model.modalities?.input ?? []);
  const output = kinds(model.modalities?.output ?? []);
  const options = model.reasoning_options ?? [];
  const effort = options.find((option) => option.type === "effort");
  const budget = options.find((option) => option.type === "budget_tokens");
  const interleaved = model.interleaved === true ? true : model.interleaved === false || model.interleaved === undefined ? undefined : model.interleaved.field;
  const family = inferFamily(model.id, model.name);
  const base = resolveBase(model.id, labs);
  return {
    id: model.id,
    base: base === undefined ? [] : [base],
    name: model.name.replace(/^[^:]+:\s*/, "").trim() || model.id.split("/").at(-1)!,
    ...(model.description === undefined ? {} : { description: model.description }),
    family: family !== undefined && ModelFamily.safeParse(family).success ? family as never : null,
    release_date: model.release_date,
    ...(model.last_updated === model.release_date ? {} : { last_updated: model.last_updated }),
    ...(model.knowledge === undefined ? {} : { knowledge: model.knowledge }),
    open_weights: model.open_weights,
    ...(model.status === undefined ? {} : { status: model.status as never }),
    modalities: { ...(input.length > 0 ? { input } : {}), ...(output.length > 0 ? { output } : {}) },
    capabilities: {
      tools: { supported: model.tool_call },
      reasoning: model.reasoning
        ? {
          supported: true,
          toggle: options.some((option) => option.type === "toggle") ? true : null,
          effort: effort === undefined ? null : effort.values.sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b)) as never,
          budget: budget === undefined ? null : Object.fromEntries(Object.entries({ min: budget.min, max: budget.max }).filter(([, value]) => value !== undefined)),
        }
        : { supported: false },
      structured_output: model.structured_output === true,
      temperature: model.temperature ?? true,
    },
    limit: {
      ...(model.limit === undefined ? {} : { context: model.limit.context, output: model.limit.output }),
    },
    // The reasoning field the source names; a model that names none keeps the file's.
    api: {
      "chat-completions": model.reasoning
        ? {
          ...(interleaved === true ? { legacy_interleaved: true } : {}),
          ...(typeof interleaved === "string" ? { compatibility: { reasoning_field: interleaved } } : {}),
        }
        : { legacy_interleaved: null, compatibility: { reasoning_field: null } },
    },
    ...(model.cost === undefined ? {} : {
      cost: {
        text: {
          input: { price: model.cost.input, cache: { read: positive(model.cost.cache_read) ?? null, write: positive(model.cost.cache_write) ?? null } },
          output: { price: model.cost.output, reasoning: model.cost.reasoning ?? null },
        },
        audio: { input: { price: model.cost.input_audio ?? null }, output: { price: model.cost.output_audio ?? null } },
      },
    }),
    defaults: { limit: { context: 0, output: 0 } },
  } as Observation;
}

function positive(value: number | undefined) {
  return value !== undefined && value > 0 ? value : undefined;
}

function kinds(values: string[]) {
  return [...new Set(values.map((value) => MODALITIES[value.toLowerCase()]).filter((value): value is string => value !== undefined))]
    .map((value) => (value === "pdf" ? "application/pdf" : value));
}

// The longest family named in the ID or name (Kimi by its own rules). No fuzzy fallback.
function inferFamily(id: string, name: string) {
  const kimi = inferKimiFamily(id, name);
  if (kimi !== undefined) return kimi;
  return [...ModelFamilyValues].sort((a, b) => b.length - a.length).find((family) => id.toLowerCase().includes(family.toLowerCase()) || name.toLowerCase().includes(family.toLowerCase()));
}

// The one lab file in the namespace's lab whose name matches a spelling of the ID.
function resolveBase(id: string, labs: Labs) {
  const [prefix, ...parts] = id.split("/");
  if (prefix === undefined || parts.length === 0) return undefined;
  const namespace = CANONICAL_PREFIXES[prefix];
  if (namespace === undefined) return undefined;
  const lower = parts.join("/").toLowerCase();
  const candidates = [...new Set([
    parts.join("/"),
    lower,
    lower.replace(/^nvidia-/, ""),
    lower.replace(/^nvidia-/, "").replace(/-fp8$/, ""),
    lower.replace(/-(?:instruct|thinking)-2507$/, ""),
    ...(namespace === "alibaba" ? [lower.replace(/-a22b-(?:instruct|thinking)-2507$/, "-a22b")] : []),
  ])];
  const files = labs.all().filter((lab) => lab.startsWith(`${namespace}/`));
  for (const candidate of candidates) {
    const matches = files.filter((lab) => {
      const filename = lab.slice(namespace.length + 1);
      return filename === candidate || normalize(filename) === normalize(candidate) || normalize(lab) === normalize(`${namespace}/${candidate}`);
    });
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

function normalize(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}
