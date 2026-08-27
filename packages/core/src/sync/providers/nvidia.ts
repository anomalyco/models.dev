import { z } from "zod";

import type { SyncProvider } from "../index.js";

const Response = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      object: z.string(),
      created: z.number(),
      owned_by: z.string(),
    }),
  ),
});

/**
 * NVIDIA NIM catalog API. Public, no auth required.
 * Source: https://integrate.api.nvidia.com/v1/models
 *
 * The endpoint only exposes availability (id + ownership), so this sync is an
 * availability sync: it preserves TOMLs for models still served by NVIDIA,
 * removes TOMLs for models no longer in the catalog, and opens issues for
 * catalog models missing from the local provider (pricing/limits are not
 * exposed by the endpoint and must be researched by the issue fixer).
 */
export const nvidia: SyncProvider<z.infer<typeof Response>["data"][number]> = {
  id: "nvidia",
  name: "Nvidia",
  modelsDir: "providers/nvidia/models",
  deleteMissing: true,
  skipCreates: true,
  trackMissingModels: false,
  async fetchModels() {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models");
    if (!res.ok) {
      throw new Error(`NVIDIA models endpoint failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  parseModels(raw) {
    return Response.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    // Preserve the authored TOML verbatim for models still in the catalog.
    if (existing !== undefined) return { id: model.id, model: existing };
    // New catalog model: skipCreates defers it as a missing-model issue.
    return undefined;
  },
  sourceID(model) {
    return model.id;
  },
};

export default nvidia;
