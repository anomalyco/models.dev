// Cloudflare AI Gateway: the unified catalog (GET /accounts/{id}/ai/catalog/models)
// and each model's request schema (/ai/catalog/models/{id}/schema), with
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, plus the hand-kept
// providers/cloudflare-ai-gateway/curation.toml. Proxied text models own their
// prices (with a long-context band), context window, curated limits,
// structured output and reasoning field, reasoning controls (curated, else the
// schema's effort enum), the APIs (the native route for OpenAI and Anthropic,
// a REST table for every other request format) and tool fields (the lab's own
// API's, else the schema's tool_choice). Speech, transcription, image and video
// models are generated whole as v2-only files on the /ai/run route. Every
// file's leading comment comes from the curation notes. Models the catalog
// drops are deleted; a reasoning model with no controls keeps its file.
//
// Fetching and the catalog-to-model mapping are the old module's
// (../../sync/providers/cloudflare-ai-gateway.ts); this module turns its output
// into observations.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { MissingReasoningOptionsError } from "../../sync/missing-reasoning-options.js";
import {
  buildCloudflareAiGatewayMediaModel,
  buildCloudflareAiGatewayModel,
  cloudflareAiGateway as old,
  gatewayApis,
  gatewayTools,
  splitLabTools,
} from "../../sync/providers/cloudflare-ai-gateway.js";
import { Labs, REPO_ROOT } from "../catalog.js";
import { getPath, isTable } from "../fields.js";
import type { Doc, Observation, SyncModule } from "../types.js";

const TEXT_GENERATION = "Text Generation";
const MEDIA_TASKS: Record<string, string> = {
  "Text-to-Speech": "speech",
  "Automatic Speech Recognition": "transcription",
  "Text-to-Image": "image",
  "Image-to-Image": "image",
  "Text-to-Video": "video",
  "Image-to-Video": "video",
  "video-to-video": "video",
};
const NATIVE_BASE = "https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}";
const NATIVE_API: Record<string, { npm: string; api: string; protocol: string }> = {
  anthropic: { npm: "@ai-sdk/anthropic", api: `${NATIVE_BASE}/anthropic/v1`, protocol: "messages" },
  openai: { npm: "@ai-sdk/openai", api: `${NATIVE_BASE}/openai`, protocol: "responses" },
};
const DECISION_RUN_API = {
  "workers-ai-run": {
    base_url: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai",
    path: "/run",
    sdk: { opencodeai: "@opencode/ai/providers/cloudflare-ai-gateway/decisions" },
  },
};
const MEDIA_ROUTE = "Route: REST POST /ai/run with { model, input }; input per GET /ai/catalog/models/{id}/schema. https://developers.cloudflare.com/ai-gateway/usage/rest-api/";
const PRICES = "Prices: catalog provider_details, USD, passed through with no markup (https://developers.cloudflare.com/ai-gateway/features/unified-billing/).";
const MEDIA_NOTES: Record<string, string[]> = {
  speech: [MEDIA_ROUTE, `Output: the schema's output format enum (output_format, response_format or format), else the lab's or the note below. ${PRICES}`],
  transcription: [MEDIA_ROUTE, `Input: the formats the schema's file field documents, else the lab's. ${PRICES}`],
  image: [MEDIA_ROUTE, `Modalities: the schema's prompt/image fields (the lab's MIME types) and output_format enum, else the lab's outputs. ${PRICES}`],
  video: [MEDIA_ROUTE, "Modalities: the schema's prompt/image/video/audio fields (the lab's MIME types) and output_format enum, else the lab's video outputs. Prices: catalog provider_details per second of output video, USD, passed through with no markup (https://developers.cloudflare.com/ai-gateway/features/unified-billing/)."],
};
const TOOL_FIELDS = ["strict", "choice", "search", "freeform"];

