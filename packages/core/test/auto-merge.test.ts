import { expect, test } from "bun:test";

import { classifyAutoMerge, parseNameStatus } from "../src/sync/auto-merge.js";

const fullModel = (reasoning: string, extra = "") => `
schema = 2
name = "Test"
description = "Test model"

[capabilities]
reasoning = ${reasoning}
${extra}`;

const off = "{ supported = false }";
const on = "{ supported = true }";

const labModel = `
schema = 2
name = "Test"
description = "Test lab model"
open_weights = false
release_date = "2026-01-01"

[modalities]
input = ["text"]
output = ["text"]

[capabilities]
tools = { supported = true }
reasoning = { supported = true }
temperature = true
top_p = true
top_k = false

[limit]
context = 1_000
output = 100
`;

test("allows unlimited updates and bounded model churn", async () => {
  const changes = Array.from({ length: 30 }, (_, index) => ({
    status: "updated" as const,
    path: `providers/test/models/model-${index}.toml`,
  }));
  const decision = await classifyAutoMerge(changes, async () => fullModel(off));

  expect(decision.safe).toBe(true);
  expect(decision.updated).toBe(30);
});

test("requires manual review for bulk additions", async () => {
  const changes = Array.from({ length: 11 }, (_, index) => ({
    status: "created" as const,
    path: `providers/test/models/model-${index}.toml`,
  }));
  const decision = await classifyAutoMerge(changes, async () => fullModel(off));

  expect(decision.safe).toBe(false);
  expect(decision.reasons).toContain("11 models created (limit 10)");
});

test("requires manual review for Cloudflare AI Gateway deletions", async () => {
  const decision = await classifyAutoMerge([
    {
      status: "deleted",
      path: "providers/cloudflare-ai-gateway/models/openai/gpt-4.1.toml",
    },
  ]);

  expect(decision.safe).toBe(false);
  expect(decision.reasons).toContain("Cloudflare AI Gateway model deletions require manual review");
});

test("requires manual review for added reasoning provider models", async () => {
  const withoutOptions = await classifyAutoMerge(
    [{ status: "created", path: "providers/test/models/reasoner.toml" }],
    async (path) => path.startsWith("models/") ? labModel : 'schema = 2\nbase_model = "lab/reasoner"\n',
  );
  const withOptions = await classifyAutoMerge(
    [{ status: "created", path: "providers/test/models/reasoner.toml" }],
    async () => fullModel(on),
  );

  expect(withoutOptions.safe).toBe(false);
  expect(withOptions.safe).toBe(false);
});

test("allows cost and limit updates to existing reasoning models", async () => {
  const current = fullModel(on, "\n[limit]\noutput = 100\n\n[cost.text.input]\nprice = 1\n\n[cost.text.output]\nprice = 2\n");
  const previous = fullModel(on, "\n[limit]\noutput = 50\n\n[cost.text.input]\nprice = 2\n\n[cost.text.output]\nprice = 2\n");
  const decision = await classifyAutoMerge(
    [{ status: "updated", path: "providers/test/models/reasoner.toml" }],
    async () => current,
    async () => previous,
  );

  expect(decision.safe).toBe(true);
});

test("requires manual review when reasoning options change", async () => {
  const decision = await classifyAutoMerge(
    [{ status: "updated", path: "providers/test/models/reasoner.toml" }],
    async () => fullModel("{ supported = true, toggle = true }"),
    async () => fullModel(on),
  );

  expect(decision.safe).toBe(false);
});

test("does not inspect deleted models", async () => {
  const decision = await classifyAutoMerge(
    [{ status: "deleted", path: "providers/test/models/reasoner.toml" }],
    async () => {
      throw new Error("deleted model should not be loaded");
    },
    async () => {
      throw new Error("deleted model should not be loaded");
    },
  );

  expect(decision.safe).toBe(true);
});

test("allows reviewed providers with explicit reasoning options", async () => {
  for (const provider of ["aiand", "crossmodel", "edenai", "empiriolabs", "hyper", "kilo", "llmgateway", "llmgateway-providers", "merge-gateway", "nano-gpt", "openrouter", "venice", "vercel"]) {
    const decision = await classifyAutoMerge(
      [{ status: "updated", path: `providers/${provider}/models/reasoner.toml` }],
      async () => fullModel("{ supported = true, toggle = true }"),
      async () => fullModel(on),
    );

    expect(decision.safe).toBe(true);
  }
});

test("allows new Vercel reasoning models only with explicit options", async () => {
  const changes = [{ status: "created" as const, path: "providers/vercel/models/deepseek/reasoner.toml" }];
  const load = (options: string) => async (path: string) =>
    path.startsWith("models/") ? labModel : `schema = 2\nbase_model = "deepseek/reasoner"\n${options}`;

  expect((await classifyAutoMerge(changes, load(`\n[capabilities]\nreasoning = ${on}\n`))).safe).toBe(true);
  expect((await classifyAutoMerge(changes, load(""))).reasons).toContain(
    "providers/vercel/models/deepseek/reasoner.toml is a reasoning model without explicit reasoning_options",
  );
});

test("requires manual review for Inceptron reasoning updates", async () => {
  const decision = await classifyAutoMerge(
    [{ status: "updated", path: "providers/inceptron/models/reasoner.toml" }],
    async () => fullModel('{ supported = true, effort = ["high"] }'),
    async () => fullModel(on),
  );

  expect(decision.safe).toBe(false);
  expect(decision.reasons).toContain(
    "providers/inceptron/models/reasoner.toml is a reasoning model that requires manual review",
  );
});

test("resolves reasoning from base model", async () => {
  const decision = await classifyAutoMerge(
    [{ status: "created", path: "providers/test/models/reasoner.toml" }],
    async (path) => path.startsWith("models/") ? labModel : 'schema = 2\nbase_model = "lab/reasoner"\n',
  );

  expect(decision.safe).toBe(false);
});

test("parses additions, modifications, and deletions", () => {
  expect(parseNameStatus("A\tmodels/a.toml\nM\tmodels/b.toml\nD\tmodels/c.toml\n"))
    .toEqual([
      { status: "created", path: "models/a.toml" },
      { status: "updated", path: "models/b.toml" },
      { status: "deleted", path: "models/c.toml" },
    ]);
});

test("counts unexpected renames as a deletion and creation", () => {
  expect(parseNameStatus("R100\tmodels/old.toml\tmodels/new.toml\n"))
    .toEqual([
      { status: "deleted", path: "models/old.toml" },
      { status: "created", path: "models/new.toml" },
    ]);
});
