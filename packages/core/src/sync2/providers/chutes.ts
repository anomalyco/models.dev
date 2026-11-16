// Chutes: https://llm.chutes.ai/v1/models (public). Authoritative for token
// and cache-read prices, context and output limits, input and output kinds,
// reasoning, tool calling, structured output and temperature. A new file gets
// a display name from the ID and a generated description; one without a lab
// file also gets a family and release date. TEE builds of a lab's model
// (`Qwen/Qwen3.6-27B-TEE`) inherit from it. Dropped models are deleted.

import { z } from "zod";

import { describeModel } from "../../describe.js";
import { fetchJSON } from "../http.js";
import type { Observation, SyncModule } from "../types.js";
import { inferFamily } from "../units.js";

const API_ENDPOINT = "https://llm.chutes.ai/v1/models";

const ORG_LABS: Record<string, string> = {
  MiniMaxAI: "minimax",
  Qwen: "alibaba",
  XiaomiMiMo: "xiaomi",
  "deepseek-ai": "deepseek",
  google: "google",
  moonshotai: "moonshotai",
  openai: "openai",
  "zai-org": "zhipuai",
};

const BASE_MODEL_ALIASES: Record<string, string> = {
  "google/gemma-4-31B-turbo-TEE": "google/gemma-4-31b-it",
  // unsloth re-hosts many labs' models, so it has no org mapping.
  "unsloth/Mistral-Nemo-Instruct-2407-TEE": "mistral/mistral-nemo",
};

const KINDS = ["text", "audio", "image", "video", "pdf"];

const ChutesModel = z.object({
  id: z.string(),
  created: z.number(),
  pricing: z.object({ prompt: z.number().optional(), completion: z.number().optional(), input_cache_read: z.number().optional() }).passthrough().optional(),
  context_length: z.number().optional(),
  max_output_length: z.number().optional(),
  max_model_len: z.number().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  supported_features: z.array(z.string()).optional(),
  supported_sampling_parameters: z.array(z.string()).optional(),
}).passthrough();
type ChutesModel = z.infer<typeof ChutesModel>;

const ChutesResponse = z.object({ data: z.array(ChutesModel) }).passthrough();

export const chutes: SyncModule<unknown> = {
  id: "chutes",
  name: "Chutes",
  policy: {
    owns: [
      { path: "name", createOnly: true },
      { path: "description", createOnly: true },
      { path: "family", standalone: true, createOnly: true },
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
      "cost.text.output.price",
    ],
    creates: "auto",
    removals: "delete",
    omitLabInput: true,
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "Chutes models" }),
  observe: (raw) => ChutesResponse.parse(raw).data.map(observe),
};

function observe(model: ChutesModel): Observation {
  const features = new Set(model.supported_features ?? []);
  const sampling = new Set(model.supported_sampling_parameters ?? []);
  const input = kinds(model.input_modalities ?? ["text"]);
  const output = kinds(model.output_modalities ?? ["text"]);
  const reasoning = features.has("reasoning");
  const tools = features.has("tools");
  const structured = features.has("structured_outputs");
  const name = (model.id.split("/").at(-1) ?? model.id).replace(/-/g, " ");
  const base = baseHints(model.id);
  const family = inferFamily(model.id, name);
  // A 0 or missing window isn't a smaller one: the file's stays.
  const context = (model.context_length ?? model.max_model_len ?? 0) || undefined;
  const outputLimit = (model.max_output_length ?? 0) || undefined;
  const pricing = model.pricing;
  return {
    id: model.id,
    base,
    name,
    description: describeModel({
      id: model.id,
      name,
      family: base.length === 0 ? family : undefined,
      reasoning,
      tool_call: tools,
      structured_output: structured ? true : undefined,
      open_weights: true,
      limit: { context: context ?? 0, output: outputLimit ?? 0 },
      modalities: { input: input as never, output: output as never },
    }),
    ...(family === undefined ? {} : { family: family as never }),
    release_date: new Date(model.created * 1000).toISOString().slice(0, 10),
    open_weights: true,
    modalities: { input: mime(input), output: mime(output) },
    capabilities: {
      tools: { supported: tools },
      reasoning: { supported: reasoning },
      ...(structured ? { structured_output: true } : {}),
      // Without sampling parameters listed, temperature is assumed tunable.
      temperature: sampling.size > 0 ? sampling.has("temperature") : true,
    },
    ...(context === undefined && outputLimit === undefined ? {} : { limit: { ...(context && { context }), ...(outputLimit && { output: outputLimit }) } }),
    ...(pricing?.prompt === undefined || pricing.completion === undefined ? {} : {
      cost: {
        text: {
          input: { price: round(pricing.prompt), cache: { read: pricing.input_cache_read === undefined ? null : round(pricing.input_cache_read) } },
          output: { price: round(pricing.completion) },
        },
      },
    }),
  };
}

// USD per 1M tokens already; this only rounds away float noise.
function round(price: number) {
  return Math.round(price * 1e10) / 1e10;
}

function kinds(values: string[]) {
  const result = [...new Set(values.map((value) => value.toLowerCase()).filter((value) => KINDS.includes(value)))];
  return result.length > 0 ? result : ["text"];
}

function mime(values: string[]) {
  return values.map((value) => (value === "pdf" ? "application/pdf" : value));
}

// A TEE build (`<org>/<model>-TEE`) of a lab's model; other spellings tried
// are lowercase and `-turbo` as `-it` or dropped. Distinct checkpoints
// (`-Thinking-2507`) keep their own lab files.
function baseHints(id: string) {
  const alias = BASE_MODEL_ALIASES[id];
  const [org, ...rest] = id.split("/");
  const lab = org === undefined ? undefined : ORG_LABS[org];
  const model = rest.join("/");
  if (lab === undefined || rest.length === 0 || !model.endsWith("-TEE")) return alias === undefined ? [] : [alias];
  const withoutTee = model.slice(0, -"-TEE".length);
  const lower = withoutTee.toLowerCase();
  return [...new Set([
    ...(alias === undefined ? [] : [alias]),
    ...[withoutTee, lower, lower.replace(/-turbo$/, "-it"), lower.replace(/-turbo$/, "")].map((candidate) => `${lab}/${candidate}`),
  ])];
}
