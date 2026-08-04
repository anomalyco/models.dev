import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { SyncProvider, SyncedModel } from "../index.js";

// Repo-level base-model metadata directory (mirrors openrouter.ts MODELS_DIR).
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Omnious is an OpenAI-compatible market rather than a fixed-price gateway: every
// request runs a scoring auction and the winner is paid a second-score price
// capped by a genuine rival, so the served price for a model class moves with the
// book. `GET /v1/models` is public (no key required) and reports the current best
// bid per class, which is the only volatile data we sync — capability, context and
// modality facts stay inherited from the base model.
// https://api.omnious.xyz/v1/models
// OMNIOUS_MODELS_URL overrides the endpoint (e.g. a local router) for testing.
const API_ENDPOINT = process.env.OMNIOUS_MODELS_URL ?? "https://api.omnious.xyz/v1/models";

export const OmniousModel = z
  .object({
    // Classes carry `model_class`; the catalog also lists routing aliases such as
    // `auto`, which have no class and are filtered out in parseModels.
    model_class: z.string(),
    // Best current bid per 1M tokens, in USDC base units (6 dp).
    best_in: z.number(),
    best_out: z.number(),
    // Who made the model, from the router's class catalog. Null for uncataloged
    // classes, which fall back to a unique-suffix lookup in deriveBaseModel.
    issuer: z.string().nullable().optional(),
  })
  .passthrough();

export const OmniousResponse = z.object({ data: z.array(z.unknown()) }).passthrough();

export type OmniousModel = z.infer<typeof OmniousModel>;

// Omnious issuer -> models.dev base-model author prefix. Issuers naming a lab
// models.dev doesn't carry yet (Arcee AI, Liquid AI, …) are absent on purpose:
// deriveBaseModel skips those classes rather than inventing an author for them.
const AUTHOR_BY_ISSUER: Record<string, string> = {
  OpenAI: "openai",
  Anthropic: "anthropic",
  Google: "google",
  Alibaba: "alibaba",
  "Mistral AI": "mistral",
  "Z.ai": "zhipuai",
  MiniMax: "minimax",
  DeepSeek: "deepseek",
  Kimi: "moonshotai",
  Perplexity: "perplexity",
  "Thinking Machines": "thinkingmachines",
  Meta: "meta",
  xAI: "xai",
  Xiaomi: "xiaomi",
  Tencent: "tencent",
  Microsoft: "microsoft",
  NVIDIA: "nvidia",
  Cohere: "cohere",
  Poolside: "poolside",
  StepFun: "stepfun",
};

/**
 * The base models an Omnious entry can inherit from, indexed once per run.
 *
 * Both maps are keyed lowercase and resolve back to the ID as authored, because
 * Omnious class names are lowercase while some base models are not (MiniMax
 * ships `minimax/MiniMax-M2`). Resolving through this index rather than probing
 * the filesystem also keeps the lookup honest on a case-insensitive volume,
 * where an `existsSync` for `minimax/minimax-m2.toml` answers yes and then fails
 * catalog generation on Linux.
 *
 * A base model is indexed only when it declares `limit.output`. Omnious publishes
 * price, not limits, so an entry here carries `[cost]` and inherits the rest —
 * which means a base without an output limit would merge into a model that fails
 * validation. Those classes are skipped rather than given an invented ceiling.
 *
 * `bySuffix` is the fallback for classes with no issuer: a class maps only when
 * exactly one author publishes that model ID, so an ambiguous short name is
 * skipped rather than attributed to whichever author sorted first.
 */
let catalogIndex: { byID: Map<string, string>; bySuffix: Map<string, string[]> } | undefined;

function catalog() {
  if (catalogIndex !== undefined) return catalogIndex;
  const byID = new Map<string, string>();
  const bySuffix = new Map<string, string[]>();
  for (const author of readdirSync(MODELS_DIR, { withFileTypes: true })) {
    if (!author.isDirectory()) continue;
    for (const file of readdirSync(path.join(MODELS_DIR, author.name))) {
      if (!file.endsWith(".toml")) continue;
      const short = file.slice(0, -".toml".length);
      const id = `${author.name}/${short}`;
      const base = Bun.TOML.parse(
        readFileSync(path.join(MODELS_DIR, author.name, file), "utf8"),
      ) as { limit?: { output?: unknown } };
      if (typeof base.limit?.output !== "number") continue;
      byID.set(id.toLowerCase(), id);
      const key = short.toLowerCase();
      bySuffix.set(key, [...(bySuffix.get(key) ?? []), id]);
    }
  }
  catalogIndex = { byID, bySuffix };
  return catalogIndex;
}

function deriveBaseModel(model: OmniousModel): string | undefined {
  const { byID, bySuffix } = catalog();
  const issuer = model.issuer ?? undefined;
  const author = issuer === undefined ? undefined : AUTHOR_BY_ISSUER[issuer];
  // A known issuer is authoritative: if models.dev doesn't carry that author's
  // copy of the class, the class is skipped rather than matched to another lab.
  if (author !== undefined) {
    return byID.get(`${author}/${model.model_class}`.toLowerCase());
  }
  const candidates = bySuffix.get(model.model_class.toLowerCase());
  return candidates?.length === 1 ? candidates[0] : undefined;
}

/** USDC base units (6 dp) per 1M tokens -> USD per 1M tokens. */
function price(units: number): number | undefined {
  if (!Number.isFinite(units) || units <= 0) return undefined;
  return Math.round(units) / 1_000_000;
}

export const omnious = {
  id: "omnious",
  name: "Omnious",
  modelsDir: "providers/omnious/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Omnious request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // The catalog mixes model classes with routing aliases (`auto`), which carry
    // no class or price. Parse per entry so one malformed row can't drop the run.
    return OmniousResponse.parse(raw)
      .data.map((entry) => OmniousModel.safeParse(entry))
      .filter((result) => result.success)
      .map((result) => result.data);
  },
  sourceID(model) {
    return model.model_class;
  },
  translateModel(model) {
    const input = price(model.best_in);
    const output = price(model.best_out);
    // A class with no live bid on one side has no served price to publish.
    if (input === undefined || output === undefined) return undefined;

    // Skip classes we can't attribute, and classes whose base metadata models.dev
    // doesn't carry yet — those need their author metadata added under models/
    // first, exactly as for the other aggregators.
    const baseModel = deriveBaseModel(model);
    if (baseModel === undefined) return undefined;

    // Only the auction price is provider-specific. Context, modalities and
    // capability flags are provider-agnostic facts and stay inherited from the
    // base model, so this entry never contradicts it.
    const synced: SyncedModel = { base_model: baseModel, cost: { input, output } };
    return { id: model.model_class, model: synced };
  },
} satisfies SyncProvider<OmniousModel>;
