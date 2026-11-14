// Charm Hyper: https://hyper.charm.land/v1/models (HYPER_API_KEY optional).
// Authoritative for token and cache prices, context and output limits, image
// input and reasoning efforts. A model without a reasoning object has no
// controls: a lab-based file keeps the lab's reasoning with none, a
// standalone one doesn't reason. A zero cache price removes the file's, an
// unlisted one keeps it. Lab-based files take their name from the lab. New
// models are created from a lab file, or standalone with tool calling and
// closed weights; dropped models are deleted.

import { z } from "zod";

import { describeModel } from "../../describe.js";
import { Labs, REPO_ROOT } from "../catalog.js";
import { bearer, fetchJSON } from "../http.js";
import { labHints } from "../labs.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://hyper.charm.land/v1/models";
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];

const HyperModel = z.object({
  id: z.string(),
  created: z.number(),
  display_name: z.string(),
  context_window: z.number(),
  max_output_tokens: z.number(),
  capabilities: z.object({ vision: z.boolean().optional() }).passthrough().optional(),
  reasoning: z.object({ effort_levels: z.array(z.object({ value: z.string(), display: z.string().optional() })).optional() }).passthrough().optional(),
  pricing: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
    cache_hit: z.number().optional(),
    cache_create: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();
type HyperModel = z.infer<typeof HyperModel>;

const HyperResponse = z.object({ data: z.array(HyperModel) }).passthrough();

let labs: Labs | undefined;

export const hyper: SyncModule<unknown> = {
  id: "hyper",
  name: "Charm Hyper",
  policy: {
    owns: [
      { path: "name", createOnly: true },
      { path: "description", standalone: true, createOnly: true },
      { path: "release_date", standalone: true, createOnly: true },
      { path: "last_updated", standalone: true, createOnly: true },
      { path: "open_weights", standalone: true, createOnly: true },
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      { path: "capabilities.tools.supported", standalone: true, createOnly: true },
      "capabilities.reasoning.supported",
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "limit.context",
      "limit.output",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.output.price",
    ],
    creates: "auto",
    removals: "delete",
  },
  fetch: () => {
    const key = process.env.HYPER_API_KEY;
    return fetchJSON(API_ENDPOINT, { source: "Hyper models", headers: key ? bearer(key) : {} });
  },
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    return HyperResponse.parse(raw).data.map((model) => observe(model, labs!));
  },
};

function observe(model: HyperModel, labs: Labs): Observation {
  const hints = labHints(model.id);
  const lab = hints.map((hint) => labs.find(hint)).find((found) => found !== undefined);
  const labReasons = lab !== undefined && (labs.get(lab)?.capabilities as { reasoning?: { supported?: boolean } } | undefined)?.reasoning?.supported === true;
  const input = model.capabilities?.vision ? ["text", "image"] : ["text"];
  const context = model.context_window;
  const advertised = model.reasoning != null;
  const reasoning = advertised ? controls(model) : lab !== undefined ? (labReasons ? { supported: true, toggle: null, effort: null, budget: null } : undefined) : { supported: false };
  const name = model.display_name;
  return {
    id: model.id,
    base: lab === undefined ? [] : [lab],
    name: lab === undefined ? name : null,
    description: describeModel({
      id: model.id,
      name,
      reasoning: advertised,
      tool_call: true,
      open_weights: false,
      limit: { context, output: model.max_output_tokens },
      modalities: { input: input as never, output: ["text"] },
    }),
    release_date: new Date(model.created * 1000).toISOString().slice(0, 10),
    last_updated: new Date().toISOString().slice(0, 10),
    open_weights: false,
    modalities: { input, output: ["text"] },
    capabilities: {
      tools: { supported: true },
      ...(reasoning === undefined ? {} : { reasoning }),
    },
    limit: { context, output: model.max_output_tokens },
    ...cost(model.pricing),
  } as Observation;
}

// Effort levels low to high, or a bare toggle when none is a known level.
function controls(model: HyperModel) {
  const levels = model.reasoning?.effort_levels?.map((level) => level.value) ?? [];
  if (levels.length === 0) return { supported: true, toggle: null, effort: null, budget: null };
  const effort = levels.filter((value) => EFFORT_ORDER.includes(value)).sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return effort.length === 0 ? { supported: true, toggle: true, effort: null, budget: null } : { supported: true, toggle: null, effort, budget: null };
}

function cost(pricing: HyperModel["pricing"]) {
  if (pricing?.input === undefined || pricing.output === undefined) return {};
  // A zero cache price is none; an unlisted one keeps the file's.
  const cache = (value: number | undefined) => (value === undefined ? undefined : value > 0 ? price(value) : null);
  const read = cache(pricing.cache_hit);
  const write = cache(pricing.cache_create);
  return {
    cost: {
      text: {
        input: { price: price(pricing.input), cache: { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) } },
        output: { price: price(pricing.output) },
      },
    },
  };
}

function price(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
