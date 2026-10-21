#!/usr/bin/env bun

import { z } from "zod";
import path from "node:path";
import { mkdir, rm, readdir, stat } from "node:fs/promises";

import { formatModelV2, patchModelV2, providerModelToV2 } from "../src/model-file-v2.js";
import { isSchemaV2, modelV2ToV1, roundPrice } from "../src/translate.js";

// Helicone public model registry endpoint
const DEFAULT_ENDPOINT =
  "https://jawn.helicone.ai/v1/public/model-registry/models";

// Zod schemas to validate the Helicone response
const Pricing = z
  .object({
    prompt: z.number().optional(),
    completion: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    reasoning: z.number().optional(),
  })
  .passthrough();

const Endpoint = z
  .object({
    provider: z.string(),
    providerSlug: z.string().optional(),
    supportsPtb: z.boolean().optional(),
    pricing: Pricing.optional(),
  })
  .passthrough();

const ModelItem = z
  .object({
    id: z.string(),
    name: z.string(),
    author: z.string().optional(),
    contextLength: z.number().optional(),
    maxOutput: z.number().optional(),
    trainingDate: z.string().optional(),
    description: z.string().optional(),
    inputModalities: z.array(z.string()).optional(),
    outputModalities: z.array(z.string()).optional(),
    supportedParameters: z.array(z.string()).optional(),
    endpoints: z.array(Endpoint).optional(),
  })
  .passthrough();

const HeliconeResponse = z
  .object({
    data: z.object({
      models: z.array(ModelItem),
      total: z.number().optional(),
      filters: z.any().optional(),
    }),
  })
  .passthrough();

function pickEndpoint(m: z.infer<typeof ModelItem>) {
  if (!m.endpoints || m.endpoints.length === 0) return undefined;
  // Prefer endpoint that matches author if available
  if (m.author) {
    const match = m.endpoints.find((e) => e.provider === m.author);
    if (match) return match;
  }
  return m.endpoints[0];
}

function boolFromParams(params: string[] | undefined, keys: string[]): boolean {
  if (!params) return false;
  const set = new Set(params.map((p) => p.toLowerCase()));
  return keys.some((k) => set.has(k.toLowerCase()));
}

function sanitizeModalities(values: string[] | undefined): string[] {
  if (!values) return ["text"]; // default to text
  const allowed = new Set(["text", "audio", "image", "video", "pdf"]);
  const out = values.map((v) => v.toLowerCase()).filter((v) => allowed.has(v));
  return out.length > 0 ? out : ["text"];
}

type HeliconeModel = z.infer<typeof ModelItem>;

// The registry's price for a model, in v1 cost fields (USD per 1M tokens).
export function heliconeCost(model: HeliconeModel) {
  const pricing = pickEndpoint(model)?.pricing;
  if (pricing === undefined) return undefined;
  const reasoning = boolFromParams(model.supportedParameters, ["reasoning", "include_reasoning"]);
  const cost: Record<string, number> = {};
  if (pricing.prompt !== undefined) cost.input = roundPrice(pricing.prompt);
  if (pricing.completion !== undefined) cost.output = roundPrice(pricing.completion);
  if (reasoning && pricing.reasoning !== undefined) cost.reasoning = roundPrice(pricing.reasoning);
  if (pricing.cacheRead !== undefined) cost.cache_read = roundPrice(pricing.cacheRead);
  if (pricing.cacheWrite !== undefined) cost.cache_write = roundPrice(pricing.cacheWrite);
  return Object.keys(cost).length > 0 ? cost : undefined;
}

