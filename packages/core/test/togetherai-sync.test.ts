import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { providers, syncProvider, syncProviderMatrix, type ExistingModel } from "../src/sync/index.js";
import { buildTogetherModel, fetchTogetherModels, togetherai } from "../src/sync/providers/togetherai.js";

const serverless = {
  products: ["PRODUCT_SERVERLESS"],
  serverlessEndpoint: "moonshotai/Kimi-K3",
  pricing: { input: 3, output: 15, cachedInput: 0.3 },
};

test("fetches all Together serverless pages with bearer auth", async () => {
  const requests: Request[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    requests.push(request);
    return Response.json(requests.length === 1
      ? { object: "list", data: [serverless], next_cursor: "next-page" }
      : { object: "list", data: [{ ...serverless, serverlessEndpoint: "openai/gpt-oss-120b" }] });
  }) as typeof fetch;

  const models = await fetchTogetherModels("test-key", fetcher);
  expect(models).toHaveLength(2);
  expect(requests.map((request) => new URL(request.url).searchParams.get("product")))
    .toEqual(["PRODUCT_SERVERLESS", "PRODUCT_SERVERLESS"]);
  expect(new URL(requests[1]!.url).searchParams.get("after")).toBe("next-page");
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-key");
});

test("fails closed on an empty response or repeated cursor", async () => {
  await expect(fetchTogetherModels("key", (async () => Response.json({ object: "list", data: [] })) as unknown as typeof fetch))
    .rejects.toThrow("empty model catalog");
  await expect(fetchTogetherModels("key", (async () => Response.json({
    object: "list", data: [serverless], next_cursor: "same",
  })) as unknown as typeof fetch)).rejects.toThrow("repeated a cursor");
  await expect(fetchTogetherModels("key", (async () => new Response(null, { status: 401 })) as unknown as typeof fetch))
    .rejects.toThrow("Together models request failed: 401");
});

test("rejects duplicate serverless IDs rather than choosing an arbitrary price", () => {
  expect(() => togetherai.parseModels([serverless, { ...serverless }]))
    .toThrow("duplicate serverless endpoint ID");
});

test("requires explicit serverless product and endpoint; does not treat missing rows as deletions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "togetherai-sync-"));
  const modelsDir = path.join(dir, "providers/togetherai/models");
  await mkdir(modelsDir, { recursive: true });
  await Bun.write(path.join(modelsDir, "retired.toml"), `name = "Retired"
description = "Previously offered Together route"
release_date = "2026-01-01"
last_updated = "2026-01-01"
attachment = false
reasoning = false
tool_call = false
open_weights = true
[cost]
input = 1
output = 2
[limit]
context = 8192
output = 4096
[modalities]
input = ["text"]
output = ["text"]
`);
  const provider = {
    ...togetherai,
    modelsDir,
    async fetchModels() {
      return [serverless, {
        ...serverless,
        products: ["PRODUCT_DEDICATED"],
        serverlessEndpoint: "retired",
      }];
    },
  };
  try {
    const result = await syncProvider(provider, { dryRun: true });
    expect(result.created).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.notices.join(" ")).toContain("retired.toml");
    expect(result.notices.join(" ")).toContain("moonshotai/Kimi-K3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncs only serverless token prices, retaining unreported fields and curated model facts", () => {
  const authored: ExistingModel = {
    base_model: "moonshotai/kimi-k3",
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
    limit: { context: 262144, output: 131072 },
  };
  const model = buildTogetherModel(serverless, authored);
  expect(model).toMatchObject({
    base_model: authored.base_model,
    reasoning_options: authored.reasoning_options,
    limit: authored.limit,
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 2.5 },
  });
  const withoutCachedInput = buildTogetherModel({ ...serverless, pricing: { input: 0, output: 4 } }, authored);
  expect(withoutCachedInput.cost).toEqual({ input: 0, output: 4, cache_read: 0.2, cache_write: 2.5 });
});

test("Together is an explicit CLI target but not scheduled without a configured key", () => {
  expect(providers.togetherai).toBe(togetherai);
  expect(syncProviderMatrix().include.some((entry) => entry.provider === "togetherai")).toBe(false);
});
