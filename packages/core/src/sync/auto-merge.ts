import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

export const MAX_CREATED_MODELS = 10;
export const MAX_DELETED_MODELS = 10;
export const MAX_MODEL_CHURN = 15;
const REVIEWED_REASONING_PROVIDERS = new Set([
  "crossmodel",
  "edenai",
  "empiriolabs",
  "hyper",
  "kilo",
  "llmgateway",
  "merge-gateway",
  "nano-gpt",
  "openrouter",
  "venice",
]);

export interface CatalogChange {
  status: "created" | "updated" | "deleted";
  path: string;
}

export interface AutoMergeDecision {
  safe: boolean;
  created: number;
  updated: number;
  deleted: number;
  reasons: string[];
}

function isModel(path: string) {
  return path.endsWith(".toml") && (path.startsWith("models/") || path.includes("/models/"));
}

function isProviderModel(path: string) {
  return path.endsWith(".toml") && path.startsWith("providers/") && path.includes("/models/");
}

export async function classifyAutoMerge(
  changes: CatalogChange[],
  load = (path: string) => readFile(path, "utf8"),
  loadPrevious = load,
): Promise<AutoMergeDecision> {
  const models = changes.filter((change) => isModel(change.path));
  const created = models.filter((change) => change.status === "created").length;
  const updated = models.filter((change) => change.status === "updated").length;
  const deleted = models.filter((change) => change.status === "deleted").length;
  const reasons: string[] = [];

  if (created > MAX_CREATED_MODELS) reasons.push(`${created} models created (limit ${MAX_CREATED_MODELS})`);
  if (deleted > MAX_DELETED_MODELS) reasons.push(`${deleted} models deleted (limit ${MAX_DELETED_MODELS})`);
  if (created + deleted > MAX_MODEL_CHURN) {
    reasons.push(`${created + deleted} models created or deleted (limit ${MAX_MODEL_CHURN})`);
  }

  const reasoningMetadata = async (path: string, loader: typeof load) => {
    const model = Bun.TOML.parse(await loader(path)) as Record<string, unknown>;
    let reasoning = model.reasoning;
    if (reasoning === undefined && typeof model.base_model === "string") {
      const base = Bun.TOML.parse(await loader(`models/${model.base_model}.toml`)) as Record<string, unknown>;
      reasoning = base.reasoning;
    }

    return {
      reasoning,
      reasoning_options: model.reasoning_options,
      interleaved: model.interleaved,
      base_model: model.base_model,
    };
  };

  for (const change of models) {
    if (change.status === "deleted" || !isProviderModel(change.path)) continue;

    const current = await reasoningMetadata(change.path, load);
    const previous = change.status === "created" ? undefined : await reasoningMetadata(change.path, loadPrevious);
    const reasoningChanged = !current || !previous || !isDeepStrictEqual(current, previous);
    if (!reasoningChanged) continue;

    const reasoning = current?.reasoning === true || previous?.reasoning === true;

    if (reasoning) {
      if (current?.reasoning === true && current.reasoning_options === undefined) {
        reasons.push(`${change.path} is a reasoning model without explicit reasoning_options`);
      } else if (!REVIEWED_REASONING_PROVIDERS.has(change.path.split("/")[1]!)) {
        reasons.push(`${change.path} is a reasoning model that requires manual review`);
      }
    }
  }

  return { safe: reasons.length === 0, created, updated, deleted, reasons };
}

export function parseNameStatus(output: string): CatalogChange[] {
  return output.trim().split("\n").filter(Boolean).flatMap((line) => {
    const [code, ...paths] = line.split("\t");
    const path = paths.at(-1);
    if (!code || !path) throw new Error(`Invalid git diff entry: ${line}`);
    if (code.startsWith("R")) {
      if (paths.length !== 2) throw new Error(`Invalid git rename entry: ${line}`);
      return [
        { status: "deleted", path: paths[0]! },
        { status: "created", path: paths[1]! },
      ];
    }
    return {
      status: code.startsWith("A") ? "created" : code.startsWith("D") ? "deleted" : "updated",
      path,
    };
  });
}
