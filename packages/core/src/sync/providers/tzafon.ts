import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncProvider } from "../index.js";

const API_ENDPOINT = "https://api.tzafon.ai/v1/models";

const TzafonModel = z.object({
  id: z.string(),
  created: z.number().int().nonnegative(),
  object: z.literal("model"),
  features: z.array(z.string()).optional(),
}).passthrough();

const TzafonResponse = z.object({
  data: z.array(TzafonModel),
});

export type TzafonModel = z.infer<typeof TzafonModel>;

// The listing is key-scoped: an admin key also returns internal `tzafon.internal.*`
// checkpoints that regular users can never reach. Only `tzafon.*` public IDs may enter
// the catalog, regardless of which key ran the sync.
function isPublic(id: string) {
  return id.startsWith("tzafon.");
}

export const tzafon = {
  id: "tzafon",
  name: "Tzafon",
  modelsDir: "providers/tzafon/models",
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Tzafon models returned by \`/v1/models\` were not created because the endpoint does not provide authoritative pricing, limits, or modalities for the catalog. Existing models are still updated from API-authoritative fields (\`created\`).`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    // TZAFON_API_KEY is optional here: an unauthenticated/user-scoped listing is
    // already public-only. If a key is set it must be a regular-user key — an admin
    // key must never widen the synced set, which isPublic() enforces regardless.
    const headers: Record<string, string> = {};
    if (process.env.TZAFON_API_KEY) headers.Authorization = `Bearer ${process.env.TZAFON_API_KEY}`;

    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`Tzafon models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return TzafonResponse.parse(raw).data.filter((model) => isPublic(model.id));
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    // Never auto-create: /v1/models only exposes id/created/features, which isn't
    // enough to author a compliant catalog entry (cost, limits, modalities are all
    // hand-verified against live probes). New IDs surface via skippedNotice instead.
    if (existing === undefined) return undefined;

    return {
      id: model.id,
      model: buildTzafonModel(model, existing),
    };
  },
} satisfies SyncProvider<TzafonModel>;

function buildTzafonModel(model: TzafonModel, existing: ExistingModel): SyncedFullModel {
  const { name, description, attachment, reasoning, toolCall, openWeights, limit, modalities, lastUpdated } = {
    name: existing.name,
    description: existing.description,
    attachment: existing.attachment,
    reasoning: existing.reasoning,
    toolCall: existing.tool_call,
    openWeights: existing.open_weights,
    limit: existing.limit,
    modalities: existing.modalities,
    lastUpdated: existing.last_updated,
  };

  if (
    name === undefined
    || description === undefined
    || attachment === undefined
    || reasoning === undefined
    || toolCall === undefined
    || openWeights === undefined
    || limit === undefined
    || modalities === undefined
    || lastUpdated === undefined
  ) {
    throw new Error(`Tzafon model ${model.id} has incomplete local TOML metadata required for sync`);
  }

  return {
    ...existing,
    name,
    description,
    attachment,
    reasoning,
    tool_call: toolCall,
    open_weights: openWeights,
    limit,
    modalities,
    last_updated: lastUpdated,
    // `created` is the only field the API is authoritative for; keep any
    // hand-authored release_date rather than overwriting it.
    release_date: existing.release_date ?? isoDate(model.created),
  };
}

function isoDate(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}
