import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, syncProviderMatrix, type SyncProvider } from "../src/sync/index.js";
import {
  buildHostlinkuCost,
  fetchHostlinkuModels,
  hostlinku,
  type HostlinkuModel,
} from "../src/sync/providers/hostlinku.js";

function makeModel(overrides: Partial<HostlinkuModel> = {}): HostlinkuModel {
  return {
    modelId: "claude-haiku-5-5",
    slug: "claude-haiku-5-5",
    defaultMode: "performance",
    modes: {
      performance: {
        mode: "performance",
        prices: {
          input: 0.0553,
          output: 0.2765,
          cacheRead: 0.00553,
          cacheWrite5m: 0.069125,
          cacheWrite1h: 0.1106,
          webSearchPer1k: 15.8,
        },
        tiers: [
          {
            minTokens: 100_000,
            input: 0.632,
            output: 3.16,
            cacheRead: 0.0632,
            cacheWrite5m: 0.79,
            cacheWrite1h: 1.264,
          },
        ],
      },
      economy: {
        mode: "economy",
        prices: {
          input: 0.01875,
          output: 0.09375,
          cacheRead: 0.001875,
          cacheWrite5m: 0.023438,
          cacheWrite1h: 0.0375,
          webSearchPer1k: 12.5,
        },
        tiers: [
          {
            minTokens: 100_000,
            input: 0.09375,
            output: 0.46875,
            cacheRead: 0.009375,
            cacheWrite5m: 0.117188,
            cacheWrite1h: 0.1875,
          },
        ],
      },
      dedicated: null,
    },
    ...overrides,
  };
}

function fillerModels(count: number, prefix = "filler-"): HostlinkuModel[] {
  return Array.from({ length: count }, (_, index) => makeModel({
    modelId: `${prefix}${index}`,
    slug: `${prefix}${index}`,
  }));
}

test("Hostlinku is registered for scheduled sync and fetches its public catalog without auth", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === hostlinku.id)).toBe(true);

  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({
      status: "success",
      data: { currency: "USD", unit: "per_1m_tokens", items: fillerModels(10) },
    });
  }) as unknown as typeof fetch;

  await fetchHostlinkuModels(fetcher);
  expect(request!.url).toBe("https://api.hostlinku.com/api/public/pricing");
  expect(request!.headers.get("authorization")).toBeNull();

  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  await expect(fetchHostlinkuModels(unavailable)).rejects.toThrow("503");
});

test("parseModels rejects truncated catalogs below minimum expected model count", () => {
  expect(() =>
    hostlinku.parseModels({
      status: "success",
      data: { currency: "USD", unit: "per_1m_tokens", items: [makeModel()] },
    }),
  ).toThrow("too few models");
});

