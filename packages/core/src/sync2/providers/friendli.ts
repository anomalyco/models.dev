// Friendli: https://api.friendli.ai/serverless/v1/models (public). Each model
// names its lab model. Authoritative for token and cache prices (token-billed
// models), the context window, input and output kinds, tools, structured
// output, reasoning with the controls Friendli lists (a budget without its
// bounds) and the reasoning field (a file's own stays when none is listed).
// Lab-based files carry no name, description or output limit of their own.
// Each file's header is generated from the listed controls. Models past their
// deprecation date and dropped models are deleted; a model with no lab file
// keeps its file. New models are created from a lab file.

import { z } from "zod";

import { Labs, REPO_ROOT } from "../catalog.js";
import { fetchJSON } from "../http.js";
import { toV1Modality } from "../../translate.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.friendli.ai/serverless/v1/models";
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];
const KINDS = ["text", "audio", "image", "video", "pdf"];

// Verified live where Friendli lists no field.
const VERIFIED_INTERLEAVED: Record<string, string> = { "deepseek-ai/DeepSeek-V3.2": "reasoning_content" };

const LAB_PREFIX_MAP: Record<string, string> = {
  "zai-org": "zhipuai",
  "deepseek-ai": "deepseek",
  "LGAI-EXAONE": "lgai-exaone",
  MiniMaxAI: "minimax",
  "meta-llama": "meta",
  mistralai: "mistral",
  Qwen: "alibaba",
};

const ReasoningOption = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }).passthrough(),
  z.object({ type: z.literal("effort"), values: z.array(z.string()) }).passthrough(),
  z.object({ type: z.literal("budget_tokens"), min: z.number().optional(), max: z.number().optional() }).passthrough(),
]).optional();

const FriendliModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  context_length: z.number(),
  max_completion_tokens: z.number(),
  functionality: z.object({ tool_call: z.boolean(), structured_output: z.boolean() }).passthrough(),
  pricing: z.object({
    input: z.union([z.string(), z.number()]),
    output: z.union([z.string(), z.number()]),
    input_cache_read: z.union([z.string(), z.number()]).optional(),
    input_cache_write: z.union([z.string(), z.number()]).optional(),
    unit_type: z.enum(["TOKEN", "SECOND"]).optional(),
  }).passthrough(),
  deprecation_date: z.string().nullable().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(ReasoningOption).optional(),
  interleaved: z.union([z.enum(["reasoning_content", "reasoning_details"]), z.boolean()]).optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  base_model: z.string().optional(),
}).passthrough();
type FriendliModel = z.infer<typeof FriendliModel>;

const FriendliResponse = z.object({ data: z.array(FriendliModel) }).passthrough();

const MID_CONVERSATION_LINE = "# Mid-conversation: Friendli serves this model on POST /serverless/v1/chat/completions; reasoning and tools are per-request fields with no per-turn effort or tool-change mechanism (effort_updates = false, tools.updates = false). https://friendli.ai/docs/openapi/model-apis/chat-completions";
const IMAGE_MIME_LINE = "# Input MIME types: images JPEG, PNG and AVIF (https://friendli.ai/docs/guides/multi-modality); video per the lab.";

let labs: Labs | undefined;

export const friendli: SyncModule<unknown> = {
  id: "friendli",
  name: "Friendli",
  policy: {
    owns: [
      "name",
      "description",
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "capabilities.structured_output",
      "limit.context",
      "limit.output",
      "api.chat-completions.legacy_interleaved",
      "api.chat-completions.compatibility.reasoning_field",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.output.price",
    ],
    creates: "auto",
    removals: "delete",
    headers: "replace",
    omitLabInput: true,
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "Friendli models" }),
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    const models = FriendliResponse.parse(raw).data;
    if (models.length === 0) throw new Error("Friendli returned an empty model catalog; refusing destructive sync");
    return models.filter((model) => !deprecated(model)).map((model) => observe(model, labs!));
  },
};

