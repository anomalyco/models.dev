// Observation files: what an agent writes after reading a host's docs, and
// the brief it reads first. The agent runs elsewhere; this file only defines
// the format, checks it and turns it into engine observations.

import { z } from "zod";

import { Labs, readProviderFiles, REPO_ROOT, resolved } from "./catalog.js";
import { getPath, setPath } from "./fields.js";
import type { AgentModule, Doc, Evidence, Observation, ObservedBatch, Owned, SyncModule } from "./types.js";

// The v2 fields an agent may state, with the values each takes. An agent
// module may only own these. `null` is allowed only where it means something
// safe: no context bands, not deprecated.
const price = { zod: z.number().finite().nonnegative(), json: { type: "number", minimum: 0 } };
const tokens = { zod: z.number().int().positive(), json: { type: "integer", minimum: 1 } };
const ttl = /^\d+[mh]$/;
const write = {
  zod: z.union([price.zod, z.record(z.string().regex(ttl), price.zod)]),
  json: { anyOf: [price.json, { type: "object", propertyNames: { pattern: ttl.source }, additionalProperties: price.json }] },
};
const band = {
  zod: z.object({
    when: z.object({ context: z.union([z.object({ gt: tokens.zod }).strict(), z.object({ gte: tokens.zod }).strict()]) }).strict(),
    price: price.zod,
    cache: z.object({ read: price.zod.optional(), write: write.zod.optional() }).strict().optional(),
  }).strict(),
  json: {
    type: "object",
    required: ["when", "price"],
    additionalProperties: false,
    properties: {
      when: {
        type: "object",
        required: ["context"],
        additionalProperties: false,
        properties: {
          context: {
            description: "Where the band starts: gt (prompts above) or gte (prompts of at least) this many tokens.",
            oneOf: ["gt", "gte"].map((key) => ({ type: "object", required: [key], additionalProperties: false, properties: { [key]: tokens.json } })),
          },
        },
      },
      price: price.json,
      cache: { type: "object", additionalProperties: false, properties: { read: price.json, write: write.json } },
    },
  },
};
const bands = {
  zod: z.array(band.zod).nullable(),
  json: { description: "Context bands, lowest first; null when the source says the price is flat.", anyOf: [{ type: "array", items: band.json }, { type: "null" }] },
};
const status = {
  zod: z.literal("deprecated").nullable(),
  json: { description: "\"deprecated\" once the host marks it legacy, deprecated or retiring; null when it doesn't.", anyOf: [{ const: "deprecated" }, { type: "null" }] },
};

export const AGENT_FIELDS: Record<string, { zod: z.ZodTypeAny; json: Doc; description: string }> = {
  "cost.text.input.price": { ...price, description: "USD per million input tokens" },
  "cost.text.output.price": { ...price, description: "USD per million output tokens" },
  "cost.text.input.cache.read": { ...price, description: "USD per million cached input tokens" },
  "cost.text.input.cache.write": { ...write, description: "USD per million tokens written to the cache: one price, or one per TTL ({ \"5m\": 6.25, \"1h\": 10 })" },
  "cost.text.input.overrides": { ...bands, description: "Input price bands by prompt length" },
  "cost.text.output.overrides": { ...bands, description: "Output price bands by prompt length" },
  "limit.context": { ...tokens, description: "Context window in tokens" },
  "limit.output": { ...tokens, description: "Maximum output tokens" },
  status: { ...status, description: "Deprecation status" },
};

/**
 * What the agent providers sync: text prices, limits and deprecation. A model
 * with no file is a gap and a dropped one is kept, so an agent never adds or
 * deletes a file. A listed price band list replaces the file's; leaving it out
 * keeps them.
 */
export const AGENT_POLICY = {
  owns: [
    "cost.text.input.price",
    "cost.text.output.price",
    "cost.text.input.cache.read",
    "cost.text.input.cache.write",
    { path: "cost.text.input.overrides", merge: "bands", optional: true },
    { path: "cost.text.output.overrides", merge: "bands", optional: true },
    "limit.context",
    "limit.output",
    { path: "status", merge: "deprecated" },
  ],
  creates: "gap",
  removals: "keep",
} satisfies AgentModule["policy"];