interface Curated {
  base_model?: string;
  structured_output?: boolean;
  interleaved?: true | { field: string };
  note?: string[];
  [key: string]: unknown;
}
interface Curation {
  skip?: string[];
  prefix_notes?: Record<string, string[]>;
  models?: Record<string, Curated>;
}

interface Source {
  catalog: { model_id: string; task: string; context_length?: number | null; request_formats?: string[] | null; [key: string]: unknown };
  schemaInput?: unknown;
}

let labs: Labs | undefined;
let curation: Curation | undefined;

export const cloudflareAiGateway: SyncModule<unknown> = {
  id: "cloudflare-ai-gateway",
  name: "Cloudflare AI Gateway",
  policy: {
    owns: [
      "v2_only",
      "name",
      "description",
      "modalities",
      "capabilities.reasoning",
      "capabilities.tools",
      "capabilities.structured_output",
      "limit.context",
      "limit.input",
      "limit.output",
      "api",
      "cost",
    ],
    creates: "auto",
    removals: "delete",
    headers: "replace",
  },
  fetch: () => old.fetchModels(),
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    curation ??= Bun.TOML.parse(readFileSync(path.join(REPO_ROOT, "providers", "cloudflare-ai-gateway", "curation.toml"), "utf8")) as Curation;
    return (old.parseModels(raw) as Source[]).map((source) => observe(source, curation!, labs!));
  },
  refine(observation, file) {
    const text = texts.get(observation.id);
    if (text === undefined) return observation;
    const { source, curated, base, controls } = text;
    const id = observation.id;
    const native = NATIVE_API[id.split("/")[0]!];
    const decision = base !== undefined && labs!.get(base)?.type === "decision";

    // The native route is the first table's address, and the curated reasoning field is on it.
    const own = isTable(file?.api) ? structuredClone(file.api) : {};
    const firstKey = Object.keys(own)[0] ?? (native?.protocol ?? undefined);
    if (firstKey !== undefined && (native !== undefined || Object.keys(own).length > 0)) {
      const first = { ...(isTable(own[firstKey]) ? own[firstKey] as Doc : {}) };
      if (native !== undefined) {
        first.base_url = native.api;
        first.sdk = { ...(isTable(first.sdk) ? first.sdk : {}), aisdk: native.npm };
      }
      const compatibility = { ...(isTable(first.compatibility) ? first.compatibility : {}) };
      delete compatibility.reasoning_field;
      delete first.legacy_interleaved;
      if (isTable(curated.interleaved)) compatibility.reasoning_field = curated.interleaved.field;
      else if (curated.interleaved === true) first.legacy_interleaved = true;
      if (Object.keys(compatibility).length > 0) first.compatibility = compatibility;
      else delete first.compatibility;
      own[firstKey] = first;
    }
    const current = Object.keys(own).length > 0 ? own : undefined;

    const tools = !decision && base !== undefined && labs!.get(base) !== undefined && getPath(labs!.get(base), "capabilities.tools.supported") === true;
    const lab = tools && native ? firstPartyTools(base!) : undefined;
    const labTools = lab && native ? splitLabTools(lab, Object.keys(gatewayApis(undefined, native.protocol, source.catalog.request_formats) ?? {})) : undefined;
    const api = decision ? DECISION_RUN_API : gatewayApis(current, native?.protocol, source.catalog.request_formats, labTools?.apis);

    const reasoning = controls === undefined
      ? undefined
      : { ...withoutControls(getPath(file, "capabilities.reasoning")), supported: true, ...controls };
    return {
      ...observation,
      capabilities: {
        ...observation.capabilities,
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(tools ? { tools: gatewayTools(getPath(file, "capabilities.tools"), labTools?.top, source.schemaInput) } : {}),
      },
      api: api ?? null,
      cost: textCost(observation.cost as Doc, file),
    } as Observation;
  },
};

// What refine needs for a text model.
const texts = new Map<string, { source: Source; curated: Curated; base?: string; controls?: Doc }>();

