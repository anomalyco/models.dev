import { mergeDeep } from "remeda";
import { z } from "zod";
import { AuthoredModelShape } from "../schema.js";
import type { ExistingModel } from "./index.js";

export const ExistingModelFields = AuthoredModelShape.deepPartial()
  .extend({
    base_model: z.string().optional(),
    base_model_omit: z.array(z.string()).optional(),
  })
  .strict();


export function resolveBaseModel(
  authored: z.infer<typeof ExistingModelFields>,
  modelMetadata: Record<string, Record<string, unknown>>,
  modelPath: string,
) {
  const baseModelID = authored.base_model;
  if (baseModelID === undefined) return authored as ExistingModel;

  const base = modelMetadata[baseModelID];
  if (base === undefined) {
    throw new Error(`Unable to resolve base_model: ${baseModelID}`, {
      cause: { modelPath, toml: authored },
    });
  }

  const merged = structuredClone(
    mergeDeep(
      base,
      Object.fromEntries(
        Object.entries(authored).filter(([, value]) => value !== undefined),
      ),
    ),
  ) as Record<string, unknown>;
  applyOmit(merged, authored.base_model_omit ?? []);

  const parsed = ExistingModelFields.safeParse(merged);
  if (!parsed.success) {
    parsed.error.cause = { modelPath, toml: merged };
    throw parsed.error;
  }
  return parsed.data as ExistingModel;
}


function applyOmit(target: Record<string, unknown>, paths: string[]) {
  omitLoop: for (const omit of paths) {
    const parts = omit.split(".");
    const parents: Array<{ value: Record<string, unknown>; key: string }> = [];
    let current = target;

    for (const part of parts.slice(0, -1)) {
      const next = current[part];
      if (
        next === undefined ||
        next === null ||
        typeof next !== "object" ||
        Array.isArray(next)
      ) {
        continue omitLoop;
      }
      parents.push({ value: current, key: part });
      current = next as Record<string, unknown>;
    }

    const lastPart = parts.at(-1);
    if (lastPart === undefined || !(lastPart in current)) continue;

    delete current[lastPart];

    for (let index = parents.length - 1; index >= 0; index--) {
      const parent = parents[index];
      if (parent === undefined) continue;
      const value = parent.value[parent.key];
      if (
        value === null ||
        value === undefined ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length > 0
      ) {
        break;
      }
      delete parent.value[parent.key];
    }
  }
}

