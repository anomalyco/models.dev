import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import {
  buildLowRouterModel,
  fetchLowRouterModels,
  header,
  type LowRouterEntry,
  type LowRouterModel,
  lowrouter,
  lowRouterModels,
  RENAMED,
} from "../src/sync/providers/lowrouter.js";

function usd(prompt: number, completion: number, extra: Record<string, number> = {}) {
  return { currency: "USD", prompt_per_1m_tokens: prompt, completion_per_1m_tokens: completion, ...extra };
}

/** Enough unscoped auto IDs to pass the truncation guard. */
function filler(count = 100): LowRouterEntry[] {
  return Array.from({ length: count }, (_, index) => ({ id: `auto/lab/model-${index}` }));
}

const FX = { rate: 1.0989, as_of: "2026-11-17", fixing: "drift" };

function model(overrides: Partial<LowRouterModel> = {}): LowRouterModel {
  return {
    id: "auto/openai/gpt-oss-120b",
    lifecycle: "active",
    route: {
      id: "evroc/openai/gpt-oss-120b/se-sto",
      provider: "evroc",
      locode: "se-sto",
      pricing: usd(0.2198, 0.8791),
      fx: FX,
    },
    ...overrides,
  };
}

/** A file's own fields, as context.authored returns them. */
function authored(overrides: Partial<ExistingModel> = {}): ExistingModel {
  return {
    base_model: "openai/gpt-oss-120b",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    structured_output: true,
    cost: { input: 0.1695, output: 0.6779 },
    ...overrides,
  } as ExistingModel;
}

const HAND_HEADER = [
  "# Source: https://api.lowrouter.ai/v1/models?currency=usd (read 2026-10-12): this ID has 21 routes.",
  "# Cost is the route a plain request resolved to on 2026-10-12: Scaleway, fr-par endpoint.",
  "# Effort: reasoning_effort = low|medium|high, forwarded unchanged to the host.",
  "# Live check 2026-10-12 on this route: accepted low, medium, high.",
].join("\n") + "\n";

function context(files: Record<string, ExistingModel>, headers: Record<string, string> = {}) {
  return {
    existing: (id: string) => files[id],
    authored: (id: string) => files[id],
    header: (id: string) => headers[id],
  };
}

test("pairs each unscoped auto ID with its default route's quote and fx", () => {
  const models = lowRouterModels([
    {
      id: "auto/openai/gpt-oss-120b",
      lifecycle: "active",
      auto_routing: { default_routes: ["evroc/openai/gpt-oss-120b/se-sto"] },
    },
    { id: "auto/openai/gpt-oss-120b/se-sto" },
    {
      id: "evroc/openai/gpt-oss-120b",
      fx: [FX],
      regions: [
        { locode: "nl-ams", pricing: usd(1, 1) },
        { locode: "se-sto", pricing: usd(0.2198, 0.8791) },
      ],
    },
    {
      id: "auto/openai/gpt-5",
      lifecycle: "deprecated",
      auto_routing: { default_routes: ["openai/openai/gpt-5"] },
    },
    { id: "openai/openai/gpt-5", fx: [], regions: [{ locode: "global", pricing: usd(1.25, 10, { cache_read_per_1m_tokens: 0.125 }) }] },
    ...filler(),
  ]);
  expect(models.find((entry) => entry.id === "auto/openai/gpt-oss-120b")).toEqual(model());
  expect(models.find((entry) => entry.id === "auto/openai/gpt-5")).toEqual({
    id: "auto/openai/gpt-5",
    lifecycle: "deprecated",
    route: {
      id: "openai/openai/gpt-5",
      provider: "openai",
      locode: "global",
      pricing: usd(1.25, 10, { cache_read_per_1m_tokens: 0.125 }),
      fx: undefined,
    },
  });
  expect(models.some((entry) => entry.id === "auto/openai/gpt-oss-120b/se-sto")).toBe(false);
});

test("refuses a response too short to tell retirements from truncation", () => {
  expect(() => lowRouterModels(filler(99))).toThrow("below the 100");
});

test("takes the default route's prices and keeps every authored field", () => {
  const built = buildLowRouterModel(model(), authored({ limit: { output: 64_000 } as ExistingModel["limit"] }), HAND_HEADER);
  expect(built.model).toEqual({
    base_model: "openai/gpt-oss-120b",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    structured_output: true,
    limit: { output: 64_000 },
    cost: { input: 0.2198, output: 0.8791, cache_read: undefined, cache_write: undefined },
    status: undefined,
  });
});

