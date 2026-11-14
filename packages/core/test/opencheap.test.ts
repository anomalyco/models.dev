import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { groups, providers, syncProvider } from "../src/sync/index.js";
import {
  buildOpenCheapModel,
  fetchOpenCheapModels,
  opencheap,
  type OpenCheapModel,
} from "../src/sync/providers/opencheap.js";

const REPO = path.join(import.meta.dirname, "..", "..", "..");
const SHIPPED_DIR = path.join(REPO, "providers", "opencheap", "models");

function row(overrides: Partial<OpenCheapModel> = {}): OpenCheapModel {
  return {
    id: "gpt-4o",
    contextLength: 128_000,
    ours: { promptUsd: 0.5, completionUsd: 2, cacheReadUsd: 0.25, longContext: [] },
    ...overrides,
  };
}

test("is registered with the aggregators", () => {
  expect(providers.opencheap).toBe(opencheap);
  expect(groups.aggregators).toContain("opencheap");
});

test("reprices input, output and an authored cache read", () => {
  const built = buildOpenCheapModel(
    row(),
    { base_model: "openai/gpt-4o", cost: { input: 9, output: 9, cache_read: 9 } },
    { limit: { context: 128_000, output: 16_384 } },
  );
  expect(built.model).toEqual({ base_model: "openai/gpt-4o", cost: { input: 0.5, output: 2, cache_read: 0.25 } });
  expect(built.notices).toBeUndefined();
});

test("adds no cache read where the file lists none", () => {
  // The list prices a cache read on routes that report no cached tokens.
  const built = buildOpenCheapModel(
    row({ id: "llama-3.3-70b", ours: { promptUsd: 0.023, completionUsd: 0.073, cacheReadUsd: 0.0035 } }),
    { base_model: "meta/llama-3.3-70b-instruct", cost: { input: 9, output: 9 } },
    undefined,
  );
  expect(built.model.cost).toEqual({ input: 0.023, output: 0.073 });
});

test("keeps the authored prices when the list has no positive price", () => {
  const authored = { base_model: "openai/gpt-4o", cost: { input: 0.56, output: 2.3, cache_read: 0.28 } };
  for (const ours of [null, { promptUsd: 0, completionUsd: 0 }, { promptUsd: 0.5, completionUsd: null }]) {
    const built = buildOpenCheapModel(row({ ours }), authored, undefined);
    expect(built.model.cost).toEqual(authored.cost);
    expect(built.notices?.[0]).toContain("no positive price");
  }
});

test("syncs the window only where the file overrides it", () => {
  const overridden = buildOpenCheapModel(
    row({ id: "llama-4-scout", contextLength: 328_000 }),
    { base_model: "meta/llama-4-scout-17b-instruct", limit: { context: 1_310_720 } as never },
    { limit: { context: 1_310_720, output: 16_384 } },
  );
  expect(overridden.model.limit).toEqual({ context: 328_000 } as never);

  const inherited = buildOpenCheapModel(
    row({ contextLength: 64_000 }),
    { base_model: "openai/gpt-4o" },
    { limit: { context: 128_000, output: 16_384 } },
  );
  expect(inherited.model.limit).toBeUndefined();
  expect(inherited.notices?.join("\n")).toContain("serves a 64000-token window but inherits 128000");

  // A list window at or above the lab's is a rounding difference, not a cap.
  const larger = buildOpenCheapModel(row({ contextLength: 131_072 }), { base_model: "openai/gpt-4o" }, { limit: { context: 128_000, output: 16_384 } });
  expect(larger.notices).toBeUndefined();
});

test("reports long-context prices it does not author", () => {
  const built = buildOpenCheapModel(
    row({ ours: { promptUsd: 0.1, completionUsd: 0.5, longContext: [{ aboveTokens: 100_000 }] } }),
    { base_model: "openai/gpt-4o" },
    undefined,
  );
  expect(built.notices?.join("\n")).toContain("above 100000 tokens");
});

test("parses the public list and drops nameless rows", () => {
  const models = opencheap.parseModels({ version: 1, models: [row(), row({ id: " " })] });
  expect(models.map((model) => model.id)).toEqual(["gpt-4o"]);
  expect(() => opencheap.parseModels({ data: [] })).toThrow();
});

test("a failed list request fails the run", async () => {
  const fetcher = (async () => new Response("down", { status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch;
  await expect(fetchOpenCheapModels(fetcher)).rejects.toThrow("503");
});

test("restores stale shipped files and leaves the rest alone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-opencheap-"));
  const modelsDir = path.join(root, "providers", "opencheap", "models");
  const ids = ["gpt-4o", "kimi-k3", "llama-3.3-70b", "llama-4-scout"];
  try {
    await mkdir(modelsDir, { recursive: true });
    await copyFile(path.join(SHIPPED_DIR, "..", "provider.toml"), path.join(root, "providers", "opencheap", "provider.toml"));
    const shipped: Record<string, string> = {};
    const source: OpenCheapModel[] = [];
    for (const id of ids) {
      const text = await readFile(path.join(SHIPPED_DIR, `${id}.toml`), "utf8");
      shipped[id] = text;
      const parsed = Bun.TOML.parse(text) as {
        base_model: string;
        limit?: { context?: number };
        cost: { text: { input: { price: number; cache?: { read?: number } }; output: { price: number } } };
      };
      const lab = path.join(root, "models", `${parsed.base_model}.toml`);
      await mkdir(path.dirname(lab), { recursive: true });
      await copyFile(path.join(REPO, "models", `${parsed.base_model}.toml`), lab);
      const labContext = (Bun.TOML.parse(await readFile(lab, "utf8")) as { limit: { context: number } }).limit.context;
      source.push(row({
        id,
        contextLength: parsed.limit?.context ?? labContext,
        ours: {
          promptUsd: parsed.cost.text.input.price,
          completionUsd: parsed.cost.text.output.price,
          // The list always carries a cache price, even where the file has none.
          cacheReadUsd: parsed.cost.text.input.cache?.read ?? parsed.cost.text.input.price / 10,
          longContext: [],
        },
      }));
      const stale = text
        .replace(/(\[cost\.text\.input\]\nprice = )[\d.]+/, "$19")
        .replace(/^context = [\d_]+$/m, "context = 999_000");
      expect(stale).not.toBe(text);
      await writeFile(path.join(modelsDir, `${id}.toml`), stale);
    }
    // A model the catalog leaves out on purpose is neither created nor reported as an issue.
    source.push(row({ id: "some-closed-model" }));

    const provider = { ...opencheap, modelsDir, fetchModels: async () => ({ models: source }) };
    const result = await syncProvider(provider, { openIssues: false });
    expect(result).toMatchObject({ created: 0, updated: ids.length, deleted: 0 });
    for (const id of ids) {
      expect(await readFile(path.join(modelsDir, `${id}.toml`), "utf8")).toBe(shipped[id]!);
    }

    const again = await syncProvider(provider, { dryRun: true, openIssues: false });
    expect(again).toMatchObject({ created: 0, updated: 0, deleted: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
