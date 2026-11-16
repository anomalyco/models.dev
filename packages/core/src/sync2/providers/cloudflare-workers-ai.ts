// Cloudflare Workers AI: model search in OpenRouter's shape
// (https://api.cloudflare.com/client/v4/accounts/{id}/ai/models/search?format=openrouter)
// and each model's request schema (/ai/models/schema), with
// CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID and CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN.
// Authoritative: token and cache prices with context bands, the context window
// (pinned where the backend serves less than search reports), input and output
// kinds, tools and tool_choice, structured output, temperature, reasoning
// controls search states concretely, the Responses API for models whose schema
// takes a Responses body, and the decision type of the Clef routes. A file's
// name, output limit and release date are its own. Every file's leading
// comment is kept, with the generated toggle line where the wire is verified.
// Files search stops listing are kept.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { ToolChoiceV2 } from "../../schema-v2.js";
import { Labs, leadingComments, REPO_ROOT } from "../catalog.js";
import { getPath, isTable } from "../fields.js";
import { bearer, requireEnv } from "../http.js";
import { OPENROUTER_SHAPED_OWNS, observeOpenRouterShaped } from "../openrouter-shape.js";
import type { Doc, Observation, Owned, SyncModule } from "../types.js";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const TOGGLE_HEADER = "# Toggle: chat_template_kwargs.enable_thinking = true|false\n";
// Models with a verified enable_thinking control. These are exact IDs, not a
// default for future models or whole publishers.
const ENABLE_THINKING_MODELS = new Set([
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/qwen/qwen3.8-27b",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/zai-org/glm-5.2",
]);
// Search reports these as text generation, but they take state and typed
// questions and return typed answers.
const DECISION_MODELS = new Set(["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash", "@cf/cloudflare/clef-omni"]);
// Search reports 1,310,720 for these, but the backend rejects requests over 1,048,576 tokens.
const SERVED_CONTEXT = new Map([
  ["@cf/zai-org/glm-5.3", 1_048_576],
  ["@cf/zai-org/glm-5.3-flash", 1_048_576],
  ["@cf/deepseek-ai/deepseek-v4-flash-0731", 1_048_576],
]);
// Clef Omni's request schema also takes `audio` and `videos`, which search leaves out.
// https://developers.cloudflare.com/workers-ai/models/clef-omni/
const EXTRA_INPUTS = new Map([["@cf/cloudflare/clef-omni", ["audio", "video"]]]);
const PUBLISHER_LABS: Record<string, string> = {
  "deepseek-ai": "deepseek",
  google: "google",
  meta: "meta",
  mistralai: "mistral",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  openai: "openai",
  qwen: "alibaba",
  "zai-org": "zhipuai",
};
// POST /ai/v1/responses serves "Workers AI models that support the Responses API, such as GPT-OSS":
// https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
const RESPONSES_API = { sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" } };
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const Reasoning = z.object({
  mandatory: z.boolean().optional(),
  supported_efforts: z.array(z.enum(EFFORTS)).nullable().optional(),
  supports_max_tokens: z.boolean().optional(),
}).passthrough();
type Reasoning = z.infer<typeof Reasoning>;

const Price = z.string().refine((value) => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0);
const Row = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  created: z.number().int().nonnegative(),
  hugging_face_id: z.string().nullable().optional(),
  knowledge_cutoff: z.string().nullable().optional(),
  context_length: z.number().int().positive(),
  architecture: z.object({ input_modalities: z.array(z.string()).min(1), output_modalities: z.array(z.string()).min(1) }).passthrough(),
  pricing: z.object({
    prompt: Price,
    completion: Price,
    internal_reasoning: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
    overrides: z.array(z.record(z.unknown())).optional(),
  }).passthrough(),
  top_provider: z.object({ max_completion_tokens: z.number().int().positive().nullable() }).passthrough(),
  supported_parameters: z.array(z.string()),
  // Parsed on its own so a malformed control doesn't drop the model.
  reasoning: z.unknown().optional(),
  // Whether the request schema takes a Responses body; unset when it couldn't be read.
  responses_api: z.boolean().optional(),
  // The tool_choice values the request schema lists; unset when it doesn't list them.
  tool_choice: z.array(ToolChoiceV2).optional(),
}).passthrough();
type Row = z.infer<typeof Row> & { reasoning?: Reasoning };