test("buildHostlinkuCost updates multi-mode tiers and preserves cache-write policy", () => {
  const explicitCost = buildHostlinkuCost(makeModel(), {
    cost: {
      text: {
        input: {
          price: 0.0553,
          cache: { read: 0.00553, write: { "5m": 0.069125, "1h": 0.1106 } },
        },
        output: { price: 0.2765 },
      },
      web_search: { price: 15.8 },
    },
  });

  expect(explicitCost).toEqual({
    text: {
      input: {
        price: 0.0553,
        cache: { read: 0.00553, write: { "5m": 0.069125, "1h": 0.1106 } },
        overrides: [
          {
            when: { context: { gte: 100_000 } },
            price: 0.632,
            cache: { read: 0.0632, write: { "5m": 0.79, "1h": 1.264 } },
          },
          {
            when: { mode: { equals: "economy" } },
            price: 0.01875,
            cache: { read: 0.001875, write: { "5m": 0.023438, "1h": 0.0375 } },
          },
          {
            when: { context: { gte: 100_000 }, mode: { equals: "economy" } },
            price: 0.09375,
            cache: { read: 0.009375, write: { "5m": 0.117188, "1h": 0.1875 } },
          },
        ],
      },
      output: {
        price: 0.2765,
        overrides: [
          { when: { context: { gte: 100_000 } }, price: 3.16 },
          { when: { mode: { equals: "economy" } }, price: 0.09375 },
          { when: { context: { gte: 100_000 }, mode: { equals: "economy" } }, price: 0.46875 },
        ],
      },
    },
    web_search: {
      price: 15.8,
      overrides: [{ when: { mode: { equals: "economy" } }, price: 12.5 }],
    },
  });

  const gptModel = makeModel({
    modelId: "gpt-5-5",
    slug: "gpt-5-5",
    modes: {
      performance: {
        mode: "performance",
        prices: {
          input: 1.817,
          output: 10.902,
          cacheRead: 0.1817,
          cacheWrite5m: 2.27125,
          cacheWrite1h: 3.634,
          webSearchPer1k: 15.8,
        },
        tiers: [{ minTokens: 272_000, input: 12.64, output: 56.88, cacheRead: 1.264 }],
      },
      economy: {
        mode: "economy",
        prices: { input: 0.3125, output: 1.875, cacheRead: 0.03125, webSearchPer1k: 12.5 },
        tiers: [{ minTokens: 272_000, input: 0.625, output: 2.8125, cacheRead: 0.0625 }],
      },
      dedicated: null,
    },
  });

  const implicitOnlyCost = buildHostlinkuCost(gptModel, {
    cost: {
      text: {
        input: { price: 1.817, cache: { read: 0.1817 } },
        output: { price: 10.902 },
      },
      web_search: { price: 15.8 },
    },
  });

  expect(implicitOnlyCost?.text.input.cache).toEqual({ read: 0.1817 });
  expect(implicitOnlyCost?.text.input.overrides?.[1]?.cache).toEqual({ read: 0.03125 });
  expect(buildHostlinkuCost(makeModel({ modes: { performance: null, economy: null, dedicated: null } }), {})).toBeUndefined();

  const preservedNonOwned = buildHostlinkuCost(makeModel(), {
    cost: {
      multipliers: [{ when: { region: { equals: "eu" } }, multiplier: 1.1 }],
      audio: { input: { price: 10 }, output: { price: 20 } },
      text: {
        input: {
          price: 0.0553,
          cache: { read: 0.00553, write: { "5m": 0.069125, "1h": 0.1106, "24h": 0.2 } },
          overrides: [
            { when: { context: { gte: 100_000 } }, price: 0.5 },
            { when: { service_tier: { equals: "flex" } }, price: 0.02 },
          ],
        },
        output: {
          price: 0.2765,
          reasoning: 0.5,
          overrides: [
            { when: { mode: { equals: "economy" } }, price: 0.08 },
            { when: { service_tier: { equals: "flex" } }, price: 0.1 },
          ],
        },
      },
      web_search: {
        price: 15.8,
        overrides: [{ when: { service_tier: { equals: "flex" } }, price: 8 }],
      },
    },
  });

  expect(preservedNonOwned?.multipliers).toEqual([{ when: { region: { equals: "eu" } }, multiplier: 1.1 }]);
  expect(preservedNonOwned?.audio).toEqual({ input: { price: 10 }, output: { price: 20 } });
  expect(preservedNonOwned?.text.output.reasoning).toBe(0.5);
  expect(preservedNonOwned?.text.input.cache).toEqual({
    read: 0.00553,
    write: { "24h": 0.2, "5m": 0.069125, "1h": 0.1106 },
  });
  expect(preservedNonOwned?.text.input.overrides?.at(-1)).toEqual({
    when: { service_tier: { equals: "flex" } },
    price: 0.02,
  });
  expect(preservedNonOwned?.text.output.overrides?.at(-1)).toEqual({
    when: { service_tier: { equals: "flex" } },
    price: 0.1,
  });
  expect(preservedNonOwned?.web_search?.overrides?.at(-1)).toEqual({
    when: { service_tier: { equals: "flex" } },
    price: 8,
  });
});

test("listed models with no priceable mode are retained with a notice while delisted models are removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hostlinku-sync-"));
  try {
    const modelsDir = path.join(root, "providers", "hostlinku", "models");
    await mkdir(modelsDir, { recursive: true });
    await mkdir(path.join(root, "models", "anthropic"), { recursive: true });
    await mkdir(path.join(root, "models", "xai"), { recursive: true });

    await copyFile(
      path.join(import.meta.dirname, "../../../models/anthropic/claude-haiku-5-5.toml"),
      path.join(root, "models/anthropic/claude-haiku-5-5.toml"),
    );
    await copyFile(
      path.join(import.meta.dirname, "../../../models/xai/grok-4.5.toml"),
      path.join(root, "models/xai/grok-4.5.toml"),
    );
    await copyFile(
      path.join(import.meta.dirname, "../../../providers/hostlinku/provider.toml"),
      path.join(root, "providers/hostlinku/provider.toml"),
    );

    const retainedToml = [
      "# Header preserved",
      "schema = 2",
      'base_model = "anthropic/claude-haiku-5-5"',
      "",
      "[capabilities]",
      "reasoning = { supported = true }",
      "",
      "[cost.text.input]",
      "price = 0.0553",
      "",
      "[cost.text.output]",
      "price = 0.2765",
      "",
    ].join("\n");

    const retiredToml = [
      "schema = 2",
      'base_model = "xai/grok-4.5"',
      "",
      "[cost.text.input]",
      "price = 1",
      "",
      "[cost.text.output]",
      "price = 3",
      "",
    ].join("\n");

    await writeFile(path.join(modelsDir, "claude-haiku-5-5.toml"), retainedToml);
    await writeFile(path.join(modelsDir, "retired-model.toml"), retiredToml);

    const provider: SyncProvider<HostlinkuModel> = {
      ...hostlinku,
      modelsDir,
      async fetchModels() {
        return {
          status: "success",
          data: {
            currency: "USD",
            unit: "per_1m_tokens",
            items: [
              makeModel({ modes: { performance: null, economy: null, dedicated: null } }),
              ...fillerModels(10),
            ],
          },
        };
      },
    };

    const result = await syncProvider(provider);
    expect(result.deleted).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(result.notices).toContain("Retained claude-haiku-5-5: public catalog row has no priceable mode.");
    expect(existsSync(path.join(modelsDir, "retired-model.toml"))).toBe(false);
    expect(await readFile(path.join(modelsDir, "claude-haiku-5-5.toml"), "utf8")).toBe(retainedToml);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
