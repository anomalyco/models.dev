// Vercel AI Gateway: https://ai-gateway.vercel.sh/v1/models (public). Language
// and decision models own their token and cache prices (tiered prices as
// context bands), context and output limits (OpenAI's input limit is the
// window minus the output), input and output kinds from the catalog's tags,
// reasoning controls from its reasoning_options (else the file's, else the
// file of its `-free` route's base or of its lab ID), tool_choice narrowed to
// the lab's, the cache kinds the catalog tags, the Responses and Messages
// APIs, and the Decisions API for decision models. A file keeps its own name,
// description, family and tool and reasoning support. Image, video,
// embedding, rerank, speech, transcription and realtime files are generated
// whole (rebuild). Symlinked files are left alone; dropped models are deleted.
//
// The media builder, the cache rule and the chat API tables are the old
// module's (../../sync/providers/vercel.ts).

import { z } from "zod";

import { buildVercelMediaModel, chatApis, realtimePriceNote, vercelCache, VercelModel } from "../../sync/providers/vercel.js";
import { describeModel } from "../../describe.js";
import { Labs, REPO_ROOT } from "../catalog.js";
import { getPath, isTable } from "../fields.js";
import { namespaceHints } from "../labs.js";
import type { Doc, Observation, SyncModule } from "../types.js";
import { inferFamily } from "../units.js";

type Model = z.infer<typeof VercelModel>;

const OUTPUT_LIMIT_OVERRIDES: Record<string, number> = {
  "alibaba/qwen3.6-27b": 65_536,
  "amazon/nova-2-lite": 65_535,
  "bytedance/seed-1.8": 32_768,
  "deepseek/deepseek-v3.1-terminus": 32_768,
  "inception/mercury-2": 50_000,
  "minimax/minimax-m2": 196_608,
  "quiverai/arrow-2": 65_536,
  "quiverai/arrow-2-telos": 65_536,
  "zai/glm-5-turbo": 131_072,
};
// No `vision` tag, but Vercel's docs say they take images:
// https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions#input
const VISION_MODELS = new Set(["openai/gpt-6-luna-decisions"]);
// Still listed, but every call fails upstream (Prodia: "Job type is no longer available", 2026-10-28).
const RETIRED_MODELS = new Set(["prodia/flux-fast-schnell"]);
const MEDIA_TYPES = new Set(["image", "video", "embedding", "reranking", "speech", "transcription", "realtime"]);
const MEDIA_HEADERS: Record<string, string> = {
  image: "# Synced from https://ai-gateway.vercel.sh/v1/models (type image)\n# https://vercel.com/docs/ai-gateway/modalities/image-generation\n",
  video: "# Synced from https://ai-gateway.vercel.sh/v1/models (type video)\n# https://vercel.com/docs/ai-gateway/modalities/video-generation\n",
  embedding: "# Synced from https://ai-gateway.vercel.sh/v1/models (type embedding)\n# https://vercel.com/docs/ai-gateway/modalities/embeddings\n",
  reranking: "# Synced from https://ai-gateway.vercel.sh/v1/models (type reranking)\n# https://vercel.com/docs/ai-gateway/modalities/reranking\n",
  speech: "# Synced from https://ai-gateway.vercel.sh/v1/models (type speech)\n# https://vercel.com/docs/ai-gateway/modalities/text-to-speech\n",
  transcription: "# Synced from https://ai-gateway.vercel.sh/v1/models (type transcription)\n# https://vercel.com/docs/ai-gateway/modalities/speech-to-text\n",
  realtime: "# Synced from https://ai-gateway.vercel.sh/v1/models (type realtime)\n# https://vercel.com/docs/ai-gateway/modalities/realtime\n",
};
// Decision models: POST /v1/decisions, OpenAI's Decisions format.
// https://vercel.com/docs/ai-gateway/modalities/decision
const DECISION_APIS = {
  decisions: {
    base_url: "https://ai-gateway.vercel.sh/v1",
    sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/vercel-ai-gateway/decisions" },
  },
};
const DECISION_DESCRIPTION = "Decision model for typed evaluation of shared state";
const TOGGLE_HEADER = "# Toggle: reasoning.enabled = true|false\n# https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/reasoning";
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];

