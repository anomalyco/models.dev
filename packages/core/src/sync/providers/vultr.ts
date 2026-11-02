import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ReasoningOption as ReasoningOptionSchema } from "../../schema.js";
import { readProviderModel } from "../../translate.js";
import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import {
  factorBaseModel,
  modelMetadata,
  providerDirForMetadataLab,
  resolveModelMetadataBaseModel,
} from "./openrouter.js";

type ReasoningOption = z.infer<typeof ReasoningOptionSchema>;

const API_ENDPOINT = "https://api.vultrinference.com/v1/models";

// Per-unit USD as a decimal string. An empty or non-numeric string must fail
// the run, not be written as a free model.
const Price = z.string().regex(/^\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i, "Vultr price is not a non-negative number");

const Pricing = z.object({
  type: z.string().min(1),
  unit: z.string().min(1),
  cost_usd: Price,
}).passthrough();

const Limit = z.object({
  value: z.number().int().positive(),
  unit: z.string(),
}).passthrough();

const InputModality = z.object({
  type: z.string().min(1),
  supported_inputs: z.object({
    max_context_length: Limit.optional(),
  }).passthrough().optional(),
  pricing: z.array(Pricing).optional(),
}).passthrough();

const OutputModality = z.object({
  type: z.string().min(1),
  supported_parameters: z.record(z.string(), z.unknown()).optional(),
  pricing: z.array(Pricing).optional(),
}).passthrough();

export const VultrModel = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  hugging_face_id: z.string().nullish(),
  input_modalities: z.array(InputModality),
  output_modalities: z.array(OutputModality),
  reasoning: z.object({
    mandatory: z.boolean().nullish(),
    supported_efforts: z.array(z.string()).nullish(),
  }).passthrough().nullish(),
}).passthrough();

export const VultrResponse = z.object({
  data: z.array(VultrModel).min(1, "Vultr returned an empty catalog; refusing to sync"),
}).passthrough().refine(
  (response) => new Set(response.data.map((model) => model.id)).size === response.data.length,
  "Vultr returned duplicate model IDs",
);

export type VultrModel = z.infer<typeof VultrModel>;

// Text-in, text-out rows. Image, audio, speech, transcription, embedding,
// rerank and decision rows share the endpoint but are not chat models.
function chatRow(model: VultrModel) {
  return model.input_modalities.some((modality) => modality.type === "text")
    && model.output_modalities.some((modality) => modality.type === "text");
}

export const vultr = {
  id: "vultr",
  name: "Vultr",
  modelsDir: "providers/vultr/models",
  // Vultr retires an ID by dropping it from the list and rerouting requests for
  // it to another model, so a missing model is removed rather than deprecated.
  // An empty catalog fails parsing before anything is deleted.
  deleteMissing: true,
  async fetchModels() {
    return fetchVultrModels();
  },
  parseModels(raw) {
    return VultrResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (!chatRow(model)) return undefined;
    const existing = context.existing(model.id);
    const authored = context.authored(model.id);
    if (existing !== undefined && authored !== undefined) {
      return { id: model.id, model: buildVultrModel(model, existing, authored) };
    }
    return createVultrModel(model);
  },
} satisfies SyncProvider<VultrModel>;

// A new chat model: the lab model from its ID, the lab's own reasoning
// controls, and Vultr's prices, context and features. Anything that can't be
// resolved opens a missing-model issue instead of a guessed file.
export function createVultrModel(model: VultrModel) {
  const base = resolveModelMetadataBaseModel(model.id);
  if (base === undefined) {
    throw new MissingReasoningOptionsError(
      model.id,
      `no lab model matches Vultr's ${model.id}${model.hugging_face_id ? ` (Hugging Face ${model.hugging_face_id})` : ""}; add it under models/ and author providers/vultr/models/${model.id}.toml`,
    );
  }
  const { id: _id, ...lab } = modelMetadata(base) as ExistingModel & { id?: string };
  const reasoning = lab.reasoning === true ? vultrReasoning(model, base) : undefined;
  const text = model.output_modalities.find((modality) => modality.type === "text")!;
  const textInput = model.input_modalities.find((modality) => modality.type === "text")!;
  if (tokenPrice(model.id, textInput.pricing, "prompt") === undefined
    || tokenPrice(model.id, text.pricing, "completion") === undefined) {
    throw new MissingReasoningOptionsError(model.id, `Vultr lists no per-token price for ${model.id}`);
  }
  const translated = buildVultrModel(
    model,
    { ...lab, cost: undefined, reasoning_options: reasoning?.options },
    { base_model: base },
  );
  const levels = reasoning?.options.flatMap((option) => option.type === "effort" ? option.values : []) ?? [];
  return {
    id: model.id,
    model: translated,
    header: [
      reasoning?.options.some((option) => option.type === "toggle") ? "# Toggle: reasoning.enabled = true|false" : undefined,
      levels.length > 0 ? `# Effort: reasoning_effort = ${levels.join("|")}` : undefined,
      reasoning === undefined ? undefined : `# Reasoning levels: ${reasoning.source} (Vultr maps reasoning_effort onto the model's native levels)`,
      `# Prices, context, tools and structured output: GET ${API_ENDPOINT}`,
    ].filter((line) => line !== undefined).join("\n") + "\n",
  };
}

