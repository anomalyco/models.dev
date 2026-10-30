import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildLowRouterModel,
  catalogFromResponse,
  evidenceBlock,
  isAutoID,
  isCatalogTarget,
  type LowRouterModel,
  lowrouter,
  resolveLowRouterBaseModel,
} from "../src/sync/providers/lowrouter.js";
import type { ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";

function pinned(id: string, locode: string, region: Record<string, unknown>): LowRouterModel {
  return { id, modality: "chat", regions: [{ locode, ...region }] } as LowRouterModel;
}

function usd(prompt: number, completion: number, extra: Record<string, number> = {}) {
  return { pricing: { currency: "USD", prompt_per_1m_tokens: prompt, completion_per_1m_tokens: completion, ...extra } };
}

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "models");

/**
 * A real lab model with the property a test needs, picked at run time, so no test depends on
 * one specific model staying in the catalog. Lab entries get renamed or removed over time.
 */
function labModel(want: (toml: string) => boolean): string {
  for (const lab of ["openai", "anthropic", "mistral", "google", "deepseek"]) {
    for (const file of readdirSync(path.join(MODELS_DIR, lab)).sort()) {
      if (!file.endsWith(".toml")) continue;
      if (want(readFileSync(path.join(MODELS_DIR, lab, file), "utf8"))) return `${lab}/${file.slice(0, -".toml".length)}`;
    }
  }
  throw new Error("no lab model in models/ has the property this test needs");
}

const reasoning = (toml: string) => (Bun.TOML.parse(toml) as { reasoning?: boolean }).reasoning;
const REASONING_MODEL = labModel((toml) => reasoning(toml) === true);
const PLAIN_MODEL = labModel((toml) => reasoning(toml) === false);

/** An existing authored file pointing at a real lab model, so no name lookup is involved. */
function authored(base: string, extra: Partial<ExistingModel> = {}): ExistingModel {
  return { base_model: base, ...extra } as ExistingModel;
}