const Response = z.object({
  data: z.array(z.unknown()).optional(),
  result: z.union([z.array(z.unknown()), z.object({ data: z.array(z.unknown()) })]).optional(),
  result_info: z.object({ total_pages: z.number().int().positive().optional() }).optional(),
}).passthrough();

let labs: Labs | undefined;

// The OpenRouter-shaped fields, except that a file keeps its own name, output
// limit and release date, and reasons only where search states controls.
const owns: Owned[] = [
  ...OPENROUTER_SHAPED_OWNS.map((owned): Owned => {
    const path = typeof owned === "string" ? owned : owned.path;
    return ["name", "limit.output", "release_date"].includes(path) ? { ...(typeof owned === "string" ? { path } : owned), createOnly: true } : owned;
  }),
  "type",
  "capabilities.reasoning.toggle",
  "capabilities.reasoning.effort",
  "capabilities.reasoning.budget",
  "capabilities.tools.choice",
  { path: "cost.text.input.overrides", merge: "bands", optional: true },
  { path: "cost.text.output.overrides", merge: "bands", optional: true },
  { path: "api", merge: "tables" },
];

export const cloudflareWorkersAi: SyncModule<unknown> = {
  id: "cloudflare-workers-ai",
  name: "Cloudflare Workers AI",
  policy: { owns, creates: "auto", removals: "keep", headers: "replace", omitLabInput: true },
  async fetch() {
    const account = requireEnv("Cloudflare Workers AI", "CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID");
    const token = requireEnv("Cloudflare Workers AI", "CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN");
    const first = await page(account, token, 1);
    const rows = rowsOf(first);
    for (let number = 2; number <= (first.result_info?.total_pages ?? 1); number++) rows.push(...rowsOf(await page(account, token, number)));
    // Search has no API list; a model's request schema says whether it takes a Responses body.
    for (let index = 0; index < rows.length; index += 6) {
      await Promise.all(rows.slice(index, index + 6).map(async (row) => {
        const id = isTable(row) ? row.id : undefined;
        if (typeof id !== "string") return;
        const input = await schemaInput(account, token, id);
        if (input === undefined) return;
        (row as Doc).responses_api = takesResponsesBody(input);
        (row as Doc).tool_choice = schemaToolChoice(input);
      }));
    }
    return { data: rows };
  },
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    const models = rowsOf(Response.parse(raw)).flatMap((row) => {
      const parsed = Row.safeParse(row);
      if (!parsed.success) return [];
      const reasoning = Reasoning.safeParse(parsed.data.reasoning);
      const id = parsed.data.id.replace(/^workers-ai\//, "");
      return [{ ...parsed.data, id: id.startsWith("@cf/") ? id : `@cf/${id}`, reasoning: reasoning.success ? reasoning.data : undefined } as Row];
    });
    if (models.length === 0) throw new Error("Cloudflare Workers AI search returned no usable models");
    return models.map((model) => observe(model, labs!));
  },
  // Search's OpenRouter format leaves out embedding and image models (the v2-only files).
  manages: (_id, file) => file.v2_only !== true,
  refine(observation, file) {
    const extra = facts.get(observation.id)!;
    const header = file === undefined ? "" : fileHeader(observation.id);
    const preserved = header.replace(TOGGLE_HEADER, "");
    const toggleWire = /\b(?:thinking\.type|chat_template_kwargs\.thinking|enable_thinking)\b/.test(preserved);
    const toggleLine = ENABLE_THINKING_MODELS.has(observation.id) ? TOGGLE_HEADER : "";
    let refined: Observation = observation;
    const capabilities = { ...observation.capabilities } as Doc;
    if (extra.controls?.toggle === true && !toggleWire && toggleLine === "") {
      // An unverified toggle wire: a new model waits for a person, an existing one keeps its controls.
      if (file === undefined) return { id: observation.id, updateOnly: true };
      delete capabilities.reasoning;
      refined = { ...observation, capabilities: capabilities as Observation["capabilities"] };
      return { ...refined, header };
    }
    // A tool_choice list is written only while the file's own tools table doesn't turn tools off.
    if (getPath(file, "capabilities.tools.supported") === false) {
      capabilities.tools = { ...(capabilities.tools as Doc), choice: undefined };
    }
    const toggle = extra.controls?.toggle === true && !toggleWire ? toggleLine : "";
    return { ...refined, capabilities: capabilities as Observation["capabilities"], header: toggle + preserved };
  },
};