function observe(model: FriendliModel, labs: Labs): Observation {
  const base = labFile(model.base_model, labs) ?? labFile(model.id, labs);
  // No lab file: its file (if any) is kept as written.
  if (base === undefined) return { id: model.id, updateOnly: true };
  const input = model.input_modalities === undefined ? undefined : kinds(model.input_modalities);
  const output = model.output_modalities === undefined ? undefined : kinds(model.output_modalities);
  const options = model.reasoning === false ? undefined : controls(model.reasoning_options);
  const interleaved = VERIFIED_INTERLEAVED[model.id] ?? (model.interleaved === undefined || model.interleaved === false ? undefined : model.interleaved);
  const price = (value: string | number | undefined) => perMillion(value);
  const tokens = model.pricing.unit_type === undefined || model.pricing.unit_type === "TOKEN";
  const input$ = price(model.pricing.input);
  const output$ = price(model.pricing.output);
  const labInput = (labs.get(base)?.modalities as { input?: string[] } | undefined)?.input ?? [];
  const sameKinds = (a: string[], b: string[]) => [...new Set(a.map(toV1Modality))].sort().join() === [...new Set(b.map(toV1Modality))].sort().join();
  const imageLine = input !== undefined && input.includes("image") && !sameKinds(input, labInput);
  return {
    id: model.id,
    base: [base],
    name: null,
    description: null,
    ...(input === undefined && output === undefined ? {} : { modalities: { ...(input && { input }), ...(output && { output }) } }),
    capabilities: {
      tools: { supported: model.functionality.tool_call },
      ...(model.reasoning === undefined && options === undefined ? {} : {
        reasoning: { ...(model.reasoning === undefined ? {} : { supported: model.reasoning }), ...(options ?? {}) },
      }),
      structured_output: model.functionality.structured_output,
    },
    limit: { context: model.context_length, output: null },
    ...(interleaved === undefined ? {} : {
      api: { "chat-completions": interleaved === true ? { legacy_interleaved: true } : { compatibility: { reasoning_field: interleaved } } },
    }),
    ...(tokens && input$ !== undefined && output$ !== undefined ? {
      cost: {
        text: {
          input: {
            price: input$,
            cache: { ...(price(model.pricing.input_cache_read) === undefined ? {} : { read: price(model.pricing.input_cache_read) }), ...(price(model.pricing.input_cache_write) === undefined ? {} : { write: price(model.pricing.input_cache_write) }) },
          },
          output: { price: output$ },
        },
      },
    } : {}),
    header: header(model.reasoning === false ? undefined : model.reasoning_options, imageLine),
  } as Observation;
}

// Friendli's controls; a budget is written without its bounds.
function controls(options: FriendliModel["reasoning_options"]) {
  if (options === undefined) return undefined;
  const listed = options.filter((option) => option !== undefined);
  const effort = listed.find((option) => option.type === "effort");
  return {
    toggle: listed.some((option) => option.type === "toggle") ? true : null,
    effort: effort === undefined ? null : [...effort.values].sort((a, b) => rank(a) - rank(b)),
    budget: listed.some((option) => option.type === "budget_tokens") ? {} : null,
  };
}

function header(options: FriendliModel["reasoning_options"], imageLine: boolean) {
  const lines: string[] = [];
  for (const option of options ?? []) {
    if (option?.type === "toggle") lines.push("# Toggle: chat_template_kwargs.enable_thinking = true | false", "# https://friendli.ai/docs/guides/reasoning");
    if (option?.type === "effort") {
      const values = [...option.values].sort((a, b) => rank(a) - rank(b));
      lines.push(values.length > 0 ? `# Effort: reasoning_effort = ${values.map((value) => `"${value}"`).join(" | ")}` : "# Effort: reasoning_effort (model-specific accepted values)");
      lines.push("# https://friendli.ai/docs/openapi/model-apis/chat-completions#body-reasoning-effort-one-of-0");
    }
    if (option?.type === "budget_tokens") {
      lines.push("# Budget: reasoning_budget = positive integer reasoning-token cap (-1 = unlimited)", "# https://friendli.ai/docs/openapi/model-apis/chat-completions#body-reasoning-budget-one-of-0");
    }
  }
  lines.push(MID_CONVERSATION_LINE);
  if (imageLine) lines.push(IMAGE_MIME_LINE);
  return `${lines.join("\n")}\n`;
}

function rank(value: string) {
  const index = EFFORT_ORDER.indexOf(value);
  return index === -1 ? EFFORT_ORDER.length : index;
}

// The lab file a Friendli lab ID names, ignoring case, with host namespaces mapped.
function labFile(id: string | undefined, labs: Labs) {
  if (id === undefined || id.length === 0) return undefined;
  const [org, ...parts] = id.split("/");
  if (org === undefined || parts.length === 0) return undefined;
  const mapped = LAB_PREFIX_MAP[org];
  return labs.find(id) ?? (mapped === undefined ? undefined : labs.find(`${mapped}/${parts.join("/")}`));
}

function deprecated(model: FriendliModel) {
  if (model.deprecation_date == null) return false;
  const date = Date.parse(model.deprecation_date);
  return Number.isFinite(date) && date <= Date.now();
}

function perMillion(value: string | number | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.round(number * 1_000_000 * 1_000_000) / 1_000_000;
}

function kinds(values: string[]) {
  const result = [...new Set(values.map((value) => value.toLowerCase()).filter((value) => KINDS.includes(value)))];
  return (result.length > 0 ? result : ["text"]).map((value) => (value === "pdf" ? "application/pdf" : value));
}