/** The header with comment wrapping undone, for content assertions. */
function flat(header: string) {
  return header.replace(/\n# /g, " ");
}

function auto(id: string, defaultRoute: string, overrides: Partial<LowRouterModel> = {}): LowRouterModel {
  return {
    id,
    modality: "chat",
    lifecycle: "active",
    endpoints: ["chat.completions", "messages", "responses"],
    capabilities: { function_calling: true },
    auto_routing: { candidates: [defaultRoute], default_routes: [defaultRoute], routing_reason: "eu_sovereign_preferred" },
    ...overrides,
  };
}

test("only unscoped auto IDs are catalog targets", () => {
  expect(isAutoID("auto/mistralai/mistral-large-2512")).toBe(true);
  expect(isAutoID("auto/mistralai/mistral-large-2512/eu")).toBe(false);
  expect(isAutoID("mistral/mistralai/mistral-large-2512")).toBe(false);
  expect(isAutoID("alias/my-model")).toBe(false);
});

test("LowRouter's own lifecycle and endpoint flags decide what is listed", () => {
  expect(isCatalogTarget(auto("auto/openai/gpt-6-sol", "openai/openai/gpt-6-sol/global"))).toBe(true);
  expect(isCatalogTarget(auto("auto/anthropic/claude-sonnet-4.5", "anthropic/anthropic/claude-sonnet-4.5/global", { lifecycle: "deprecated" }))).toBe(false);
  expect(isCatalogTarget(auto("auto/openai/gpt-5-pro", "openai/openai/gpt-5-pro/global", { endpoints: [] }))).toBe(false);
  expect(isCatalogTarget(auto("auto/mistralai/mistral-embed-2312", "mistral/mistralai/mistral-embed-2312/eu", { modality: "embedding" }))).toBe(false);
});

test("parseModels keeps catalog targets and indexes the pinned entries", () => {
  const models = lowrouter.parseModels({
    data: [
      auto("auto/mistralai/mistral-large-2512", "mistral/mistralai/mistral-large-2512/eu"),
      auto("auto/mistralai/mistral-large-2512/eu", "mistral/mistralai/mistral-large-2512/eu"),
      pinned("mistral/mistralai/mistral-large-2512", "eu", usd(0.5282, 1.5845)),
    ],
  });
  expect(models.map((model) => model.id)).toEqual(["auto/mistralai/mistral-large-2512"]);
});

test("base_model resolves through the lab's own entry for the upstream ID", async () => {
  // A temporary tree, so the test does not depend on a lab entry another sync can rewrite.
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-lowrouter-"));
  await mkdir(path.join(root, "providers", "examplelab", "models"), { recursive: true });
  await writeFile(path.join(root, "providers", "examplelab", "models", "example-2512.toml"), 'base_model = "examplelab/example-3-instruct-2512"\n');
  const catalog = catalogFromResponse([
    pinned("examplelab/examplelab/example-2512", "eu", { ...usd(0.1, 0.1), upstream_model_id: "example-2512" }),
  ]);
  expect(resolveLowRouterBaseModel(auto("auto/examplelab/example-2512", "examplelab/examplelab/example-2512/eu"), catalog, root))
    .toBe("examplelab/example-3-instruct-2512");
});

test("an upstream ID with no lab entry falls back to the shared name match", () => {
  const [lab, name] = PLAIN_MODEL.split("/");
  const catalog = catalogFromResponse([
    pinned(`somehost/${lab}/${name}`, "global", { ...usd(1, 2), upstream_model_id: `somehost.${name}` }),
  ]);
  expect(resolveLowRouterBaseModel(auto(`auto/${lab}/${name}`, `somehost/${lab}/${name}/global`), catalog)).toBe(PLAIN_MODEL);
});

test("cost comes from the published default route, and the header cites the fixing", () => {
  const catalog = catalogFromResponse([
    pinned("somehost/testlab/test-model", "eu", {
      ...usd(0.5282, 1.5845, { cache_read_per_1m_tokens: 0.0528 }),
      fx: [{ pair: "EURUSD", rate: 1.1298, as_of: "2026-10-01", source: "ecb", fixing: "monthly" }],
    }),
  ]);
  const built = buildLowRouterModel(auto("auto/testlab/test-model", "somehost/testlab/test-model/eu"), catalog, authored(PLAIN_MODEL));
  expect(built!.model).toMatchObject({ base_model: PLAIN_MODEL, cost: { input: 0.5282, output: 1.5845, cache_read: 0.0528 } });
  expect(flat(built!.header)).toContain("(eu_sovereign_preferred): somehost, eu endpoint");
  expect(flat(built!.header)).toContain("1.1298 USD/EUR (ECB monthly fixing, 2026-10-01)");
});

test("a non-USD quote is a hard error, never a silent number", () => {
  const catalog = catalogFromResponse([
    pinned("somehost/testlab/test-model", "eu", { pricing: { currency: "EUR", prompt_per_1m_tokens: 0.4675, completion_per_1m_tokens: 1.4025 } }),
  ]);
  expect(() => buildLowRouterModel(auto("auto/testlab/test-model", "somehost/testlab/test-model/eu"), catalog, authored(PLAIN_MODEL))).toThrow(/expected USD/);
});

test("reasoning options are LowRouter's published list for the default route", () => {
  const catalog = catalogFromResponse([
    pinned("somehost/testlab/effort-model", "global", { ...usd(2, 10), reasoning_effort: ["low", "medium", "high", "xhigh"], reasoning_mode: "forwarded", reasoning_effort_probed_at: "2026-10-12T12:31:00Z" }),
    pinned("otherhost/testlab/no-control-model", "br-gru", { ...usd(0.08, 0.24), reasoning_effort: [], reasoning_mode: "unsupported" }),
  ]);
  const effort = buildLowRouterModel(auto("auto/testlab/effort-model", "somehost/testlab/effort-model/global"), catalog, authored(REASONING_MODEL));
  expect(effort!.model).toMatchObject({ reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }] });
  expect(flat(effort!.header)).toContain("reasoning_mode forwarded, probed 2026-10-12");
  const none = buildLowRouterModel(auto("auto/testlab/no-control-model", "otherhost/testlab/no-control-model/br-gru"), catalog, authored(REASONING_MODEL));
  expect(none!.model).toMatchObject({ reasoning_options: [] });
});