/** Chat models only: image, embedding and speech files are priced in ways the agent doesn't state. */
export const chatModels = (_id: string, model: Doc) => model.type === undefined || model.type === "chat";

const ownedPath = (owned: Owned) => (typeof owned === "string" ? owned : owned.path);

/** Hosts evidence may cite: the hosts of the module's sources. */
export function evidenceHosts(module: AgentModule) {
  return [...new Set(module.sources.map((source) => new URL(source.url).hostname))];
}

type Module = SyncModule<any> | AgentModule;

// The fields a file may state for this module: an agent module's owned
// fields (all in AGENT_FIELDS), or any owned field of an API module.
function fieldSchemas(module: Module): Map<string, z.ZodTypeAny> {
  return new Map(module.policy.owns.map(ownedPath).map((path) => {
    const known = AGENT_FIELDS[path];
    if (known === undefined && module.kind === "agent") throw new Error(`${module.id} owns ${path}, which agents can't state`);
    return [path, known?.zod ?? z.unknown().refine((value) => value !== undefined)];
  }));
}

function batchSchema(module: Module) {
  const fields = fieldSchemas(module);
  const hosts = module.kind === "agent" ? evidenceHosts(module) : undefined;
  const evidence = z.object({
    url: z.string().url().refine((url) => {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && (hosts === undefined || hosts.includes(parsed.hostname));
    }, hosts === undefined ? "must be https" : `must be https on ${hosts.join(", ")}`),
    quote: z.string().trim().min(1).max(1_000),
    fields: z.array(z.string()),
  }).strict();
  const observation = z.object({
    id: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/).refine((id) => !id.split("/").includes(".."), "must not contain .."),
    base: z.array(z.string().regex(/^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/, "must be a lab model ID like anthropic/claude-opus-4-6")).optional(),
    fields: z.record(z.unknown()),
    evidence: z.array(evidence).min(1),
  }).strict().superRefine((item, ctx) => {
    const backed = new Set(item.evidence.flatMap((quote) => quote.fields));
    for (const [path, value] of Object.entries(item.fields)) {
      const schema = fields.get(path);
      if (schema === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", path], message: `${path} isn't a field ${module.name} syncs (${[...fields.keys()].join(", ")})` });
        continue;
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ["fields", path, ...issue.path] });
      if (!backed.has(path)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", path], message: "no evidence quote backs this field" });
    }
    item.evidence.forEach((quote, index) => quote.fields.forEach((path, field) => {
      if (!(path in item.fields)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence", index, "fields", field], message: `${path} isn't stated in fields` });
    }));
  });
  return z.object({
    provider: z.literal(module.id),
    observed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    complete: z.boolean(),
    observations: z.array(observation),
  }).strict();
}

export type ObservationFile = z.infer<ReturnType<typeof batchSchema>>;

/**
 * Checks an observation file and turns it into engine observations. Any
 * problem rejects the whole file: unknown keys or fields, values of the wrong
 * shape, fields no evidence backs, evidence off the module's hosts, an ID
 * listed twice, a new ID the host can't have, or a file the module doesn't
 * speak for.
 */
