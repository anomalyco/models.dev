import { createHash } from "node:crypto";
import { z } from "zod";

import { AuthoredModel } from "../../schema.js";
import { resolveBaseModel } from "../base-model.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel } from "../index.js";

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
  // Missing mappings also go through the review flow, not destructive skipping.
  base_model: SafeID.nullable().optional(),
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

function controlsMarker(baseID: string, options: ExistingModel["reasoning_options"]) {
  const normalized = (options ?? []).map((option) => option.type === "effort"
    ? { type: option.type, values: [...option.values].sort() }
    : option.type === "budget_tokens"
      ? { type: option.type, min: option.min, max: option.max }
      : { type: option.type });
  const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return `# Void sync reasoning v1: ${baseID} ${hash}`;
}

function manualHeader(header: string | undefined) {
  return header?.split("\n")
    .filter((line) => !/^# (Void sync reasoning|Reasoning controls:|Toggle:|Effort:|Budget:)/.test(line))
    .join("\n").trim();
}

function translatedControls(baseID: string, native: ExistingModel | undefined) {
  const lab = baseID.split("/")[0];
  if ((lab !== "anthropic" && lab !== "openai") || native?.reasoning !== true || native.reasoning_options === undefined) return undefined;
  const allowedEffort = lab === "anthropic"
    ? ["minimal", "low", "medium", "high", "xhigh", "max"]
    : ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const options: NonNullable<ExistingModel["reasoning_options"]> = [];
  for (const option of native.reasoning_options) {
    if (option.type === "effort") {
      const values = option.values.filter((value) => value !== null && allowedEffort.includes(value));
      if (values.length > 0) options.push({ type: "effort", values });
    } else if (lab === "anthropic" && (option.type === "toggle" || option.type === "budget_tokens")) {
      options.push({ ...option });
    }
  }
  if (options.length === 0 && native.reasoning_options.length > 0) return undefined;
  const header = [
    controlsMarker(baseID, options),
    `# Reasoning controls: first-party base ${baseID}, translated via LiteLLM.`,
    ...(options.some((option) => option.type === "toggle") ? ["# Toggle: thinking.type = enabled|disabled (chat only; enabled is translated to adaptive when required)."] : []),
    ...(options.some((option) => option.type === "effort") ? ["# Effort: reasoning_effort (chat), reasoning.effort (Responses)."] : []),
    ...(options.some((option) => option.type === "budget_tokens") ? ["# Budget: thinking.type = enabled, thinking.budget_tokens (chat only); max_tokens must exceed the budget."] : []),
  ].join("\n") + "\n";
  return { options, header };
}

export async function fetchVoidModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Void API models request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

export const voidApi = {
  id: "void-api",
  name: "Void API",
  modelsDir: "providers/void-api/models",
  needsMetadata: true,
  firstPartyBaseIDs: (models) => models.flatMap((model) => model.base_model && /^(anthropic|openai)\//.test(model.base_model) ? [model.base_model] : []),
  // Paused models can temporarily disappear from the availability endpoint.
  deleteMissing: false,
  preserveBaseModels: false,
  preserveDescriptions: false,
  authoritativeHeaders: true,
  sourceID: (model) => model.id,
  missingModelID: (model) => model.id,
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `Void API manual review required (missing/unknown base, changed base, incomplete metadata, or unverified reasoning controls); existing files preserved: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    return paths.length === 0 ? [] : [
      `Void API retains models absent from availability (possibly paused); deleteMissing=false: ${paths.join(", ")}`,
    ];
  },
  fetchModels: fetchVoidModels,
  parseModels: (raw) => VoidResponse.parse(raw).data,
  translateModel(remote, context) {
    const baseID = remote.base_model;
    if (!baseID) return undefined;
    const base = context.metadata?.(baseID);
    if (!base) return undefined;
    let authored = context.authored(remote.id);
    // a correction invalidates old overrides; only sync-owned fields can be reset safely.
    if (authored && authored.base_model !== baseID) {
      const generated = authored.base_model !== undefined && context.authoredHeader?.(remote.id)?.split("\n")
        .includes(controlsMarker(authored.base_model, authored.reasoning_options));
      const onlySyncedFields = Object.keys(authored).every((key) => ["base_model", "reasoning_options", "cost"].includes(key))
        && Object.keys(authored.cost ?? {}).every((key) => ["input", "output", "cache_read", "cache_write"].includes(key));
      if (!onlySyncedFields || (authored.reasoning_options !== undefined && !generated)) return undefined;
      authored = undefined;
    }
    const { unit: _unit, ...prices } = remote.pricing;
    const model: SyncedBaseModel = {
      ...authored,
      base_model: baseID,
      cost: { ...authored?.cost, ...prices },
    };
    let header = context.authoredHeader?.(remote.id);
    if (authored === undefined && context.authored(remote.id) !== undefined) {
      header = manualHeader(header);
    }
    const reasoning = authored?.reasoning ?? base.reasoning;
    const generatedControls = header?.split("\n").includes(controlsMarker(baseID, model.reasoning_options)) ?? false;
    if (reasoning === false) {
      delete model.reasoning_options;
      if (generatedControls) header = manualHeader(header);
    }
    if (reasoning === true && (model.reasoning_options === undefined || generatedControls)) {
      const translated = translatedControls(baseID, context.firstParty?.(baseID));
      if (translated) {
        model.reasoning_options = translated.options;
        const notes = manualHeader(header);
        header = translated.header + (notes ? `${notes}\n` : "");
      } else {
        if (generatedControls) return undefined;
        // retain the authored same-surface fallback for unverified translations.
        const peers = (context.authoredIDs?.() ?? [])
          .map((id) => ({ id, model: context.authored(id) }))
          .filter((peer) => peer.model?.base_model === baseID && peer.model.reasoning_options !== undefined && peer.model.reasoning !== false);
        const controls = peers[0]?.model?.reasoning_options;
        if (controls === undefined || peers.some((peer) => JSON.stringify(peer.model?.reasoning_options) !== JSON.stringify(controls))) return undefined;
        model.reasoning_options = controls;
        header = context.authoredHeader?.(peers[0]!.id);
        if (controls.some((option) => option.type === "toggle") && !header?.split("\n").some((line) => /^# Toggle:\s+\S/.test(line))) return undefined;
      }
    }
    // Validate the fully inherited entry, including omissions and local deltas.
    // The runner's base-shaped validator alone cannot detect missing lab limits.
    try {
      const resolved = resolveBaseModel(model, { [baseID]: base }, remote.id);
      const { base_model: _base, base_model_omit: _omit, ...fields } = resolved;
      if (!AuthoredModel.safeParse({ id: remote.id, ...fields }).success) return undefined;
    } catch {
      return undefined;
    }
    return { id: remote.id, model, header };
  },
} satisfies SyncProvider<VoidModel>;
