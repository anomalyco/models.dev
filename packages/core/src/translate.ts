import { readFileSync } from "node:fs";

import { LabModelV2 } from "./schema-v2.js";

// Files authored in the v2 format declare `schema = 2`. During the migration both
// formats live side by side, and every reader translates v2 files back to v1.
export function isSchemaV2(toml: Record<string, unknown>) {
  return toml.schema === 2;
}

// Reads a lab model file (`models/<lab>/<model>.toml`) as v1 fields.
export function readLabModel(filePath: string, modelID: string) {
  const toml = Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  return isSchemaV2(toml)
    ? labModelV2ToV1({ ...toml, id: modelID }, { modelPath: filePath })
    : toml;
}

export function labModelV2ToV1(
  toml: Record<string, unknown>,
  cause: Record<string, unknown> = {},
): Record<string, unknown> {
  const { schema: _schema, ...raw } = toml;
  const parsed = LabModelV2.safeParse(raw);
  if (!parsed.success) {
    parsed.error.cause = { ...cause, toml };
    throw parsed.error;
  }
  const lab = parsed.data;
  const input = toV1Modalities(lab.modalities.input);

  return withoutUndefined({
    id: lab.id,
    type: lab.type,
    name: lab.name,
    description: lab.description,
    family: lab.family,
    attachment: input.some((modality) => modality !== "text"),
    reasoning: lab.capabilities.reasoning.supported,
    tool_call: lab.capabilities.tools.supported,
    structured_output: lab.capabilities.structured_output,
    temperature: lab.capabilities.temperature,
    knowledge: lab.knowledge,
    release_date: lab.release_date,
    last_updated: lab.last_updated ?? lab.release_date,
    modalities: { input, output: toV1Modalities(lab.modalities.output) },
    open_weights: lab.open_weights,
    limit:
      lab.limit === undefined
        ? undefined
        : withoutUndefined({
            context: lab.limit.context,
            input: lab.limit.input,
            output: lab.limit.output,
          }),
    license: lab.license,
    links: lab.links,
    weights: lab.weights,
    benchmarks: lab.benchmarks,
  });
}

function toV1Modalities(modalities: string[]) {
  return [...new Set(modalities.map(toV1Modality))];
}

function toV1Modality(modality: string) {
  if (modality === "application/pdf") return "pdf";
  if (["decision", "embedding", "reranking"].includes(modality)) return "text";
  const base = modality.split("/")[0]!;
  if (["text", "image", "audio", "video"].includes(base)) return base;
  throw new Error(`No v1 modality for "${modality}"`);
}

function withoutUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