export async function parseObservations(module: Module, input: unknown, root = REPO_ROOT): Promise<ObservedBatch> {
  const parsed = batchSchema(module).safeParse(input);
  const problems = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".") || "(file)"}: ${issue.message}`);
  if (parsed.success) {
    const files = await readProviderFiles(root, module.id);
    const byLowerID = new Map([...files.values()].map((file) => [file.id.toLowerCase(), file]));
    const labs = new Labs(root);
    const seen = new Set<string>();
    for (const [index, item] of parsed.data.observations.entries()) {
      const key = item.id.toLowerCase();
      if (seen.has(key)) problems.push(`observations.${index}.id: ${item.id} is listed twice`);
      seen.add(key);
      if (module.kind !== "agent") continue;
      const file = files.get(item.id) ?? byLowerID.get(key);
      if (file === undefined && !module.ids.test(item.id)) problems.push(`observations.${index}.id: ${item.id} isn't a ${module.name} file and doesn't look like a ${module.name} ID`);
      if (file !== undefined && module.scope?.(file.id, resolved(file.doc, labs)) === false) problems.push(`observations.${index}.id: ${module.name} observations don't cover ${file.id}`);
    }
  }
  if (!parsed.success || problems.length > 0) {
    throw new Error(`Rejected the observation file for ${module.name}:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  }
  const { observations, complete } = parsed.data;
  return {
    observations: observations.map((item) => {
      const observation: Observation = { id: item.id, ...(item.base === undefined ? {} : { base: item.base }) };
      for (const [path, value] of Object.entries(item.fields)) setPath(observation as Doc, path, structuredClone(value));
      return observation;
    }),
    evidence: observations.flatMap((item): Evidence[] => item.evidence.map((quote) => ({ model: item.id, url: quote.url, quote: quote.quote, fields: quote.fields }))),
    complete,
    by: module.kind === "agent" ? "agent" : "file",
  };
}

/** The observation file's JSON schema for an agent module. */
export function observationJSONSchema(module: AgentModule) {
  const paths = module.policy.owns.map(ownedPath);
  const fields = Object.fromEntries(paths.map((path) => {
    const known = AGENT_FIELDS[path];
    if (known === undefined) throw new Error(`${module.id} owns ${path}, which agents can't state`);
    return [path, { description: known.description, ...known.json }];
  }));
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `${module.name} observations`,
    type: "object",
    required: ["provider", "complete", "observations"],
    additionalProperties: false,
    properties: {
      provider: { const: module.id },
      observed_at: { type: "string", format: "date" },
      complete: { type: "boolean", description: "true only when the file lists every model the host serves; files it leaves out are then reported as dropped" },
      observations: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "fields", "evidence"],
          additionalProperties: false,
          properties: {
            id: { type: "string", pattern: module.ids.source, description: "The model ID on this host, which is also its file path" },
            base: { type: "array", items: { type: "string", pattern: "^[a-z0-9-]+/[A-Za-z0-9._:-]+$" }, description: "For a model with no file: lab model IDs (models/<lab>/<model>) it may be, best first" },
            fields: { type: "object", additionalProperties: false, properties: fields, description: "Only what a source states; leave out the rest" },
            evidence: {
              type: "array",
              minItems: 1,
              description: "Every stated field needs a quote that backs it",
              items: {
                type: "object",
                required: ["url", "quote", "fields"],
                additionalProperties: false,
                properties: {
                  url: { type: "string", format: "uri", description: `https on ${evidenceHosts(module).join(", ")}` },
                  quote: { type: "string", minLength: 1, maxLength: 1_000, description: "Text copied from the page" },
                  fields: { type: "array", items: { enum: paths } },
                },
              },
            },
          },
        },
      },
    },
  };
}

/** Everything the agent needs for one run. */
export async function agentBrief(module: AgentModule, root = REPO_ROOT) {
  const files = await readProviderFiles(root, module.id);
  const labs = new Labs(root);
  const paths = module.policy.owns.map(ownedPath);
  const listing = [...files.values()].flatMap((file) => {
    const model = resolved(file.doc, labs);
    if (module.scope?.(file.id, model) === false) return [];
    const values = Object.fromEntries(paths.map((path) => [path, getPath(model, path)]).filter(([, value]) => value !== undefined));
    return [{ id: file.id, ...(typeof file.doc.base_model === "string" ? { base_model: file.doc.base_model } : {}), values }];
  }).sort((a, b) => a.id.localeCompare(b.id));
  return {
    provider: module.id,
    name: module.name,
    kind: module.kind,
    instructions: module.instructions,
    sources: module.sources,
    evidenceHosts: evidenceHosts(module),
    owns: module.policy.owns,
    creates: module.policy.creates,
    removals: module.policy.removals,
    ids: module.ids.source,
    schema: observationJSONSchema(module),
    files: listing,
  };
}
