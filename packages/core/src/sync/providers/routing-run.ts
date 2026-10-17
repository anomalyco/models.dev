import { z } from "zod";

import type { ExistingModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.routing.run/v1/models";

// Per-token USD prices arrive as strings ("5e-06") and pick up float artifacts
// ("2.0000000000000002e-07"). An unrecognized value must fail the run rather
// than be written as a free model.
const Price = z.union([
  z.number().finite().nonnegative(),
  z.string().regex(/^\d+(\.\d+)?(e[-+]?\d+)?$/i, "routing.run price is not a non-negative number"),
]);

export const RoutingRunModel = z
  .object({
    id: z.string().min(1),
    attachment: z.boolean().optional(),
    pricing: z
      .object({
        prompt: Price,
        completion: Price,
      })
      .passthrough()
      .optional(),
    modalities: z
      .object({
        input: z.array(z.string()).optional(),
        output: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    limit: z
      .object({
        context: z.number().int().positive().nullable().optional(),
        output: z.number().int().positive().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type RoutingRunModel = z.infer<typeof RoutingRunModel>;

export async function fetchRoutingRunModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`routing.run models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function parseRoutingRunModels(raw: unknown): RoutingRunModel[] {
  const rows = z.object({ data: z.array(RoutingRunModel).nonempty() }).parse(raw).data;
  if (new Set(rows.map((model) => model.id)).size !== rows.length) {
    throw new Error("routing.run returned duplicate model IDs");
  }
  return rows;
}

export function buildRoutingRunModel(model: RoutingRunModel, existing: ExistingModel): SyncedModel {
  // Prices and served limits are API-authoritative. The listing reports whether
  // each route accepts attachments and which modalities it serves, so those are
  // applied as overrides; every other field stays hand-authored.
  const cost =
    model.pricing === undefined
      ? existing.cost
      : {
          ...existing.cost,
          input: perMillion(model.pricing.prompt),
          output: perMillion(model.pricing.completion),
        };
  const limit = {
    ...existing.limit,
    context: model.limit?.context ?? existing.limit?.context,
    output: model.limit?.output ?? existing.limit?.output,
  };
  const input = normalizeModalities(model.modalities?.input) ?? existing.modalities?.input;
  const output = normalizeModalities(model.modalities?.output) ?? existing.modalities?.output;
  const attachment = model.attachment ?? existing.attachment;
  const { base_model: baseModel, base_model_omit: omit, ...current } = existing;
  const values = {
    ...current,
    ...(attachment === undefined ? {} : { attachment }),
    cost,
    limit,
    ...(input === undefined ? {} : { modalities: { input, output: output ?? ["text"] } }),
  } as Parameters<typeof factorBaseModel>[1];

  // An authored base_model is a pointer to a canonical entry; the synced prices
  // and served limits ride along as overrides.
  return baseModel === undefined ? (values as SyncedModel) : factorBaseModel(baseModel, values, limit, omit);
}

// Per-token USD values pick up float error when multiplied to per-1M
// (0.00000068 * 1e6), so round to micro-dollars.
function perMillion(value: string | number): number {
  return Math.round(Number(value) * 1_000_000 * 1e6) / 1e6;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function normalizeModalities(values: string[] | undefined): Modality[] | undefined {
  if (values === undefined) return undefined;
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  const unique = [...new Set(result)];
  if (unique.length === 0) return undefined;
  // Wire order is arbitrary; sort so rewrites for other reasons keep catalog order.
  const order: Modality[] = ["text", "image", "audio", "video", "pdf"];
  return unique.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export const routingRun = {
  id: "routing-run",
  name: "routing.run",
  modelsDir: "providers/routing-run/models",
  // The listing carries no reasoning controls: every route serves
  // `reasoning_content` with no request toggle, and that wire contract has to
  // be hand-authored per file. Unseen IDs are reported for a human instead of
  // being auto-authored.
  skipCreates: true,
  trackMissingModels: true,
  // A truncated response must not delete files, and retired routes also drop
  // out of the listing.
  deleteMissing: false,
  async fetchModels() {
    return fetchRoutingRunModels();
  },
  parseModels(raw) {
    return parseRoutingRunModels(raw);
  },
  sourceID(model) {
    return model.pricing === undefined ? undefined : model.id;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return { id: model.id, model: buildRoutingRunModel(model, existing) };
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} routing.run models have no local catalog file and were not created because reasoning controls are hand-authored: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local routing.run models are missing from the listing and were retained: ${paths.map((file) => `\`${file}\``).join(", ")}`,
    ];
  },
} satisfies SyncProvider<RoutingRunModel>;
