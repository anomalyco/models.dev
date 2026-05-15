#!/usr/bin/env bun

import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { z } from "zod";

import { ModelFamilyValues } from "../src/family.js";
import { AuthoredModel, AuthoredModelShape } from "../src/schema.js";

const API_ENDPOINT = "https://openrouter.ai/api/v1/models";

const OpenRouterModel = z
  .object({
    id: z.string(),
    name: z.string(),
    created: z.number(),
    hugging_face_id: z.string().nullable(),
    knowledge_cutoff: z.string().nullable(),
    context_length: z.number(),
    architecture: z.object({
      input_modalities: z.array(z.string()),
      output_modalities: z.array(z.string()),
    }),
    pricing: z
      .object({
        prompt: z.string(),
        completion: z.string(),
        internal_reasoning: z.string().optional(),
        input_cache_read: z.string().optional(),
        input_cache_write: z.string().optional(),
      }),
    top_provider: z.object({
      context_length: z.number().nullable(),
      max_completion_tokens: z.number().nullable(),
    }),
    supported_parameters: z.array(z.string()),
  });

const OpenRouterResponse = z
  .object({
    data: z.array(OpenRouterModel),
  })
  .passthrough();

const ExistingModel = AuthoredModelShape.partial()
  .extend({
    extends: z
      .object({
        from: z.string(),
        omit: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type OpenRouterModel = z.infer<typeof OpenRouterModel>;
type ExistingModel = z.infer<typeof ExistingModel>;

function dateFromTimestamp(timestamp: number | undefined) {
  if (timestamp === undefined) return new Date().toISOString().slice(0, 10);
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function formatInteger(n: number) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}

function quote(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

function modality(value: string) {
  return value === "file" ? "pdf" : value;
}

function modalities(values: string[] | undefined, fallback: string[]) {
  const allowed = new Set(["text", "audio", "image", "video", "pdf"]);
  const result = (values ?? fallback)
    .map((value) => modality(value.toLowerCase()))
    .filter((value) => allowed.has(value));
  return [...new Set(result.length > 0 ? result : fallback)];
}

function inferFamily(model: OpenRouterModel, name: string) {
  const target = `${model.id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") {
        return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      }
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

function buildModel(model: OpenRouterModel, existing: ExistingModel | undefined) {
  const params = new Set(model.supported_parameters ?? []);
  const name = model.name.replace(/^[^:]+:\s+/, "");
  const input = modalities(model.architecture?.input_modalities, ["text"]);
  const output = modalities(model.architecture?.output_modalities, ["text"]);
  const prompt = price(model.pricing?.prompt);
  const completion = price(model.pricing?.completion);
  const reasoning = params.has("reasoning") || params.has("include_reasoning");
  const context = model.top_provider?.context_length ?? model.context_length ?? 0;
  const maxOutput = model.top_provider?.max_completion_tokens ?? existing?.limit?.output ?? context;
  const family = inferFamily(model, name);

  return {
    name,
    family: existing?.family === "o" && family !== "o"
      ? family
      : (existing?.family ?? family),
    release_date: dateFromTimestamp(model.created),
    last_updated: dateFromTimestamp(model.created),
    attachment: input.some((value) => value !== "text"),
    reasoning,
    temperature: params.has("temperature"),
    tool_call: params.has("tools") || params.has("tool_choice"),
    structured_output:
      params.has("structured_outputs") || params.has("response_format"),
    knowledge: model.knowledge_cutoff?.slice(0, 10) ?? existing?.knowledge,
    open_weights: Boolean(model.hugging_face_id),
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost:
      prompt !== undefined && completion !== undefined
        ? {
            input: prompt,
            output: completion,
            reasoning: reasoning ? price(model.pricing?.internal_reasoning) : undefined,
            cache_read: price(model.pricing?.input_cache_read),
            cache_write: price(model.pricing?.input_cache_write),
            tiers: existing?.cost?.tiers,
          }
        : existing?.cost,
    limit: {
      context,
      input: existing?.limit?.input,
      output: maxOutput,
    },
    modalities: { input, output },
  };
}

function formatToml(model: ReturnType<typeof buildModel>) {
  const lines: string[] = [];

  lines.push(`name = ${quote(model.name)}`);
  if (model.family) lines.push(`family = ${quote(model.family)}`);
  lines.push(`release_date = ${quote(model.release_date)}`);
  lines.push(`last_updated = ${quote(model.last_updated)}`);
  lines.push(`attachment = ${model.attachment}`);
  lines.push(`reasoning = ${model.reasoning}`);
  lines.push(`temperature = ${model.temperature}`);
  lines.push(`tool_call = ${model.tool_call}`);
  lines.push(`structured_output = ${model.structured_output}`);
  if (model.knowledge) lines.push(`knowledge = ${quote(model.knowledge)}`);
  lines.push(`open_weights = ${model.open_weights}`);
  if (model.status) lines.push(`status = ${quote(model.status)}`);

  if (model.interleaved !== undefined) {
    lines.push("");
    if (model.interleaved === true) {
      lines.push("interleaved = true");
    } else {
      lines.push("[interleaved]");
      lines.push(`field = ${quote(model.interleaved.field)}`);
    }
  }

  if (model.cost) {
    lines.push("");
    lines.push("[cost]");
    if (model.cost.input !== undefined) lines.push(`input = ${model.cost.input}`);
    if (model.cost.output !== undefined) lines.push(`output = ${model.cost.output}`);
    if (model.cost.reasoning !== undefined) {
      lines.push(`reasoning = ${model.cost.reasoning}`);
    }
    if (model.cost.cache_read !== undefined) {
      lines.push(`cache_read = ${model.cost.cache_read}`);
    }
    if (model.cost.cache_write !== undefined) {
      lines.push(`cache_write = ${model.cost.cache_write}`);
    }

    for (const tier of model.cost.tiers ?? []) {
      lines.push("");
      lines.push("[[cost.tiers]]");
      lines.push(`tier = { size = ${formatInteger(tier.tier.size)} }`);
      if (tier.input !== undefined) lines.push(`input = ${tier.input}`);
      if (tier.output !== undefined) lines.push(`output = ${tier.output}`);
      if (tier.cache_read !== undefined) lines.push(`cache_read = ${tier.cache_read}`);
      if (tier.cache_write !== undefined) lines.push(`cache_write = ${tier.cache_write}`);
    }
  }

  lines.push("");
  lines.push("[limit]");
  lines.push(`context = ${formatInteger(model.limit.context)}`);
  if (model.limit.input !== undefined) {
    lines.push(`input = ${formatInteger(model.limit.input)}`);
  }
  lines.push(`output = ${formatInteger(model.limit.output)}`);

  lines.push("");
  lines.push("[modalities]");
  lines.push(`input = [${model.modalities.input.map(quote).join(", ")}]`);
  lines.push(`output = [${model.modalities.output.map(quote).join(", ")}]`);

  return `${lines.join("\n")}\n`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const modelsDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "providers",
    "openrouter",
    "models",
  );
  const headers = process.env.OPENROUTER_API_KEY
    ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
    : undefined;

  const response = await fetch(API_ENDPOINT, { headers });
  if (!response.ok) {
    throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText}`);
  }

  const parsed = OpenRouterResponse.safeParse(await response.json());
  if (!parsed.success) throw parsed.error;

  const existingFiles = new Set<string>();
  for await (const file of new Bun.Glob("**/*.toml").scan({ cwd: modelsDir })) {
    existingFiles.add(file);
  }

  let created = 0;
  let updated = 0;
  let removed = 0;
  let unchanged = 0;
  const apiFiles = new Set<string>();

  for (const apiModel of parsed.data.data) {
    const relativePath = `${apiModel.id}.toml`;
    const filePath = path.join(modelsDir, relativePath);
    const file = Bun.file(filePath);
    const current = await file.exists() ? await file.text() : undefined;
    const existing = current === undefined
      ? undefined
      : ExistingModel.parse(Bun.TOML.parse(current));
    const model = buildModel(apiModel, existing);
    const next = formatToml(model);

    const valid = AuthoredModel.safeParse({
      id: relativePath.slice(0, -5),
      ...Bun.TOML.parse(next),
    });
    if (!valid.success) {
      valid.error.cause = { relativePath };
      throw valid.error;
    }

    apiFiles.add(relativePath);

    if (current === undefined) {
      created++;
      if (dryRun) {
        console.log(`Would create ${relativePath}`);
      } else {
        await mkdir(path.dirname(filePath), { recursive: true });
        await Bun.write(filePath, next);
      }
      continue;
    }

    if (current !== next) {
      updated++;
      if (dryRun) {
        console.log(`Would update ${relativePath}`);
      } else {
        await Bun.write(filePath, next);
      }
    } else {
      unchanged++;
    }
  }

  for (const relativePath of existingFiles) {
    if (apiFiles.has(relativePath)) continue;

    removed++;
    if (dryRun) {
      console.log(`Would remove ${relativePath}`);
    } else {
      await rm(path.join(modelsDir, relativePath));
    }
  }

  console.log(
    `${dryRun ? "Dry run: " : ""}${created} created, ${updated} updated, ${removed} removed, ${unchanged} unchanged`,
  );
}

await main();