test("a reasoning model without published or authored controls is reported, not given an empty list", () => {
  const catalog = catalogFromResponse([pinned("somehost/testlab/test-model", "global", usd(2.2, 11))]);
  expect(() => buildLowRouterModel(auto("auto/testlab/test-model", "somehost/testlab/test-model/global"), catalog, authored(REASONING_MODEL)))
    .toThrow(MissingReasoningOptionsError);
});

test("authored reasoning options, limits, tiers and status are kept; the API refreshes price and tools", () => {
  const catalog = catalogFromResponse([
    pinned("somehost/testlab/test-model", "fr-par", usd(0.11, 0.55, { cache_read_per_1m_tokens: 0.011, cache_write_per_1m_tokens: 0.1375 })),
  ]);
  const existing = authored(REASONING_MODEL, {
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }],
    status: "beta",
    limit: { context: 524_287 },
    cost: { input: 0.1, output: 0.5, tiers: [{ tier: { type: "context", size: 100_000 }, input: 0.55, output: 2.75 }] },
  } as Partial<ExistingModel>);
  const built = buildLowRouterModel(auto("auto/testlab/test-model", "somehost/testlab/test-model/fr-par"), catalog, existing);
  expect(built!.model).toMatchObject({
    base_model: REASONING_MODEL,
    status: "beta",
    limit: { context: 524_287 },
    cost: { input: 0.11, output: 0.55, cache_read: 0.011, cache_write: 0.1375, tiers: [{ tier: { type: "context", size: 100_000 } }] },
  });
  expect((built!.model as { reasoning_options?: unknown }).reasoning_options).toBeUndefined();
});

test("hand-written evidence is carried over from the existing header", () => {
  const file = "# Source: old line\n# Cost: old pricing\n# Effort: reasoning_effort = low|high.\n# Verified live.\nbase_model = \"x/y\"\n";
  expect(evidenceBlock(file)).toEqual(["# Effort: reasoning_effort = low|high.", "# Verified live."]);
  expect(evidenceBlock("# Source: only pricing\nbase_model = \"x/y\"\n")).toEqual([]);
});

test("cache prices come only from the default route, never from the previous file", () => {
  const catalog = catalogFromResponse([pinned("somehost/testlab/test-model", "eu", usd(0.2, 0.6))]);
  const existing = authored(PLAIN_MODEL, { cost: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 } } as Partial<ExistingModel>);
  const built = buildLowRouterModel(auto("auto/testlab/test-model", "somehost/testlab/test-model/eu"), catalog, existing);
  const cost = (built!.model as { cost?: Record<string, unknown> }).cost;
  expect(cost).toMatchObject({ input: 0.2, output: 0.6 });
  expect(cost?.cache_read).toBeUndefined();
  expect(cost?.cache_write).toBeUndefined();
});

test("options a previous sync wrote follow the default route; authored ones are kept", () => {
  const catalog = catalogFromResponse([
    pinned("otherhost/testlab/test-model", "eu", { ...usd(1, 2), reasoning_effort: ["low", "medium", "high"], reasoning_mode: "forwarded" }),
  ]);
  const model = auto("auto/testlab/test-model", "otherhost/testlab/test-model/eu");
  const previous = authored(REASONING_MODEL, { reasoning_options: [] } as Partial<ExistingModel>);
  const synced = [
    "# Source: old line",
    "# Reasoning: LowRouter publishes no reasoning control for this route (reasoning_mode unsupported).",
    "# https://lowrouter.ai/docs/guides/request-parameters",
    "# Limit: verified live.",
    "base_model = \"x/y\"",
  ].join("\n");
  const refreshed = buildLowRouterModel(model, catalog, previous, synced);
  expect(refreshed!.model).toMatchObject({ reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }] });
  expect(flat(refreshed!.header)).toContain("reasoning_effort = low|medium|high as LowRouter publishes it");
  expect(refreshed!.header).not.toContain("publishes no reasoning control");
  expect(refreshed!.header).toContain("# Limit: verified live.");

  const handWritten = "# Source: old line\n# Effort: reasoning_effort = none, checked by hand.\nbase_model = \"x/y\"\n";
  const kept = buildLowRouterModel(model, catalog, previous, handWritten);
  expect((kept!.model as { reasoning_options?: unknown }).reasoning_options).toBeUndefined();
  expect(kept!.header).toContain("# Effort: reasoning_effort = none, checked by hand.");
});
