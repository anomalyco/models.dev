import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "models");
const WEIGHTS_URL = /^https:\/\/huggingface\.co\/([^/?#]+\/[^/?#]+)\/?$/;

// The lab file whose `[[weights]]` url is this Hugging Face repo. Repo names compare
// case-insensitively, as Hugging Face's do. When several lab files list the repo,
// the match is the one every other file's ID extends (`mimo-v2.6-pro` over
// `mimo-v2.6-pro-ultraspeed`, a tier of the same weights); otherwise the repo is
// ambiguous and nothing matches.
export function weightsMatch(repo: string, index: Map<string, string[]>) {
  const labs = index.get(repo.toLowerCase());
  if (labs === undefined) return undefined;
  return labs.find((lab) => labs.every((other) => other === lab || other.startsWith(`${lab}-`)));
}

let weightsCache: Map<string, string[]> | undefined;

// Hugging Face repos (lowercase `org/name`) to the lab models listing them as weights.
export function weightsIndex(dir = MODELS_DIR) {
  if (dir === MODELS_DIR && weightsCache !== undefined) return weightsCache;
  const index = new Map<string, string[]>();
  for (const lab of readdirSync(dir, { withFileTypes: true })) {
    if (!lab.isDirectory()) continue;
    for (const file of readdirSync(path.join(dir, lab.name))) {
      if (!file.endsWith(".toml")) continue;
      const parsed = Bun.TOML.parse(readFileSync(path.join(dir, lab.name, file), "utf8")) as { weights?: { url?: string }[] };
      for (const weights of parsed.weights ?? []) {
        const repo = WEIGHTS_URL.exec(weights.url ?? "")?.[1]?.toLowerCase();
        if (repo === undefined) continue;
        const model = `${lab.name}/${file.slice(0, -".toml".length)}`;
        index.set(repo, [...(index.get(repo) ?? []), model]);
      }
    }
  }
  if (dir === MODELS_DIR) weightsCache = index;
  return index;
}
