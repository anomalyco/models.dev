import { z } from "zod";
import { AuthoredModel } from "../../schema.js";
import type { SyncProvider } from "../index.js";

const metadataFields = ["name", "description", "family", "attachment", "reasoning", "reasoning_options", "tool_call", "structured_output", "temperature", "knowledge", "release_date", "last_updated", "modalities", "open_weights", "limit"] as const;
const API_ENDPOINT = "https://void-api.tech/v1/models";
// Permit nested invocation IDs, but never filesystem traversal or encoded paths.
const SafeID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@-]*)*$/)
  .refine((id) => id.split("/").every((part) => part !== "." && part !== ".."));
const Price = z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)
  .pipe(z.number().finite().nonnegative());
const VoidModel = z.object({
  id: SafeID,
  object: z.literal("model"),
  created: z.number().int().nonnegative().safe(),
  owned_by: z.string().min(1),
  ...Object.fromEntries(metadataFields.map((field) => [field, z.unknown().optional()])) as Record<typeof metadataFields[number], z.ZodOptional<z.ZodUnknown>>,
  pricing: z.object({
    unit: z.literal("USD_per_million_tokens"),
    input: Price,
    output: Price,
    cache_read: Price,
    cache_write: Price,
  }),
});
const VoidResponse = z.object({ object: z.literal("list"), data: z.array(VoidModel).min(1) })
  .superRefine(({ data }, context) => {
    const ids = new Set<string>();
    for (const model of data) {
      const id = model.id.toLowerCase();
      if (ids.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate model ID: ${model.id}` });
      ids.add(id);
    }
  });
type VoidModel = z.infer<typeof VoidModel>;

export async function fetchVoidModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Void API models request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

export const voidApi = {
  id: "void-api",
  name: "Void API",
  modelsDir: "providers/void-api/models",
  // Availability and metadata can be incomplete during an upstream outage.
  deleteMissing: false,
  preserveBaseModels: false,
  preserveDescriptions: false,
  authoritativeHeaders: true,
  sourceID: (model) => model.id,
  missingModelID: (model) => model.id,
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [`Void API manual review required (missing or incomplete API metadata); existing files preserved: ${ids.map((id) => `\`${id}\``).join(", ")}`];
  },
  missingNotice(paths) {
    return paths.length === 0 ? [] : [`Void API retains models absent from availability (possibly paused); deleteMissing=false: ${paths.join(", ")}`];
  },
  fetchModels: fetchVoidModels,
  parseModels: (raw) => VoidResponse.parse(raw).data,
  translateModel(remote, context) {
    const { unit: _unit, ...prices } = remote.pricing;
    const metadata = Object.fromEntries(metadataFields.filter((key) => remote[key] !== undefined).map((key) => [key, remote[key]]));
    // Validate the API alone before applying overrides: local fields must not hide
    // missing upstream metadata and turn an outage into a destructive rewrite.
    const parsed = AuthoredModel.safeParse({ id: remote.id, ...metadata, cost: prices });
    if (!parsed.success) return undefined;
    const authored = context.authored(remote.id);
    const { id: _id, ...fields } = parsed.data;
    // API facts and controls are authoritative. Retain host-only authored extras
    // and curated descriptions, never stale inheritance or copied capabilities.
    const extras = Object.fromEntries(Object.entries(authored ?? {}).filter(([key]) =>
      !metadataFields.includes(key as typeof metadataFields[number]) && !["base_model", "base_model_omit", "cost", "id"].includes(key)));
    const model = { ...extras, ...fields,
      description: authored?.description ?? fields.description,
      cost: { ...authored?.cost, ...prices },
    };
    if (!AuthoredModel.safeParse({ id: remote.id, ...model }).success) return undefined;
    const header = context.authoredHeader?.(remote.id)?.split("\n")
      .filter((line) => !/^# (Void sync reasoning|Reasoning controls:)/.test(line)).join("\n");
    return { id: remote.id, model, header };
  },
} satisfies SyncProvider<VoidModel>;