const Option = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }).strict(),
  z.object({ type: z.literal("effort"), values: z.array(z.enum(EFFORTS as [string, ...string[]])) }).strict(),
  z.object({ type: z.literal("budget_tokens"), min: z.number().min(-1).optional(), max: z.number().min(0).optional() }).strict(),
]);

let labs: Labs | undefined;

export const vercel: SyncModule<unknown> = {
  id: "vercel",
  name: "Vercel AI Gateway",
  policy: {
    owns: [
      "type",
      "name",
      "description",
      { path: "family", standalone: true },
      { path: "release_date", standalone: true },
      { path: "open_weights", standalone: true },
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.reasoning.supported",
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "capabilities.tools.supported",
      "capabilities.tools.choice",
      "capabilities.cache",
      "limit.context",
      "limit.input",
      "limit.output",
      "api",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      { path: "cost.text.input.overrides", merge: "bands" },
      "cost.text.output.price",
      { path: "cost.text.output.overrides", merge: "bands" },
    ],
    creates: "auto",
    removals: "delete",
    omitLabInput: true,
  },
  async fetch() {
    const response = await fetch("https://ai-gateway.vercel.sh/v1/models");
    if (!response.ok) throw new Error(`Vercel AI Gateway request failed: ${response.status} ${response.statusText}`);
    return response.json();
  },
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    // Batch routes (`*-batch`) aren't catalog targets.
    const models = z.object({ data: z.array(VercelModel) }).passthrough().parse(raw).data
      .filter((model) => !model.id.endsWith("-batch") && !RETIRED_MODELS.has(model.id));
    return models.map(observe);
  },
  refine(observation, file, files) {
    const model = catalog.get(observation.id)!;
    if (MEDIA_TYPES.has(model.type)) {
      const { schema: _schema, base_model: _base, base_model_omit: _omit, ...body } = buildVercelMediaModel(model, model.type as never, file);
      const cache = vercelCache(model);
      if (cache !== undefined) body.capabilities = { ...body.capabilities, cache: cache(getPath(file, "capabilities.cache") as never) };
      return { ...observation, ...body } as Observation;
    }
    const base = typeof file?.base_model === "string" ? file.base_model : resolveBase(model.id);
    const lab = base === undefined ? undefined : labs!.get(base);
    const resolved = (path: string) => getPath(file, path) ?? (file === undefined || typeof file.base_model === "string" ? getPath(lab, path) : undefined);
    const tags = tagsOf(model);
    const refined: Doc = structuredClone({ ...observation, header: undefined });
    const capabilities = (refined.capabilities ??= {}) as Doc;

    // OpenAI's input limit is the window minus the output, the file's when the catalog has none.
    if (model.id.startsWith("openai/")) {
      const context = (getPath(refined, "limit.context") ?? resolved("limit.context") ?? 0) as number;
      const output = (getPath(refined, "limit.output") ?? resolved("limit.output") ?? 0) as number;
      (refined.limit as Doc).input = context > output ? context - output : null;
    }

    // Reasoning controls: the catalog's, else the file's, else its sibling's.
    const reasons = file === undefined ? tags.has("reasoning") : resolved("capabilities.reasoning.supported") === true;
    if (reasons) {
      const controls = catalogControls(model.reasoning_options);
      if (controls !== undefined) capabilities.reasoning = { ...(capabilities.reasoning as Doc), ...controls };
      else if (!hasControls(file)) {
        const route = model.id.endsWith("-free") ? model.id.slice(0, -"-free".length) : undefined;
        const sibling = route !== undefined ? files.get(route) : base !== undefined && base !== model.id ? files.get(base) : undefined;
        const own = getPath(sibling, "capabilities.reasoning");
        if (isTable(own) && hasControls(sibling)) {
          const { supported: _supported, ...rest } = own;
          capabilities.reasoning = { ...(capabilities.reasoning as Doc), toggle: rest.toggle ?? null, effort: rest.effort ?? null, budget: rest.budget ?? null };
        }
      }
    }
    const reasoning = getPath(capabilities, "reasoning") as Doc | undefined;
    if (reasoning?.toggle === true) refined.header = TOGGLE_HEADER;

    // tool_choice takes every documented value, narrowed to the lab's; one equal to the lab's is inherited.
    if (model.type === "language") {
      const tools = file === undefined ? tags.has("tool-use") : resolved("capabilities.tools.supported") === true;
      const labChoice = getPath(lab, "capabilities.tools.choice") as string[] | undefined;
      const choice = ["auto", "none", "required", "tool"].filter((value) => labChoice?.includes(value) ?? true);
      const same = labChoice !== undefined && choice.length === labChoice.length && choice.every((value) => labChoice.includes(value));
      const listed = tools && model.supported_parameters.includes("tool_choice") && !same;
      capabilities.tools = { ...(capabilities.tools as Doc), choice: listed ? choice : null };
    }
    const cache = vercelCache(model);
    if (cache !== undefined) capabilities.cache = cache(getPath(file, "capabilities.cache") as never);

    const type = getPath(file, "type") ?? getPath(lab, "type") ?? "chat";
    if (model.type === "evaluation") refined.api = structuredClone(DECISION_APIS);
    else if (model.type === "language" && type === "chat") refined.api = chatApis(file?.api as Doc | undefined);

    // A family the old substring matcher stamped as "o" heals to the inferred one.
    const family = inferFamily(model.id, model.name);
    if (file?.family === "o" && family !== "o") refined.family = family ?? null;
    if (refined.header === undefined) delete refined.header;
    return refined as Observation;
  },
};

