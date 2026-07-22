import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://aprilseries.lat/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const AprilModel = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  created: z.number().int().nonnegative(),
  context: z.union([z.string(), z.number()]).optional(),
  context_window: z.number().int().nonnegative().optional(),
  max_output_tokens: z.number().int().nonnegative().optional(),
  price_per_1m: z.number().nonnegative().optional(),
  price_out_per_1m: z.number().nonnegative().optional(),
  capabilities: z.object({ vision: z.boolean().optional(), tool_calling: z.boolean().optional(), structured_outputs: z.boolean().optional() }).passthrough().optional(),
  reasoning: z.object({ effort_levels: z.array(z.object({ value: z.string() }).passthrough()).optional(), budget_tokens: z.object({ min: z.number().optional(), max: z.number().optional() }).optional() }).nullable().optional(),
}).passthrough();
const AprilResponse = z.object({ data: z.array(AprilModel) }).passthrough();
export type AprilModel = z.infer<typeof AprilModel>;

export const aprilseries = {
  id: "aprilseries",
  name: "April Series",
  modelsDir: "providers/aprilseries/models",
  async fetchModels() {
    const key = process.env.APRIL_API_KEY;
    if (!key) throw new Error("April Series sync requires APRIL_API_KEY");
    const response = await fetch(API_ENDPOINT, { headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) throw new Error(`April Series models request failed: ${response.status} ${response.statusText}`);
    return response.json();
  },
  parseModels(raw) { return AprilResponse.parse(raw).data; },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const baseModel = existing?.base_model ?? resolveBaseModel(model.id);
    if (baseModel === undefined || !baseModelExists(baseModel)) return undefined;
    return { id: model.id, model: buildAprilModel(model, existing, baseModel) };
  },
} satisfies SyncProvider<AprilModel>;

function buildAprilModel(model: AprilModel, existing: ExistingModel | undefined, baseModel: string): SyncedModel {
  const context = number(model.context_window) ?? parseContext(model.context) ?? existing?.limit?.context;
  if (context === undefined) return { base_model: baseModel };
  const input = model.capabilities?.vision === true ? ["text" as const, "image" as const] : existing?.modalities?.input ?? ["text" as const];
  const remote = model.reasoning;
  const reasoningOptions = reasoningOptionsFor(remote, existing?.reasoning_options);
  const reasoning = remote === null ? false : existing?.reasoning;
  const output = model.max_output_tokens ?? existing?.limit?.output;
  const cost = model.price_per_1m !== undefined && model.price_out_per_1m !== undefined
    ? { input: model.price_per_1m, output: model.price_out_per_1m, reasoning: existing?.cost?.reasoning, cache_read: existing?.cost?.cache_read, cache_write: existing?.cost?.cache_write, tiers: existing?.cost?.tiers }
    : existing?.cost;
  return factorBaseModel(baseModel, { name: model.display_name ?? existing?.name, attachment: input.length > 1, reasoning, reasoning_options: reasoningOptions, tool_call: model.capabilities?.tool_calling ?? existing?.tool_call, structured_output: model.capabilities?.structured_outputs ?? existing?.structured_output, temperature: existing?.temperature, cost, limit: { context, input: existing?.limit?.input, output }, modalities: { input, output: ["text"] }, status: existing?.status, interleaved: existing?.interleaved, provider: existing?.provider, experimental: existing?.experimental }, { context, input: existing?.limit?.input, output }, existing?.base_model_omit);
}

function reasoningOptionsFor(remote: AprilModel["reasoning"], existing: ExistingModel["reasoning_options"]) {
  if (remote === undefined) return existing;
  const options = (existing ?? []).filter((option) => option.type !== "effort" && option.type !== "budget_tokens");
  const efforts = remote?.effort_levels?.map((level) => level.value).filter(isReasoningEffort);
  if (efforts !== undefined && efforts.length > 0) options.push({ type: "effort", values: efforts });
  if (remote?.budget_tokens !== undefined) options.push({ type: "budget_tokens", ...remote.budget_tokens });
  return options;
}

function parseContext(value: string | number | undefined) {
  if (typeof value === "number") return value;
  if (value === undefined) return undefined;
  const match = value.trim().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*([KM])?$/);
  if (match === null) return undefined;
  return Math.round(Number(match[1]) * (match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1));
}
function number(value: number | undefined) { return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined; }
const BASE_MODEL_ALIASES: Record<string, string> = { "gpt-5.5-fast": "openai/gpt-5.5" };
function resolveBaseModel(id: string) { const alias = BASE_MODEL_ALIASES[id]; if (alias !== undefined) return alias; const provider = id.startsWith("claude-") ? "anthropic" : id.startsWith("gpt-") ? "openai" : undefined; return provider === undefined ? undefined : `${provider}/${id}`; }
function baseModelExists(modelID: string) { return existsSync(path.join(MODELS_DIR, `${modelID}.toml`)); }
function isReasoningEffort(value: string): value is "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" { return ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"].includes(value); }
