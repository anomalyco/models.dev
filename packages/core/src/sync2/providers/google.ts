// Google (Gemini API): https://generativelanguage.googleapis.com/v1beta/models
// (GOOGLE_API_KEY, GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY).
// Authoritative: display name, token limits (except where the model card
// says otherwise), whether a model thinks, and whether it takes a temperature.
// The list has no modalities, prices or dates, and keeps shut-down, alias and
// early-access IDs, so new models are added by hand and not reported.

import { z } from "zod";

import { fetchJSON, requireEnv } from "../http.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const GoogleModel = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  inputTokenLimit: z.number().int().nonnegative(),
  outputTokenLimit: z.number().int().nonnegative(),
  temperature: z.number().optional(),
  maxTemperature: z.number().optional(),
  thinking: z.boolean().optional(),
}).passthrough();
type GoogleModel = z.infer<typeof GoogleModel>;

const GoogleResponse = z.object({
  models: z.array(GoogleModel).optional(),
  nextPageToken: z.string().optional(),
}).passthrough();

// The generic Models API reports different token limits for these endpoints
// than Google's model cards, which win:
// https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image
// https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image
// https://ai.google.dev/gemini-api/docs/models/gemini-2.5-computer-use-preview-10-2025
// https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image
// https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1
const DOCUMENTED_LIMITS: Record<string, { context?: number; output?: number }> = {
  "gemini-2.5-computer-use-preview-10-2025": { context: 128_000, output: 64_000 },
  "gemini-3-pro-image": { context: 65_536, output: 32_768 },
  "gemini-3.1-flash-image": { context: 131_072, output: 32_768 },
  "gemini-3.1-flash-lite-image": { context: 65_536, output: 4_096 },
  "gemini-nano-banana-2.1": { context: 131_072, output: 32_768 },
};

const TRACKED = ["deep-research-", "gemini-", "gemma-", "imagen-", "lyria-", "nano-banana-", "veo-"];

export const google: SyncModule<unknown> = {
  id: "google",
  name: "Google",
  policy: {
    owns: ["name", "limit.context", "limit.output", "capabilities.reasoning.supported", "capabilities.temperature"],
    creates: "never",
    removals: "delete",
  },
  async fetch() {
    const key = requireEnv("Google", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY");
    const models: unknown[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(API_ENDPOINT);
      url.searchParams.set("pageSize", "1000");
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
      const page = GoogleResponse.parse(await fetchJSON(url.toString(), { source: "Google models", headers: { "x-goog-api-key": key } }));
      models.push(...page.models ?? []);
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return { models };
  },
  observe(raw) {
    return (GoogleResponse.parse(raw).models ?? []).map(observe);
  },
};

function observe(model: GoogleModel): Observation {
  const id = model.name.replace(/^models\//, "");
  return {
    id,
    // Other families (aqa, antigravity, codenames) aren't catalog models; they only keep a file that exists.
    ...(TRACKED.some((prefix) => id.startsWith(prefix)) ? {} : { updateOnly: true }),
    name: model.displayName,
    limit: { context: model.inputTokenLimit, output: model.outputTokenLimit, ...DOCUMENTED_LIMITS[id] },
    capabilities: {
      ...(model.thinking === undefined ? {} : { reasoning: { supported: model.thinking } }),
      ...(model.temperature !== undefined || model.maxTemperature !== undefined ? { temperature: true } : {}),
    },
  };
}