// Catalog rows by ID, for refine.
const catalog = new Map<string, Model>();

function observe(model: Model): Observation {
  catalog.set(model.id, model);
  const hints = baseHints(model.id);
  if (MEDIA_TYPES.has(model.type)) return { id: model.id, base: hints, rebuild: {}, header: MEDIA_HEADERS[model.type] + realtimePriceNote(model) };

  const tags = tagsOf(model);
  const decision = model.type === "evaluation";
  const context = model.context_window > 0 ? model.context_window : undefined;
  const output = OUTPUT_LIMIT_OVERRIDES[model.id] ?? (model.max_tokens > 0 ? model.max_tokens : undefined);
  const input = model.id.startsWith("openai/") && (context ?? 0) > (output ?? 0) ? (context ?? 0) - (output ?? 0) : undefined;
  const modalities = {
    input: ["text", ...(tags.has("vision") ? ["image"] : []), ...(tags.has("file-input") ? ["application/pdf"] : [])],
    output: tags.has("video-generation") ? ["video"] : tags.has("image-generation") ? ["text", "image"] : ["text"],
  };
  const releaseDate = model.released ? new Date(model.released * 1000).toISOString().slice(0, 10) : undefined;
  const family = inferFamily(model.id, model.name);
  const toolUse = tags.has("tool-use");
  const reasoning = tags.has("reasoning");
  const base = hints.map((hint) => labs!.find(hint)).find((found) => found !== undefined);
  const description = decision
    ? (base === undefined ? model.description ?? DECISION_DESCRIPTION : undefined)
    : describeModel({
        id: model.id,
        name: model.name,
        family: family as never,
        reasoning,
        tool_call: toolUse,
        open_weights: false,
        limit: { context: context ?? 0, input, output: output ?? 0 },
        modalities: { input: modalities.input.map((value) => (value === "application/pdf" ? "pdf" : value)) as never, output: modalities.output as never },
      });
  return {
    id: model.id,
    base: hints,
    ...(decision ? { type: "decision" } : {}),
    ...(releaseDate === undefined ? {} : { release_date: releaseDate }),
    modalities,
    capabilities: decision ? { tools: { supported: toolUse } } : {},
    limit: { ...(context === undefined ? {} : { context }), input: input ?? null, ...(output === undefined ? {} : { output }) },
    ...cost(model),
    defaults: {
      name: model.name,
      ...(description === undefined ? {} : { description }),
      ...(family === undefined ? {} : { family }),
      release_date: releaseDate ?? new Date().toISOString().slice(0, 10),
      open_weights: false,
      capabilities: { tools: { supported: toolUse }, reasoning: { supported: reasoning } },
      limit: { context: 0, output: 0 },
    },
  } as Observation;
}

function tagsOf(model: Model) {
  return new Set(VISION_MODELS.has(model.id) ? [...model.tags, "vision"] : model.tags);
}

