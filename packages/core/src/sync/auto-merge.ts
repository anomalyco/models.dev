import { readFile } from "node:fs/promises";

export const MAX_CREATED_MODELS = 10;
export const MAX_DELETED_MODELS = 10;
export const MAX_MODEL_CHURN = 15;

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

  for (const change of models) {
    if (change.status === "deleted" || !isProviderModel(change.path)) continue;

    const model = Bun.TOML.parse(await load(change.path)) as Record<string, unknown>;
    let reasoning = model.reasoning;
    if (reasoning === undefined && typeof model.base_model === "string") {
      const base = Bun.TOML.parse(await load(`models/${model.base_model}.toml`)) as Record<string, unknown>;
      reasoning = base.reasoning;
    }

    if (reasoning === true && !Object.hasOwn(model, "reasoning_options")) {
      reasons.push(`${change.path} is a reasoning model without explicit reasoning_options`);
    }
  }

  return { safe: reasons.length === 0, created, updated, deleted, reasons };
}

export function parseNameStatus(output: string): CatalogChange[] {
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const [code, ...paths] = line.split("\t");
    const path = paths.at(-1);
    if (!code || !path) throw new Error(`Invalid git diff entry: ${line}`);
    return {
      status: code.startsWith("A") ? "created" : code.startsWith("D") ? "deleted" : "updated",
      path,
    };
  });
}
