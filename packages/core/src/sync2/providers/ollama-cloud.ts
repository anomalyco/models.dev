// Ollama Cloud: https://ollama.com/v1/models (public). The list carries only IDs,
// so it owns no fields: every file is hand-authored (script/generate-ollama-cloud.ts
// drafts them from /api/show). New IDs are gaps; files the list drops are kept
// for review.

import { z } from "zod";

import { fetchJSON } from "../http.js";
import type { SyncModule } from "../types.js";

const OllamaCloudResponse = z.object({
  object: z.literal("list"),
  data: z.array(z.object({ id: z.string().min(1), object: z.literal("model"), created: z.number().int().nonnegative(), owned_by: z.string() }).passthrough()),
}).passthrough();

export const ollamaCloud: SyncModule<unknown> = {
  id: "ollama-cloud",
  name: "Ollama Cloud",
  policy: { owns: [], creates: "gap", removals: "keep" },
  fetch: () => fetchJSON("https://ollama.com/v1/models", { source: "Ollama Cloud models" }),
  observe: (raw) => OllamaCloudResponse.parse(raw).data.map((model) => ({ id: model.id })),
};