function observe(source: Source, curation: Curation, labs: Labs): Observation {
  const id = source.catalog.model_id;
  const curated = curation.models?.[id] ?? {};
  const header = (notes: string[]) => notes.map((line) => `# ${line}`).join("\n");
  if (source.catalog.task !== TEXT_GENERATION) {
    const type = MEDIA_TASKS[source.catalog.task]!;
    const base = curated.base_model ?? mediaBase(id, labs);
    if (base === undefined) return { id };
    const { doc, unpriced } = buildCloudflareAiGatewayMediaModel(source.catalog as never, source.schemaInput, curated as never);
    return {
      id,
      base: [base],
      header: header([
        ...MEDIA_NOTES[type]!,
        ...(unpriced === undefined ? [] : [`No [cost]: catalog pricing keys ${unpriced.join(", ")} have no cost unit or condition to express them.`]),
        ...curated.note ?? [],
      ]),
      v2_only: true,
      name: (doc.name as string | undefined) ?? null,
      description: null,
      modalities: (doc.modalities as Observation["modalities"]) ?? null,
      capabilities: { tools: (getPath(doc, "capabilities.tools") as never) ?? null, reasoning: (getPath(doc, "capabilities.reasoning") as never) ?? null },
      api: doc.api as Observation["api"],
      cost: (doc.cost as Observation["cost"]) ?? null,
    } as Observation;
  }

  const base = curated.base_model ?? textBase(id, labs);
  if (base === undefined) return { id };
  let model: Doc;
  try {
    model = buildCloudflareAiGatewayModel(source.catalog as never, source.schemaInput, curated as never) as Doc;
  } catch (error) {
    // A reasoning model with no controls keeps its file.
    if (error instanceof MissingReasoningOptionsError) return { id, updateOnly: true };
    throw error;
  }
  const options = model.reasoning_options as Array<Doc> | undefined;
  const controls = options === undefined ? undefined : {
    toggle: options.some((option) => option.type === "toggle") ? true : undefined,
    effort: options.find((option) => option.type === "effort")?.values,
    budget: (() => {
      const budget = options.find((option) => option.type === "budget_tokens");
      if (budget === undefined) return undefined;
      const { type: _type, ...range } = budget;
      return range;
    })(),
  };
  texts.set(id, { source, curated, base, controls: controls === undefined ? undefined : Object.fromEntries(Object.entries(controls).filter(([, value]) => value !== undefined)) });
  const cost = model.cost as Doc;
  const tier = (cost.tiers as Array<Doc> | undefined)?.[0];
  const limit = (model.limit ?? {}) as Doc;
  return {
    id,
    base: [base],
    header: header([...prefixNotes(id, curation), ...curated.note ?? []]),
    name: null,
    description: null,
    ...(model.structured_output === undefined ? {} : { capabilities: { structured_output: model.structured_output } }),
    limit: {
      ...(limit.context === undefined ? {} : { context: limit.context }),
      input: limit.input ?? null,
      output: limit.output ?? null,
    },
    cost: {
      text: {
        input: { price: cost.input, cache: { read: cost.cache_read, write: cost.cache_write }, overrides: tier === undefined ? undefined : [{ when: { context: { gt: (tier.tier as Doc).size } }, price: tier.input, cache: { read: tier.cache_read, write: tier.cache_write } }] },
        output: { price: cost.output, overrides: tier === undefined ? undefined : [{ when: { context: { gt: (tier.tier as Doc).size } }, price: tier.output }] },
      },
    },
  } as Observation;
}

