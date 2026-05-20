import { z } from "zod";

import type { SyncProvider } from "../sync-models.js";

const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const GoogleModel = z.object({
  name: z.string(),
  baseModelId: z.string().optional(),
  version: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  inputTokenLimit: z.number().int().nonnegative(),
  outputTokenLimit: z.number().int().nonnegative(),
  supportedGenerationMethods: z.array(z.string()).optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  maxTemperature: z.number().optional(),
  thinking: z.boolean().optional(),
}).passthrough();

const GoogleResponse = z.object({
  models: z.array(GoogleModel).optional(),
  nextPageToken: z.string().optional(),
}).passthrough();

type GoogleModel = z.infer<typeof GoogleModel>;

export const google = {
  id: "google",
  name: "Google",
  modelsDir: "providers/google/models",
  deletionOnly: true,
  sourceID(model) {
    return model.name.replace(/^models\//, "");
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Google models returned by the API were not created because the Models API does not provide authoritative modalities, pricing, knowledge cutoff, release date, tool calling, or structured output metadata.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.GOOGLE_API_KEY
      ?? process.env.GEMINI_API_KEY
      ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (key === undefined) {
      throw new Error("Google sync requires GOOGLE_API_KEY, GEMINI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY");
    }

    const models: GoogleModel[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(API_ENDPOINT);
      url.searchParams.set("key", key);
      url.searchParams.set("pageSize", "1000");
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Google models request failed: ${response.status} ${response.statusText}`);
      }

      const page = GoogleResponse.parse(await response.json());
      models.push(...page.models ?? []);
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);

    return { models };
  },
  parseModels(raw) {
    return GoogleResponse.parse(raw).models ?? [];
  },
  translateModel(model, context) {
    const id = model.name.replace(/^models\//, "");
    const existing = context.existing(id);
    if (existing === undefined) return undefined;

    return {
      id,
      model: existing,
    };
  },
} satisfies SyncProvider<GoogleModel>;
