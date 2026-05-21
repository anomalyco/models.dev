import { z } from "zod";

import type { SyncProvider } from "../index.js";

const API_BASE = "https://api.fireworks.ai/v1";

const FireworksModel = z.object({
  name: z.string(),
}).passthrough();

const FireworksResponse = z.object({
  models: z.array(FireworksModel).optional(),
  nextPageToken: z.string().optional(),
}).passthrough();

type FireworksModel = z.infer<typeof FireworksModel>;

export const fireworksAi = {
  id: "fireworks-ai",
  name: "Fireworks AI",
  modelsDir: "providers/fireworks-ai/models",
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return model.name;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Fireworks AI models returned by the API were not created because the Models API does not provide pricing, output token limits, release dates, or complete capability metadata. Existing models are preserved unchanged.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.FIREWORKS_API_KEY;
    if (key === undefined) {
      throw new Error("Fireworks AI sync requires FIREWORKS_API_KEY");
    }

    const models: FireworksModel[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${API_BASE}/accounts/fireworks/models`);
      url.searchParams.set("pageSize", "200");
      url.searchParams.set("filter", "supports_serverless = true");
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!response.ok) {
        throw new Error(`Fireworks AI models request failed: ${response.status} ${response.statusText}`);
      }

      const page = FireworksResponse.parse(await response.json());
      models.push(...page.models ?? []);
      pageToken = page.nextPageToken || undefined;
    } while (pageToken !== undefined);

    return { models };
  },
  parseModels(raw) {
    return FireworksResponse.parse(raw).models ?? [];
  },
  translateModel(model, context) {
    const existing = context.existing(model.name);
    if (existing === undefined) return undefined;

    return {
      id: model.name,
      model: existing,
    };
  },
} satisfies SyncProvider<FireworksModel>;
