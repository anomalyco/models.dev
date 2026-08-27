#!/usr/bin/env bun

import { z } from "zod";
import path from "node:path";
import { mkdir, rm, readdir, stat } from "node:fs/promises";

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

interface ExistingModel {
  base_model?: string;
  base_model_omit?: string[];
}

async function loadExistingModel(filePath: string): Promise<ExistingModel | undefined> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return undefined;
  return await import(filePath, { with: { type: "toml" } }).then(
    (mod) => mod.default as ExistingModel,
  );
}

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

function formatToml(model: z.infer<typeof ModelItem>, existing: ExistingModel | undefined) {
  const ep = pickEndpoint(model);
  const pricing = ep?.pricing;

  const supported = model.supportedParameters ?? [];

  const nowISO = new Date().toISOString().slice(0, 10);
  const rdRaw = model.trainingDate ? String(model.trainingDate) : nowISO;
  const releaseDate = rdRaw.slice(0, 10);
  const lastUpdated = releaseDate;
  const knowledge = model.trainingDate
    ? String(model.trainingDate).slice(0, 7)
    : undefined;

  const attachment = false; // Not exposed by Helicone registry
  const temperature = boolFromParams(supported, ["temperature"]);
  const toolCall = boolFromParams(supported, ["tools", "tool_choice"]);
  const reasoning = boolFromParams(supported, [
    "reasoning",
    "include_reasoning",
  ]);

  const inputMods = sanitizeModalities(model.inputModalities);
  const outputMods = sanitizeModalities(model.outputModalities);

  const lines: string[] = [];
  if (existing?.base_model !== undefined) {
    lines.push(`base_model = "${existing.base_model}"`);
  }
  if (existing?.base_model_omit !== undefined) {
    lines.push(
      `base_model_omit = [${existing.base_model_omit.map((item) => `"${item}"`).join(", ")}]`,
    );
  }
  lines.push(`name = "${model.name.replaceAll('"', '\\"')}"`);
  lines.push(`release_date = "${releaseDate}"`);
  lines.push(`last_updated = "${lastUpdated}"`);
  lines.push(`attachment = ${attachment}`);
  lines.push(`reasoning = ${reasoning}`);
  lines.push(`temperature = ${temperature}`);
  lines.push(`tool_call = ${toolCall}`);
  if (knowledge) lines.push(`knowledge = "${knowledge}"`);
  lines.push(`open_weights = false`);
  lines.push("");

  if (
    pricing &&
    (pricing.prompt ??
      pricing.completion ??
      pricing.cacheRead ??
      pricing.cacheWrite ??
      (reasoning && pricing.reasoning)) !== undefined
  ) {
    lines.push(`[cost]`);
    if (pricing.prompt !== undefined) lines.push(`input = ${pricing.prompt}`);
    if (pricing.completion !== undefined)
      lines.push(`output = ${pricing.completion}`);
    if (reasoning && pricing.reasoning !== undefined)
      lines.push(`reasoning = ${pricing.reasoning}`);
    if (pricing.cacheRead !== undefined)
      lines.push(`cache_read = ${pricing.cacheRead}`);
    if (pricing.cacheWrite !== undefined)
      lines.push(`cache_write = ${pricing.cacheWrite}`);
    lines.push("");
  }

  const context = model.contextLength ?? 0;
  const output = model.maxOutput ?? 4096;
  lines.push(`[limit]`);
  lines.push(`context = ${context}`);
  lines.push(`output = ${output}`);
  lines.push("");

  lines.push(`[modalities]`);
  lines.push(`input = [${inputMods.map((m) => `"${m}"`).join(", ")}]`);
  lines.push(`output = [${outputMods.map((m) => `"${m}"`).join(", ")}]`);

  return lines.join("\n") + "\n";
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
  const existing = new Map<string, ExistingModel>();
  await mkdir(outDir, { recursive: true });
  for await (const file of new Bun.Glob("**/*.toml").scan({ cwd: outDir })) {
    const filePath = path.join(outDir, file);
    const model = await loadExistingModel(filePath);
    if (model !== undefined) existing.set(file, model);
  }

  // Clean output directory: remove subfolders and existing TOML files
  for (const entry of await readdir(outDir)) {
    const p = path.join(outDir, entry);
    const st = await stat(p);
    if (st.isDirectory()) {
      await rm(p, { recursive: true, force: true });
    } else if (st.isFile() && entry.endsWith(".toml")) {
      await rm(p, { force: true });
    }
  }
  let created = 0;

  for (const m of models) {
    const fileSafeId = m.id.replaceAll("/", "-");
    const filePath = path.join(outDir, `${fileSafeId}.toml`);
    const toml = formatToml(m, existing.get(`${fileSafeId}.toml`));
    await Bun.write(filePath, toml);
    created++;
  }

  console.log(
    `Generated ${created} model file(s) under providers/helicone/models/*.toml`,
  );
}

await main();