// Vultr lists one reasoning_effort alias set for every model, so the levels
// come from the lab's own provider entry, else OpenRouter's (the same-surface
// peer). An off switch there (a toggle, or `none`) is Vultr's
// reasoning.enabled; budgets and defaults are not carried over.
function vultrReasoning(model: VultrModel, base: string) {
  if (model.reasoning == null) {
    throw new MissingReasoningOptionsError(
      model.id,
      `${base} reasons, but Vultr reports no reasoning metadata for ${model.id}; author capabilities.reasoning by hand`,
    );
  }
  const peer = peerReasoning(base);
  if (peer === undefined) {
    throw new MissingReasoningOptionsError(
      model.id,
      `neither ${base}'s own provider entry nor OpenRouter lists reasoning controls for it; author capabilities.reasoning for Vultr's ${model.id} by hand`,
    );
  }
  const offSwitch = peer.options.some((option) => option.type === "toggle"
    || (option.type === "effort" && option.values.includes("none")));
  const levels = peer.options.flatMap((option) => option.type === "effort" ? option.values : [])
    .filter((value) => value !== "none");
  const accepted = new Set(model.reasoning.supported_efforts ?? []);
  const unsupported = levels.filter((value) => typeof value !== "string" || !accepted.has(value));
  if (unsupported.length > 0) {
    throw new MissingReasoningOptionsError(
      model.id,
      `${peer.source} lists ${unsupported.join(", ")}, which Vultr's reasoning.supported_efforts for ${model.id} doesn't accept; author capabilities.reasoning by hand`,
    );
  }
  const options: ReasoningOption[] = [
    ...(offSwitch && model.reasoning.mandatory !== true ? [{ type: "toggle" } as ReasoningOption] : []),
    ...(levels.length > 0 ? [{ type: "effort", values: levels } as ReasoningOption] : []),
  ];
  return { options, source: peer.source };
}

const PROVIDERS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "providers");

function peerReasoning(base: string) {
  const [lab = "", ...rest] = base.split("/");
  const firstParty = path.join(PROVIDERS_DIR, providerDirForMetadataLab(lab), "models", `${rest.join("/")}.toml`);
  const candidates = [
    ...(existsSync(firstParty) ? [firstParty] : []),
    ...openRouterFiles().filter((file) => file.base === base).map((file) => file.path),
  ];
  for (const file of candidates) {
    const options = readProviderModel(file).reasoning_options;
    if (Array.isArray(options)) {
      return { options: options as ReasoningOption[], source: path.relative(path.dirname(PROVIDERS_DIR), file) };
    }
  }
  return undefined;
}

let openRouterIndex: Array<{ path: string; base: string | undefined }> | undefined;

function openRouterFiles() {
  openRouterIndex ??= tomlFiles(path.join(PROVIDERS_DIR, "openrouter", "models")).map((file) => ({
    path: file,
    base: readFileSync(file, "utf8").match(/^base_model = "([^"]+)"/m)?.[1],
  }));
  return openRouterIndex;
}

function tomlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) =>
    entry.isDirectory()
      ? tomlFiles(path.join(dir, entry.name))
      : entry.name.endsWith(".toml") ? [path.join(dir, entry.name)] : []
  );
}