// What refine needs that isn't an observed field.
const facts = new Map<string, { controls?: Doc }>();

function observe(model: Row, labs: Labs): Observation {
  const controls = reasoningControls(model);
  facts.set(model.id, { controls });
  const context = Math.min(model.context_length, SERVED_CONTEXT.get(model.id) ?? model.context_length);
  const states = controls !== undefined;
  const reasoning = states || hasReasoning(model);
  const base = resolveBase(model);
  const name = model.name.replace(/^[^:]+:\s+/, "");
  const params = model.supported_parameters.filter((parameter) => !["reasoning", "include_reasoning"].includes(parameter));
  const shaped = observeOpenRouterShaped({
    ...model,
    context_length: context,
    architecture: { ...model.architecture, input_modalities: [...new Set([...model.architecture.input_modalities, ...EXTRA_INPUTS.get(model.id) ?? []])] },
    supported_parameters: [...params, ...(reasoning ? ["reasoning"] : [])],
  }, { hints: base === undefined ? [] : [base], labs });
  const decision = DECISION_MODELS.has(model.id);
  const capabilities = { ...shaped.capabilities } as Doc;
  // Only search's concrete controls say whether an existing file reasons.
  capabilities.reasoning = states ? { supported: true, toggle: controls.toggle ?? null, effort: controls.effort ?? null, budget: controls.budget ?? null } : undefined;
  if (decision) {
    delete capabilities.temperature;
    delete capabilities.structured_output;
  }
  if (model.supported_parameters.includes("tools") && model.tool_choice !== undefined) capabilities.tools = { ...(capabilities.tools as Doc), choice: model.tool_choice };
  const bands = overrides(model);
  const cost = shaped.cost === undefined ? undefined : structuredClone(shaped.cost) as Doc;
  if (cost !== undefined && bands !== undefined) {
    (cost.text as Doc as { input: Doc }).input.overrides = bands.input;
    (cost.text as Doc as { output: Doc }).output.overrides = bands.output;
  }
  return {
    ...shaped,
    base: base === undefined ? [] : [base],
    name,
    ...(decision ? { type: "decision" } : {}),
    capabilities: capabilities as Observation["capabilities"],
    ...(cost === undefined ? {} : { cost: cost as Observation["cost"] }),
    ...(model.responses_api === undefined ? {} : { api: { responses: model.responses_api ? RESPONSES_API : null } }),
    defaults: { ...shaped.defaults, capabilities: { reasoning: { supported: reasoning } } },
  } as Observation;
}