// The catalog's reasoning_options as controls; undefined when it has none or one doesn't parse.
function catalogControls(options: unknown[] | undefined) {
  if (options === undefined) return undefined;
  const parsed = options.map((option) => Option.safeParse(option));
  if (parsed.some((result) => !result.success)) return undefined;
  const list = parsed.map((result) => result.data!);
  const effort = list.find((option) => option.type === "effort") as { values: string[] } | undefined;
  const budget = list.find((option) => option.type === "budget_tokens") as Doc | undefined;
  // An effort of "none" already turns reasoning off; no separate toggle.
  const toggle = list.some((option) => option.type === "toggle") && !effort?.values.includes("none");
  const { type: _type, ...range } = budget ?? {};
  return { toggle: toggle ? true : null, effort: effort?.values ?? null, budget: budget === undefined ? null : range };
}

function hasControls(file: Doc | undefined) {
  const reasoning = getPath(file, "capabilities.reasoning");
  return isTable(reasoning) && Object.keys(reasoning).some((key) => key !== "supported");
}

// Token and cache prices, with tiered prices as context bands.
function cost(model: Model) {
  const pricing = model.pricing;
  const tiered = (value: string | undefined, tiers: Array<{ cost: string; min?: number; max?: number }> | undefined) => {
    const base = price(value);
    const normalized = (tiers ?? [])
      .map((tier, index, values) => ({ start: tier.min ?? (index === 0 ? 0 : values[index - 1]?.max ?? 0), cost: price(tier.cost) }))
      .filter((tier): tier is { start: number; cost: number } => tier.cost !== undefined)
      .sort((a, b) => a.start - b.start);
    return {
      base: normalized[0]?.cost ?? base,
      thresholds: normalized.map((tier) => tier.start).filter((start) => start > 0),
      at: (threshold: number) => normalized.findLast((tier) => tier.start <= threshold)?.cost ?? base,
    };
  };
  const input = tiered(pricing?.input, pricing?.input_tiers);
  const output = tiered(pricing?.output, pricing?.output_tiers);
  const read = tiered(pricing?.input_cache_read, pricing?.input_cache_read_tiers);
  const write = tiered(pricing?.input_cache_write, pricing?.input_cache_write_tiers);
  if (input.base === undefined || output.base === undefined) return {};
  const hasTiers = [pricing?.input_tiers, pricing?.output_tiers, pricing?.input_cache_read_tiers, pricing?.input_cache_write_tiers].some((tiers) => (tiers?.length ?? 0) > 0);
  const bands: Array<{ input: Doc; output: Doc }> = [];
  let previous = JSON.stringify({ input: input.base, output: output.base, read: read.base, write: write.base });
  for (const size of [...new Set([...input.thresholds, ...output.thresholds, ...read.thresholds, ...write.thresholds])].sort((a, b) => a - b)) {
    const band = { input: input.at(size), output: output.at(size), read: read.at(size), write: write.at(size) };
    if (band.input === undefined || band.output === undefined) continue;
    if (JSON.stringify(band) === previous) continue;
    previous = JSON.stringify(band);
    const cache = { ...(band.read === undefined ? {} : { read: band.read }), ...(band.write === undefined ? {} : { write: band.write }) };
    bands.push({
      input: { when: { context: { gt: size } }, price: band.input, ...(Object.keys(cache).length > 0 ? { cache } : {}) },
      output: { when: { context: { gt: size } }, price: band.output },
    });
  }
  const overrides = (side: "input" | "output") => (hasTiers ? { overrides: bands.length > 0 ? bands.map((band) => band[side]) : null } : {});
  return {
    cost: {
      text: {
        input: { price: input.base, cache: { read: read.base ?? null, write: write.base ?? null }, ...overrides("input") },
        output: { price: output.base, ...overrides("output") },
      },
    },
  };
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000_000_000) / 1_000_000 : undefined;
}

// The lab for an ID, else for its `-free` route's base.
function baseHints(id: string) {
  const route = id.endsWith("-free") ? id.slice(0, -"-free".length) : undefined;
  return [...namespaceHints(id), ...(route === undefined ? [] : namespaceHints(route))];
}

function resolveBase(id: string) {
  return baseHints(id).map((hint) => labs!.find(hint)).find((found) => found !== undefined);
}
