// Mistral: https://api.mistral.ai/v1/models (MISTRAL_API_KEY). The list is
// scoped to the key's workspace and drops retired models, so a file it no
// longer lists is kept and reported. It has no prices, output limits or
// reasoning controls, so new models are added by hand.
// Authoritative: context window, tool calling, whether a model reasons, image
// and audio input, deprecation, and the FIM, moderation and OCR APIs.
// Reasoning controls aren't listed; for each reasoning model the fetch asks
// chat/completions with an unsupported reasoning_effort and reads the accepted
// values from the rejection. A file whose effort list differs is reported.

import { z } from "zod";

import { bearer, fetchJSON, requireEnv } from "../http.js";
import type { Observation, SyncModule } from "../types.js";
import { reasoningControls } from "../units.js";

const API_BASE = "https://api.mistral.ai/v1";
const EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// Mistral rejects an unsupported effort with the model's accepted values, but
// silently accepts the value on some models (zai-glm-5-2). "minimal" is the
// least likely value to be supported, so it gives the most useful rejection.
const PROBE_EFFORT = "minimal";
// /v1/models still serves these rows with `deprecation: null`, but Mistral's
// model docs list them as deprecated or retired:
// https://github.com/mistralai/platform-docs-public/tree/main/src/schema/models/models
const DEPRECATED_IDS = new Set([
  // Leanstral 1.5 (leanstral-1-5.ts): deprecated 2026-09-29, retired 2026-09-30.
  "labs-leanstral-1-5-1",
  // Z.ai GLM 5.2 (zai-glm-5-2.ts): deprecated 2026-09-29, retires 2026-10-31.
  "glm-5-2",
  "zai-glm-5-2",
  // Magistral Medium 1.2 (magistral-medium-1-2-25-09.ts): deprecated 2026-05-22, retired 2026-07-31.
  "magistral-medium-latest",
]);

const MistralCapabilities = z.object({
  completion_chat: z.boolean(),
  completion_fim: z.boolean().optional(),
  function_calling: z.boolean(),
  reasoning: z.boolean(),
  vision: z.boolean(),
  audio: z.boolean(),
  moderation: z.boolean().optional(),
  ocr: z.boolean().optional(),
}).passthrough();

const MistralModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  capabilities: MistralCapabilities,
  max_context_length: z.number().int().positive(),
  aliases: z.array(z.string()),
  deprecation: z.string().nullable(),
}).passthrough();
type MistralModel = z.infer<typeof MistralModel>;

const MistralResponse = z.object({
  object: z.literal("list"),
  data: z.array(MistralModel),
}).passthrough();

// The probe's result per model name: the accepted values, [] when reasoning_effort
// isn't enabled, null when the probe couldn't tell.
const Raw = MistralResponse.extend({ reasoning_efforts: z.record(z.array(z.string()).nullable()).optional() });

// The APIs besides chat (POST /v1/fim/completions, /v1/moderations, /v1/ocr).
// No AI SDK or OpenCode package calls them.
const NO_PACKAGE = { sdk: { aisdk: "none", opencodeai: "none" } };

export const mistral: SyncModule<unknown> = {
  id: "mistral",
  name: "Mistral",
  policy: {
    owns: [
      "limit.context",
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      { path: "capabilities.reasoning.effort", merge: "report" },
      { path: "modalities.input", merge: "kinds", only: ["image", "audio"] },
      { path: "status", merge: "deprecated" },
      { path: "api", merge: "tables" },
    ],
    creates: "gap",
    removals: "keep",
  },
  async fetch() {
    const key = requireEnv("Mistral", "MISTRAL_API_KEY");
    const models = MistralResponse.parse(await fetchJSON(`${API_BASE}/models`, { source: "Mistral models", headers: bearer(key) }));
    // Aliases share their canonical model's controls, so probe each model once.
    const names = [...new Set(models.data.filter((model) => model.capabilities.completion_chat && model.capabilities.reasoning).map((model) => model.name))];
    const efforts: Record<string, string[] | null> = {};
    for (const name of names) efforts[name] = (await probeReasoningEfforts(name, key)) ?? null;
    return { ...models, reasoning_efforts: efforts };
  },
  observe(raw) {
    const { data, reasoning_efforts: efforts = {} } = Raw.parse(raw);
    return data.map((model) => observe(model, efforts[model.name] ?? undefined));
  },
};

function observe(model: MistralModel, efforts: string[] | undefined): Observation {
  const { capabilities } = model;
  const api = apis(capabilities);
  // Every alias is its own row. A model is reported once, under the row named
  // after it; aliases and non-chat rows only update files that exist.
  const updateOnly = !capabilities.completion_chat || model.id !== model.name;
  // Embedding, OCR, moderation, transcription and TTS rows carry no chat metadata.
  if (!capabilities.completion_chat) return { id: model.id, updateOnly, ...(api ? { api } : {}) };
  return {
    id: model.id,
    ...(updateOnly ? { updateOnly } : {}),
    limit: { context: model.max_context_length },
    capabilities: {
      tools: { supported: capabilities.function_calling },
      reasoning: capabilities.reasoning
        ? { supported: true, ...(efforts === undefined ? {} : { effort: efforts.length > 0 ? reasoningControls({ effort: efforts }).effort! : null }) }
        : { supported: false },
    },
    modalities: {
      input: ["text", ...(capabilities.vision ? ["image"] : []), ...(capabilities.audio ? ["audio"] : [])],
    },
    status: model.deprecation !== null || DEPRECATED_IDS.has(model.id) ? "deprecated" : null,
    ...(api ? { api } : {}),
  };
}

function apis(capabilities: MistralModel["capabilities"]) {
  const tables: Record<string, typeof NO_PACKAGE> = {};
  if (capabilities.completion_fim) tables.fim = NO_PACKAGE;
  if (capabilities.moderation) tables.moderations = NO_PACKAGE;
  if (capabilities.ocr) tables.ocr = NO_PACKAGE;
  return Object.keys(tables).length > 0 ? tables : undefined;
}

async function probeReasoningEfforts(model: string, key: string) {
  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: { ...bearer(key), "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], reasoning_effort: PROBE_EFFORT, max_tokens: 1 }),
    });
    if (response.ok) return undefined;
    const body = await response.json() as { message?: unknown };
    return typeof body.message === "string" ? parseSupportedEfforts(body.message) : undefined;
  } catch (error) {
    console.warn(`Mistral reasoning_effort probe failed for ${model}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** Reads the accepted values from Mistral's reasoning_effort rejection. */
export function parseSupportedEfforts(message: string): string[] | undefined {
  if (/reasoning_effort is not enabled/i.test(message)) return [];
  const list = message.split(/supported values|must be one of/i)[1];
  if (list === undefined) return undefined;
  const values = new Set([...list.matchAll(/'([a-z]+)'/g)].map((match) => match[1]!));
  const known = EFFORT_VALUES.filter((value) => values.has(value));
  return known.length === values.size && known.length > 0 ? known : undefined;
}