// The whole text cost: catalog prices, a write price on the file's first cache
// TTL, a band keeping the file's operator. The file's non-token costs stay.
function textCost(observed: Doc, file: Doc | undefined) {
  const own = isTable(file?.cost) ? file.cost : {};
  const { text: _text, audio: _audio, ...kept } = own;
  const input = getPath(observed, "text.input") as Doc;
  const output = getPath(observed, "text.output") as Doc;
  const cache = (read: unknown, write: unknown, fileWrite: unknown) => {
    const merged = typeof write === "number" && isTable(fileWrite) ? { ...fileWrite, [Object.keys(fileWrite)[0]!]: write } : write;
    const value = { ...(read === undefined ? {} : { read }), ...(merged === undefined ? {} : { write: merged }) };
    return Object.keys(value).length > 0 ? { cache: value } : {};
  };
  const band = (overrides: unknown, fileOverrides: unknown, withCache: boolean) => {
    if (!Array.isArray(overrides)) return {};
    return {
      overrides: overrides.map((item: Doc) => {
        const match = Array.isArray(fileOverrides)
          ? fileOverrides.find((candidate) => isTable(candidate) && isTable(getPath(candidate, "when.context")) && Object.values(getPath(candidate, "when.context") as Doc)[0] === getPath(item, "when.context.gt"))
          : undefined;
        const when = isTable(match) ? match.when : item.when;
        const { when: _when, cache: itemCache, ...prices } = item;
        return { when, ...prices, ...(withCache ? cache(getPath(itemCache, "read"), getPath(itemCache, "write"), getPath(match, "cache.write")) : {}) };
      }),
    };
  };
  const fileInput = getPath(own, "text.input");
  return {
    ...kept,
    text: {
      input: { price: input.price, ...cache(getPath(input, "cache.read"), getPath(input, "cache.write"), getPath(fileInput, "cache.write")), ...band(input.overrides, getPath(fileInput, "overrides"), true) },
      output: { price: output.price, ...band(output.overrides, getPath(own, "text.output.overrides"), false) },
    },
  };
}

function withoutControls(reasoning: unknown) {
  if (!isTable(reasoning)) return {};
  const { toggle: _toggle, effort: _effort, budget: _budget, ...rest } = reasoning;
  return rest;
}

function textBase(id: string, labs: Labs) {
  for (const candidate of [id, id.replaceAll(".", "-")]) {
    if (existsSync(path.join(REPO_ROOT, "models", `${candidate}.toml`))) return candidate;
  }
  return undefined;
}

// The same path, dots as dashes, or the one file in the lab directory whose name matches without punctuation.
function mediaBase(id: string, labs: Labs) {
  const direct = textBase(id, labs);
  if (direct !== undefined) return direct;
  const [lab, ...rest] = id.split("/");
  const slug = normalize(rest.join("/"));
  const matches = labs.all().filter((candidate) => candidate.startsWith(`${lab}/`) && normalize(candidate.slice(lab!.length + 1)) === slug);
  return matches.length === 1 ? matches[0] : undefined;
}

const normalize = (value: string) => value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

function prefixNotes(id: string, curation: Curation) {
  return Object.entries(curation.prefix_notes ?? {})
    .filter(([prefix]) => id.startsWith(prefix))
    .sort(([a], [b]) => a.length - b.length)
    .flatMap(([, lines]) => lines);
}

// The tool fields of the lab's own provider file, top-level and per API, when it states any.
function firstPartyTools(base: string) {
  const [lab, ...rest] = base.split("/");
  const file = path.join(REPO_ROOT, "providers", lab!, "models", `${rest.join("/")}.toml`);
  if (!existsSync(file)) return undefined;
  const doc = Bun.TOML.parse(readFileSync(file, "utf8")) as Doc;
  const fields = (tools: unknown) => Object.fromEntries(Object.entries(isTable(tools) ? tools : {}).filter(([key]) => TOOL_FIELDS.includes(key)));
  const top = fields(getPath(doc, "capabilities.tools"));
  const apis = Object.fromEntries(Object.entries(isTable(doc.api) ? doc.api : {}).map(([protocol, table]) => [protocol, fields(getPath(table, "capabilities.tools"))]));
  return [top, ...Object.values(apis)].some((value) => Object.keys(value).length > 0) ? { top, apis } : undefined;
}
