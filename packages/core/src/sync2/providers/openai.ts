// OpenAI: https://api.openai.com/v1/models (OPENAI_API_KEY). The list is
// account-scoped, carries no metadata beyond IDs, and keeps legacy and internal
// surfaces, so it owns no fields: every file is hand-authored. First-party IDs
// the catalog lacks are listed in the notices; absent files are left alone.

import { z } from "zod";

import { bearer, fetchJSON, requireEnv } from "../http.js";
import type { SyncModule } from "../types.js";

const OpenAIResponse = z.object({
  object: z.literal("list"),
  data: z.array(z.object({ id: z.string().min(1), object: z.literal("model"), owned_by: z.string() }).passthrough()),
}).passthrough();

export const openai: SyncModule<unknown> = {
  id: "openai",
  name: "OpenAI",
  policy: { owns: [], creates: "never", removals: "keep" },
  manages: () => false,
  fetch: () => fetchJSON("https://api.openai.com/v1/models", { source: "OpenAI models", headers: bearer(requireEnv("OpenAI", "OPENAI_API_KEY")) }),
  observe(raw) {
    return OpenAIResponse.parse(raw).data
      .filter((model) => !model.id.startsWith("ft:") && (model.owned_by === "system" || model.owned_by.startsWith("openai")))
      .map((model) => ({ id: model.id }));
  },
};
