// OVHcloud AI Endpoints: https://catalog.endpoints.ai.ovh.net/rest/v2/openrouter
// (public), an OpenRouter-style list. Authoritative for token and cache
// prices, context and output limits, input and output kinds, tools, whether
// a model reasons, and the name. It only says when structured output and
// temperature are supported: a missing structured output keeps the file's,
// a missing temperature drops it. Reasoning controls are hand-authored. Model
// IDs are lowercased. New models are standalone files; dropped models are
// deleted.

import { z } from "zod";

import { describeModel } from "../../describe.js";
import { fetchJSON } from "../http.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://catalog.endpoints.ai.ovh.net/rest/v2/openrouter";
const KINDS = ["text", "audio", "image", "video", "pdf"];

const OvhcloudModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  hugging_face_id: z.string().nullable().optional(),
  context_length: z.number(),
  max_output_length: z.number().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  pricing: z.object({
    prompt: z.string().optional(),
    completion: z.string().optional(),
    input_cache_reads: z.string().optional(),
    input_cache_writes: z.string().optional(),
  }).passthrough().optional(),
  supported_features: z.array(z.string()).optional(),
  supported_sampling_parameters: z.array(z.string()).optional(),
}).passthrough();
type OvhcloudModel = z.infer<typeof OvhcloudModel>;

const OvhcloudResponse = z.object({ data: z.array(OvhcloudModel) }).passthrough();

export const ovhcloud: SyncModule<unknown> = {
  id: "ovhcloud",
  name: "OVHcloud AI Endpoints",
  policy: {
    owns: [
      "name",
      { path: "description", createOnly: true },
      { path: "release_date", standalone: true, createOnly: true },
      { path: "open_weights", standalone: true },
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      "capabilities.structured_output",
      "capabilities.temperature",
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
  fetch: () => fetchJSON(API_ENDPOINT, { source: "OVHcloud models" }),
  observe: (raw) => OvhcloudResponse.parse(raw).data.map(observe),
};

function observe(model: OvhcloudModel): Observation {
  const features = new Set(model.supported_features ?? []);
  const input = kinds(model.input_modalities ?? ["text"]);
  const output = kinds(model.output_modalities ?? ["text"]);
  const reasoning = features.has("reasoning");
  const tools = features.has("tools");
  const structured = features.has("structured_outputs");
  const openWeights = Boolean(model.hugging_face_id);
  const cacheRead = price(model.pricing?.input_cache_reads);
  const cacheWrite = price(model.pricing?.input_cache_writes);
  return {
    id: model.id.toLowerCase(),
    name: model.name,
    description: describeModel({
      id: model.id,
      name: model.name,
      reasoning,
      tool_call: tools,
      structured_output: structured || undefined,
      open_weights: openWeights,
      limit: { context: model.context_length, output: model.max_output_length ?? model.context_length },
      modalities: { input: input as never, output: output as never },
    }),
    release_date: new Date(model.created * 1000).toISOString().slice(0, 10),
    open_weights: openWeights,
    modalities: { input: mime(input), output: mime(output) },
    capabilities: {
      tools: { supported: tools },
      reasoning: { supported: reasoning },
      ...(structured ? { structured_output: true } : {}),
      temperature: model.supported_sampling_parameters?.includes("temperature") ? true : null,
    },
    limit: { context: model.context_length, ...(model.max_output_length === undefined ? {} : { output: model.max_output_length }) },
    cost: {
      text: {
        input: {
          price: price(model.pricing?.prompt) ?? 0,
          cache: { read: positive(cacheRead) ?? null, write: positive(cacheWrite) ?? null },
        },
        output: { price: price(model.pricing?.completion) ?? 0 },
      },
    },
    defaults: { limit: { output: model.context_length } },
  } as Observation;
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000_000_000) / 1_000_000 : undefined;
}

function positive(value: number | undefined) {
  return value !== undefined && value > 0 ? value : undefined;
}

function kinds(values: string[]) {
  const result = values.map((value) => value.toLowerCase()).map((value) => (value === "file" ? "pdf" : value)).filter((value) => KINDS.includes(value));
  return [...new Set(result.length > 0 ? result : ["text"])];
}

function mime(values: string[]) {
  return values.map((value) => (value === "pdf" ? "application/pdf" : value));
}