// A full v1 model from the registry, for models without a file yet.
function heliconeModel(model: HeliconeModel) {
  const supported = model.supportedParameters ?? [];

  const nowISO = new Date().toISOString().slice(0, 10);
  const rdRaw = model.trainingDate ? String(model.trainingDate) : nowISO;
  const releaseDate = rdRaw.slice(0, 10);
  const knowledge = model.trainingDate
    ? String(model.trainingDate).slice(0, 7)
    : undefined;

  return {
    name: model.name,
    release_date: releaseDate,
    last_updated: releaseDate,
    reasoning: boolFromParams(supported, ["reasoning", "include_reasoning"]),
    temperature: boolFromParams(supported, ["temperature"]),
    tool_call: boolFromParams(supported, ["tools", "tool_choice"]),
    knowledge,
    open_weights: false,
    cost: heliconeCost(model),
    limit: { context: model.contextLength ?? 0, output: model.maxOutput ?? 4096 },
    modalities: {
      input: sanitizeModalities(model.inputModalities),
      output: sanitizeModalities(model.outputModalities),
    },
  };
}

export function newModelToml(model: HeliconeModel) {
  return formatModelV2(providerModelToV2(heliconeModel(model)));
}

// Existing files are authored v2 files; the registry only refreshes their price.
// Returns undefined when the price is unchanged, so the file is left as is.
export function updatedModelToml(text: string, model: HeliconeModel) {
  const doc = Bun.TOML.parse(text) as Record<string, any>;
  if (!isSchemaV2(doc)) throw new Error("not a v2 file; migrate it with migrate-v2.ts first");
  const { id: _id, ...before } = modelV2ToV1({ ...doc, id: model.id });
  const cost = heliconeCost(model);
  if (stable(before.cost) === stable(cost)) return undefined;
  const next = patchModelV2(doc, before, { ...before, cost });
  const content = leadingComments(text) + formatModelV2(next);
  const written = modelV2ToV1({ ...(Bun.TOML.parse(content) as Record<string, unknown>), id: model.id });
  if (stable(written.cost) !== stable(cost)) {
    throw new Error("the v2 file does not reproduce the registry price");
  }
  return content;
}

function leadingComments(text: string) {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() !== "" && !line.trim().startsWith("#")) break;
    lines.push(line);
  }
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function main() {
  const endpoint = DEFAULT_ENDPOINT;

  const outDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "providers",
    "helicone",
    "models",
  );

  const res = await fetch(endpoint);
  if (!res.ok) {
    console.error(`Failed to fetch registry: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const json = await res.json();

  const parsed = HeliconeResponse.safeParse(json);
  if (!parsed.success) {
    parsed.error.cause = json;
    console.error("Invalid Helicone response:", parsed.error.errors);
    console.error("When parsing:", parsed.error.cause);
    process.exit(1);
  }

  const models = parsed.data.data.models;
  await mkdir(outDir, { recursive: true });
  const fileName = (m: HeliconeModel) => `${m.id.replaceAll("/", "-")}.toml`;
  const listed = new Set(models.map(fileName));
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let unchanged = 0;

  // Remove subfolders and the TOML files of models the registry no longer lists
  for (const entry of await readdir(outDir)) {
    const p = path.join(outDir, entry);
    const st = await stat(p);
    if (st.isDirectory()) {
      await rm(p, { recursive: true, force: true });
    } else if (st.isFile() && entry.endsWith(".toml") && !listed.has(entry)) {
      await rm(p, { force: true });
      deleted++;
    }
  }

  for (const m of models) {
    const file = fileName(m);
    const filePath = path.join(outDir, file);
    const current = Bun.file(filePath);
    if (!(await current.exists())) {
      await Bun.write(filePath, newModelToml(m));
      created++;
      continue;
    }
    try {
      const toml = updatedModelToml(await current.text(), m);
      if (toml === undefined) {
        unchanged++;
        continue;
      }
      await Bun.write(filePath, toml);
      updated++;
    } catch (error) {
      console.warn(`Skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(
    `providers/helicone/models: ${created} created, ${updated} updated, ${deleted} deleted, ${unchanged} unchanged`,
  );
  if (created > 0) {
    console.log("New files are standalone registry data: link them to their labs and add descriptions by hand.");
  }
}

if (import.meta.main) await main();
