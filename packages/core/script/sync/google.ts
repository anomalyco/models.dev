import { z } from "zod";

import type { ExistingModel, SyncProvider } from "../sync-models.js";

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
    return {
      id,
      model: buildModel(id, model, context.existing(id)),
    };
  },
} satisfies SyncProvider<GoogleModel>;

function buildModel(id: string, model: GoogleModel, existing: ExistingModel | undefined) {
  const methods = new Set(model.supportedGenerationMethods ?? []);
  const modalities = inferModalities(id, methods, existing);
  const today = new Date().toISOString().slice(0, 10);

  return {
    name: model.displayName ?? existing?.name ?? id,
    family: existing?.family ?? inferFamily(id),
    release_date: existing?.release_date ?? today,
    last_updated: existing?.last_updated ?? today,
    attachment: modalities.input.some((value) => value !== "text"),
    reasoning: model.thinking ?? existing?.reasoning ?? false,
    temperature: model.temperature !== undefined || model.maxTemperature !== undefined
      ? true
      : (existing?.temperature ?? false),
    tool_call: existing?.tool_call ?? false,
    structured_output: existing?.structured_output,
    knowledge: existing?.knowledge,
    open_weights: id.startsWith("gemma-") || (existing?.open_weights ?? false),
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost: existing?.cost,
    limit: {
      context: model.inputTokenLimit,
      input: existing?.limit?.input,
      output: model.outputTokenLimit,
    },
    modalities,
  };
}

function inferFamily(id: string) {
  if (id.startsWith("gemini-embedding")) return "gemini-embedding";
  if (id.includes("flash-lite")) return "gemini-flash-lite";
  if (id.includes("flash")) return "gemini-flash";
  if (id.includes("pro")) return "gemini-pro";
  if (id.startsWith("gemini-")) return "gemini";
  if (id.startsWith("gemma-")) return "gemma";
  if (id.startsWith("imagen-")) return "imagen";
  if (id.startsWith("veo-")) return "veo";
  if (id.startsWith("lyria-")) return "lyria";
  return undefined;
}

function inferModalities(id: string, methods: Set<string>, existing: ExistingModel | undefined) {
  if (id.startsWith("imagen-")) {
    return { input: ["text"], output: ["image"] } as const;
  }
  if (id.startsWith("veo-")) {
    return { input: ["text", "image"], output: ["video"] } as const;
  }
  if (id.startsWith("lyria-")) {
    return { input: ["text"], output: ["audio"] } as const;
  }
  if (id.includes("tts")) {
    return { input: ["text"], output: ["audio"] } as const;
  }
  if (id.includes("native-audio") || id.includes("live")) {
    return existing?.modalities ?? { input: ["text", "image", "audio", "video"], output: ["text", "audio"] };
  }
  if (methods.has("embedContent") || methods.has("asyncBatchEmbedContent")) {
    return existing?.modalities ?? { input: ["text"], output: ["text"] };
  }
  return existing?.modalities ?? { input: ["text"], output: ["text"] };
}
