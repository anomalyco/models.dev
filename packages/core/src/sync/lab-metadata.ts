import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Read-only lookups in the lab files (`models/`) for provider modules that
// match a host's rows to labs or copy a lab's exact formats.

const ROOT = path.join(import.meta.dirname, "..", "..", "..", "..");
export const REPO_LABS_DIR = path.join(ROOT, "models");

/** The lab directory beside a provider's models dir (`providers/<id>/models`). */
export function labsDir(modelsDir: string) {
  return path.join(path.resolve(ROOT, modelsDir), "..", "..", "..", "models");
}

/** A lab file's TOML, or undefined when there is none. */
export function readLabModel(modelID: string, dir = REPO_LABS_DIR): Record<string, unknown> | undefined {
  try {
    return Bun.TOML.parse(readFileSync(path.join(dir, `${modelID}.toml`), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The lab file's v2 input list (MIME types), or undefined when it has none. */
export function labInputModalities(modelID: string, dir = REPO_LABS_DIR): string[] | undefined {
  const input = (readLabModel(modelID, dir)?.modalities as { input?: unknown } | undefined)?.input;
  return Array.isArray(input) && input.every((item) => typeof item === "string") ? input : undefined;
}

/** The modality kind of a MIME type (`image/png` is `image`, `application/pdf` is `pdf`). */
export function kindOf(item: string) {
  return item === "application/pdf" ? "pdf" : item.split("/")[0]!;
}

const weightsIndexes = new Map<string, Map<string, string[]>>();

/** Lab model IDs keyed by each lowercased Hugging Face repo their `[[weights]]` list. */
export function labWeightsIndex(dir = REPO_LABS_DIR) {
  const cached = weightsIndexes.get(dir);
  if (cached !== undefined) return cached;
  const index = new Map<string, string[]>();
  for (const lab of readdirSync(dir, { withFileTypes: true })) {
    if (!lab.isDirectory()) continue;
    for (const file of readdirSync(path.join(dir, lab.name), { recursive: true }) as string[]) {
      if (!file.endsWith(".toml")) continue;
      const id = `${lab.name}/${file.slice(0, -5).split(path.sep).join("/")}`;
      const weights = (readLabModel(id, dir)?.weights ?? []) as Array<{ url?: unknown }>;
      for (const { url } of weights) {
        const repo = typeof url === "string" ? /^https:\/\/huggingface\.co\/([^/]+\/[^/?#]+)/.exec(url)?.[1] : undefined;
        if (repo === undefined) continue;
        const key = repo.toLowerCase();
        index.set(key, [...(index.get(key) ?? []), id]);
      }
    }
  }
  weightsIndexes.set(dir, index);
  return index;
}