// Search's priced context bands (`min_prompt_tokens`), lowest first; undefined when it lists none.
function overrides(model: Row) {
  const price = (value: unknown) => {
    const number = typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000_000_000) / 1_000_000 : undefined;
  };
  const bands = (model.pricing.overrides ?? []).flatMap((override) => {
    const size = override.min_prompt_tokens;
    if (typeof size !== "number" || Object.keys(override).some((key) => !["min_prompt_tokens", "prompt", "completion", "internal_reasoning", "input_cache_read", "input_cache_write"].includes(key))) return [];
    const input = price(override.prompt) ?? price(model.pricing.prompt);
    const output = price(override.completion) ?? price(model.pricing.completion);
    if (input === undefined || output === undefined) return [];
    const read = price(override.input_cache_read);
    const write = price(override.input_cache_write);
    const cache = { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) };
    return [{ size, input: { when: { context: { gt: size } }, price: input, ...(Object.keys(cache).length > 0 ? { cache } : {}) }, output: { when: { context: { gt: size } }, price: output } }];
  }).sort((a, b) => a.size - b.size);
  if (bands.length === 0) return undefined;
  return { input: bands.map((band) => band.input), output: bands.map((band) => band.output) };
}

function hasReasoning(model: Row) {
  return model.supported_parameters.includes("reasoning") || model.supported_parameters.includes("include_reasoning")
    || model.reasoning?.mandatory !== undefined || model.reasoning?.supported_efforts !== undefined
    || model.reasoning?.supports_max_tokens === true;
}