test("takes cache prices only from the default route", () => {
  const withCache = model({
    route: { ...model().route!, pricing: usd(1, 2, { cache_read_per_1m_tokens: 0.1, cache_write_per_1m_tokens: 1.25 }) },
  });
  expect(buildLowRouterModel(withCache, authored(), undefined).model.cost)
    .toMatchObject({ input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 });
  const withoutCache = buildLowRouterModel(model(), authored({ cost: { input: 1, output: 2, cache_read: 0.1 } }), undefined);
  expect(withoutCache.model.cost?.cache_read).toBeUndefined();
});

test("marks a deprecated ID deprecated and otherwise keeps the authored status", () => {
  expect(buildLowRouterModel(model({ lifecycle: "deprecated" }), authored(), undefined).model.status).toBe("deprecated");
  expect(buildLowRouterModel(model(), authored({ status: "beta" }), undefined).model.status).toBe("beta");
});

test("fails on an unpriced or non-USD default route", () => {
  expect(() => buildLowRouterModel(model({ route: undefined }), authored(), undefined)).toThrow("no priced default route");
  const eur = model({ route: { ...model().route!, pricing: { ...usd(1, 1), currency: "EUR" } } });
  expect(() => buildLowRouterModel(eur, authored(), undefined)).toThrow("expected USD");
});

test("leaves a hand-written header alone while its price still matches", () => {
  const same = authored({ cost: { input: 0.2198, output: 0.8791 } });
  expect(buildLowRouterModel(model(), same, HAND_HEADER).header).toBe(HAND_HEADER);
});

test("rewrites the cost lines of a header when the price changes, keeping the evidence", () => {
  const written = buildLowRouterModel(model(), authored(), HAND_HEADER).header;
  expect(written).toBe([
    "# Source: https://api.lowrouter.ai/v1/models?currency=usd (synced).",
    "# Cost: the default route evroc/openai/gpt-oss-120b/se-sto (auto_routing.default_routes).",
    "# The route bills in EUR, converted by LowRouter at 1.0989 USD/EUR (ECB, 2026-11-17).",
    "# Another route can serve a request (routing policy or failover); usage.cost on the response",
    "# carries the amount debited.",
    "# Effort: reasoning_effort = low|medium|high, forwarded unchanged to the host.",
    "# Live check 2026-10-12 on this route: accepted low, medium, high.",
  ].join("\n") + "\n");
  // Once synced, the header follows the route even when the price is unchanged.
  const moved = { ...model().route!, id: "openai/openai/gpt-oss-120b", fx: undefined };
  expect(header(moved, written, false)).toContain("# Cost: the default route openai/openai/gpt-oss-120b");
  expect(header(moved, written, false)).toContain("# The route bills in USD; no currency conversion.");
});

test("never creates a model the catalog does not already have", () => {
  const files = { "auto/openai/gpt-oss-120b": authored() };
  expect(lowrouter.translateModel(model({ id: "auto/openai/gpt-oss-20b" }), context(files))).toBeUndefined();
  expect(lowrouter.translateModel(model(), context(files))).toMatchObject({ id: "auto/openai/gpt-oss-120b" });
});

test("moves a renamed ID's file to the new ID with its authored fields", () => {
  const [newID, oldID] = Object.entries(RENAMED)[0]!;
  const old = authored({ base_model: "mistral/ministral-3-3b-instruct-2512", reasoning_options: undefined });
  const translated = lowrouter.translateModel(model({ id: newID }), context({ [oldID]: old }, { [oldID]: HAND_HEADER }));
  expect(translated).toMatchObject({
    id: newID,
    model: { base_model: "mistral/ministral-3-3b-instruct-2512", cost: { input: 0.2198, output: 0.8791 } },
  });
  // A rename is not applied over a file that already exists under the new ID.
  const both = context({ [oldID]: old, [newID]: authored({ base_model: "mistral/other" }) });
  expect(lowrouter.translateModel(model({ id: newID }), both)).toMatchObject({ model: { base_model: "mistral/other" } });
});

test("reads the public USD catalog", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    return Response.json({ data: [{ id: "auto/openai/gpt-5" }] });
  }) as unknown as typeof fetch;
  const response = await fetchLowRouterModels(fetcher);
  expect(urls).toEqual(["https://api.lowrouter.ai/v1/models?currency=usd"]);
  expect(response.data.map((entry) => entry.id)).toEqual(["auto/openai/gpt-5"]);
});