export async function fetchVultrModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Vultr models request failed: ${response.status} ${response.statusText}`);
  }
  return VultrResponse.parse(await response.json());
}

// Updates the fields the catalog is authoritative for: token prices, the
// context window, tool calling and structured output. Every other field keeps
// its current value. Reasoning controls and modalities aren't taken from the
// catalog: every row lists the same reasoning_effort alias set, and image and
// file input are listed even for text-only labs.
export function buildVultrModel(
  model: VultrModel,
  existing: ExistingModel,
  authored: ExistingModel,
): SyncedModel {
  const text = model.output_modalities.find((modality) => modality.type === "text")!;
  const textInput = model.input_modalities.find((modality) => modality.type === "text")!;
  const parameters = text.supported_parameters ?? {};

  checkReasoning(model, existing);

  const input = tokenPrice(model.id, textInput.pricing, "prompt");
  const output = tokenPrice(model.id, text.pricing, "completion");
  const context = textInput.supported_inputs?.max_context_length;
  if (context !== undefined && context.unit !== "token") {
    throw new MissingReasoningOptionsError(
      model.id,
      `Vultr's max_context_length for ${model.id} is in ${context.unit}, not tokens`,
    );
  }

  const responseTypes = (parameters.response_format as { properties?: { type?: { values?: unknown } } } | undefined)
    ?.properties?.type?.values;
  const structuredOutput = parameters.structured_outputs !== undefined
    || (Array.isArray(responseTypes) && responseTypes.includes("json_schema"));

  const { base_model: authoredBase, base_model_omit: baseModelOmit } = authored;
  const limit = {
    ...existing.limit!,
    context: context?.value ?? existing.limit!.context,
  };
  const values = {
    ...existing,
    tool_call: parameters.tools !== undefined,
    structured_output: structuredOutput,
    cost: {
      ...existing.cost,
      input: input ?? existing.cost?.input,
      output: output ?? existing.cost?.output,
    },
    limit,
  } as Parameters<typeof factorBaseModel>[1];

  // Every Vultr file is a base_model override; a standalone file keeps its
  // own fields as they are.
  return authoredBase === undefined
    ? values as SyncedModel
    : factorBaseModel(authoredBase, values, limit, baseModelOmit);
}

// The API states whether reasoning can be turned off and which reasoning_effort
// values it accepts (aliases included; Vultr maps them onto the model's native
// levels). Authored controls that contradict it leave the file unchanged and
// open an issue instead of guessing new ones.
function checkReasoning(model: VultrModel, existing: ExistingModel) {
  if (existing.reasoning !== true) return;
  if (model.reasoning == null) {
    throw new MissingReasoningOptionsError(
      model.id,
      `Vultr no longer reports reasoning metadata for ${model.id}; check whether it still reasons and update capabilities.reasoning`,
    );
  }
  const options = existing.reasoning_options ?? [];
  if (model.reasoning.mandatory === true && options.some((option) => option.type === "toggle")) {
    throw new MissingReasoningOptionsError(
      model.id,
      `Vultr reports reasoning as mandatory for ${model.id}, but the authored controls include a toggle`,
    );
  }
  const accepted = new Set(model.reasoning.supported_efforts ?? []);
  // `none` turns reasoning off (as on OpenRouter); it isn't a graded level.
  const unsupported = options.flatMap((option) => option.type === "effort" ? option.values : [])
    .flatMap((value) => typeof value === "string" && value !== "none" && !accepted.has(value) ? [value] : []);
  if (unsupported.length > 0) {
    throw new MissingReasoningOptionsError(
      model.id,
      `Vultr's reasoning.supported_efforts for ${model.id} no longer includes the authored ${unsupported.join(", ")}`,
    );
  }
}

// USD per token → USD per million tokens. Rounded to micro-dollars so float
// error (0.00000035 * 1e6) never rewrites a file.
function tokenPrice(id: string, pricing: z.infer<typeof Pricing>[] | undefined, type: "prompt" | "completion") {
  const rows = (pricing ?? []).filter((row) => row.type === type);
  if (rows.length === 0) return undefined;
  if (rows.length > 1 || rows[0]!.unit !== "token" || "overrides" in rows[0]!) {
    // Leaves this file unchanged and opens an issue; the rest of the sync runs.
    throw new MissingReasoningOptionsError(
      id,
      `Vultr's ${type} pricing for ${id} is not a single per-token price (${JSON.stringify(rows)}); author the cost by hand`,
    );
  }
  return Math.round(Number(rows[0]!.cost_usd) * 1e12) / 1e6;
}