// The controls search states concretely, or undefined when it doesn't.
function reasoningControls({ id, reasoning }: Row): { toggle?: true; effort?: string[]; budget?: Doc } | undefined {
  // A null allowlist doesn't name the model's controls.
  if (reasoning === undefined || reasoning.supported_efforts === null) return undefined;
  const efforts = reasoning.supported_efforts;
  if (efforts?.length === 0) return undefined;
  if (efforts === undefined && reasoning.supports_max_tokens !== true) {
    // GLM-4.7-Flash's verified shape is { mandatory: false, default_enabled: true }; its only control is enable_thinking.
    // https://huggingface.co/zai-org/GLM-4.7-Flash/blob/main/chat_template.jinja
    return id === "@cf/zai-org/glm-4.7-flash" && reasoning.mandatory === false ? { toggle: true } : undefined;
  }
  // Without a mandatory flag or a named off setting, a partial list can't say whether a toggle exists.
  if (reasoning.mandatory === undefined && !efforts?.includes("none")) return undefined;
  const controls: { toggle?: true; effort?: string[]; budget?: Doc } = {};
  if (reasoning.mandatory === false && !efforts?.includes("none")) controls.toggle = true;
  // Search lists efforts strongest first; files keep them weakest first.
  const values = (reasoning.mandatory ? efforts?.filter((value) => value !== "none") : efforts)
    ?.toSorted((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  // One mandatory effort offers no caller choice.
  const fixed = reasoning.mandatory === true && values?.length === 1;
  if (values?.length && !fixed) controls.effort = [...values];
  if (reasoning.supports_max_tokens === true) controls.budget = {};
  return Object.keys(controls).length > 0 || fixed ? controls : undefined;
}

// The one lab file of the publisher's lab whose name tokens all appear in the ID and name.
function resolveBase(model: Row) {
  const [, publisher] = model.id.split("/");
  const lab = publisher === undefined ? undefined : PUBLISHER_LABS[publisher];
  if (lab === undefined) return undefined;
  let files: string[];
  try {
    files = readdirSync(path.join(REPO_ROOT, "models", lab)).filter((file) => file.endsWith(".toml")).map((file) => file.slice(0, -5));
  } catch {
    return undefined;
  }
  const identity = new Set(tokens(`${model.id} ${model.name}`));
  const matches = files.filter((file) => tokens(file).every((token) => identity.has(token)));
  return matches.length === 1 ? `${lab}/${matches[0]}` : undefined;
}

const tokens = (value: string) => value.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [];

function fileHeader(id: string) {
  try {
    return leadingComments(readFileSync(path.join(REPO_ROOT, "providers", "cloudflare-workers-ai", "models", `${id}.toml`), "utf8"));
  } catch {
    return "";
  }
}

function rowsOf(response: z.infer<typeof Response>) {
  return response.data ?? (Array.isArray(response.result) ? response.result : response.result?.data ?? []);
}

async function page(account: string, token: string, number: number) {
  const url = new URL(`${API_BASE}/${account}/ai/models/search`);
  url.searchParams.set("format", "openrouter");
  url.searchParams.set("per_page", "1000");
  url.searchParams.set("page", String(number));
  const response = await fetch(url, { headers: bearer(token), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Cloudflare Workers AI search page ${number} failed: ${response.status} ${response.statusText}`);
  return Response.parse(await response.json());
}

async function schemaInput(account: string, token: string, id: string) {
  const url = new URL(`${API_BASE}/${account}/ai/models/schema`);
  url.searchParams.set("model", id);
  const response = await fetch(url, { headers: bearer(token), signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
  if (response === undefined || !response.ok) return undefined;
  const body = z.object({ result: z.object({ input: z.unknown() }).passthrough() }).passthrough().safeParse(await response.json());
  return body.success ? body.data.result.input : undefined;
}

// Whether a request schema has a variant with a top-level Responses `input` field.
export function takesResponsesBody(schema: unknown, depth = 0): boolean {
  if (!isTable(schema) || depth > 4) return false;
  if (isTable(schema.properties) && "input" in schema.properties) return true;
  return [...array(schema.oneOf), ...array(schema.anyOf)].some((variant) => takesResponsesBody(variant, depth + 1));
}

const TOOL_CHOICE_VALUES: Record<string, ToolChoiceV2> = { auto: "auto", none: "none", required: "required", any: "required", function: "tool", tool: "tool", custom: "tool" };

// The tool_choice values a request schema names: string enums and object variants
// by their `type`. Undefined when a variant leaves the value open.
export function schemaToolChoice(schema: unknown): ToolChoiceV2[] | undefined {
  const fields = toolChoiceFields(schema, 0);
  if (fields.length === 0) return undefined;
  const values = new Set<ToolChoiceV2>();
  for (const field of fields) {
    const listed = choiceValues(field, 0);
    if (listed === undefined) return undefined;
    for (const value of listed) values.add(value);
  }
  return values.size === 0 ? undefined : ToolChoiceV2.options.filter((value) => values.has(value));
}

function toolChoiceFields(schema: unknown, depth: number): unknown[] {
  if (!isTable(schema) || depth > 8) return [];
  const properties = isTable(schema.properties) ? schema.properties : {};
  const own = "tool_choice" in properties ? [properties.tool_choice] : [];
  const nested = [...Object.values(properties), ...array(schema.anyOf), ...array(schema.oneOf), ...(isTable(schema.items) ? [schema.items] : [])];
  return [...own, ...nested.flatMap((child) => toolChoiceFields(child, depth + 1))];
}

function choiceValues(node: unknown, depth: number): ToolChoiceV2[] | undefined {
  if (!isTable(node) || depth > 4) return undefined;
  const variants = [...array(node.anyOf), ...array(node.oneOf)];
  if (variants.length > 0) {
    const lists = variants.map((variant) => choiceValues(variant, depth + 1));
    return lists.some((list) => list === undefined) ? undefined : lists.flatMap((list) => list!);
  }
  if (node.type === "null") return [];
  if (node.type === "string") return named(node);
  if (node.type === "object" && isTable(node.properties) && isTable(node.properties.type)) return named(node.properties.type);
  return undefined;
}

function named(node: Doc): ToolChoiceV2[] | undefined {
  const values = node.const !== undefined ? [node.const] : array(node.enum);
  if (values.length === 0) return undefined;
  return values.flatMap((value) => (typeof value === "string" && TOOL_CHOICE_VALUES[value] !== undefined ? [TOOL_CHOICE_VALUES[value]] : []));
}

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
