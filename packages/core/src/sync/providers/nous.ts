import { z } from "zod";

import { OpenRouterModel, buildOpenRouterModel } from "./openrouter.js";
import type { SyncProvider } from "../index.js";

const API_ENDPOINT = "https://inference-api.nousresearch.com/v1/models";
const NousResponse = z.object({ data: z.array(z.unknown()) }).passthrough();

export const nous = {
  id: "nous",
  name: "Nous Research",
  modelsDir: "providers/nous/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Nous Research request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // The catalog includes incomplete records for models that are not callable.
    // Validate entries individually so those stubs cannot block usable models.
    return NousResponse.parse(raw).data.flatMap((entry) => {
      const parsed = OpenRouterModel.safeParse(entry);
      if (!parsed.success) return [];

      const model = parsed.data;
      return !model.id.startsWith("~")
        && model.architecture.input_modalities.includes("text")
        && model.architecture.output_modalities.includes("text")
        ? [model]
        : [];
    });
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildOpenRouterModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<OpenRouterModel>;
