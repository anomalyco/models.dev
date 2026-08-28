import { expect, test } from "bun:test";

import { classifyAutoMerge, parseNameStatus } from "../src/sync/auto-merge.js";

const fullModel = (reasoning: boolean, options?: string) => `
name = "Test"
description = "Test model"
reasoning = ${reasoning}
${options ?? ""}
`;

test("allows unlimited updates and bounded model churn", async () => {
  const changes = Array.from({ length: 30 }, (_, index) => ({
    status: "updated" as const,
    path: `providers/test/models/model-${index}.toml`,
  }));
  const decision = await classifyAutoMerge(changes, async () => fullModel(false));

  expect(decision.safe).toBe(true);
  expect(decision.updated).toBe(30);
});

test("requires manual review for bulk additions", async () => {
  const changes = Array.from({ length: 11 }, (_, index) => ({
    status: "created" as const,
    path: `providers/test/models/model-${index}.toml`,
  }));
  const decision = await classifyAutoMerge(changes, async () => fullModel(false));

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
    async () => fullModel(true),
  );
  const withOptions = await classifyAutoMerge(
    [{ status: "created", path: "providers/test/models/reasoner.toml" }],
    async () => fullModel(true, "reasoning_options = []"),
  );

  expect(withoutOptions.safe).toBe(false);
  expect(withOptions.safe).toBe(false);
});

test("allows cost and limit updates to existing reasoning models", async () => {
  const current = `${fullModel(true, "reasoning_options = []")}\n[cost]\ninput = 1\n[limit]\noutput = 100\n`;
  const previous = `${fullModel(true, "reasoning_options = []")}\n[cost]\ninput = 2\n[limit]\noutput = 50\n`;
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
    async () => fullModel(true, 'reasoning_options = [{ type = "toggle" }]'),
    async () => fullModel(true, "reasoning_options = []"),
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
  for (const provider of ["crossmodel", "edenai", "empiriolabs", "hyper", "kilo", "llmgateway", "llmgateway-providers", "merge-gateway", "nano-gpt", "openrouter", "venice"]) {
    const decision = await classifyAutoMerge(
      [{ status: "updated", path: `providers/${provider}/models/reasoner.toml` }],
      async () => fullModel(true, 'reasoning_options = [{ type = "toggle" }]'),
      async () => fullModel(true, "reasoning_options = []"),
    );

    expect(decision.safe).toBe(true);
  }
});

test("requires manual review for Inceptron reasoning updates", async () => {
  const decision = await classifyAutoMerge(
    [{ status: "updated", path: "providers/inceptron/models/reasoner.toml" }],
    async () => fullModel(true, 'reasoning_options = [{ type = "effort", values = ["high"] }]'),
    async () => fullModel(true, "reasoning_options = []"),
  );

  expect(decision.safe).toBe(false);
  expect(decision.reasons).toContain(
    "providers/inceptron/models/reasoner.toml is a reasoning model that requires manual review",
  );
});

test("resolves reasoning from base model", async () => {
  const decision = await classifyAutoMerge(
    [{ status: "created", path: "providers/test/models/reasoner.toml" }],
    async (path) => path.startsWith("models/") ? fullModel(true) : 'base_model = "lab/reasoner"\n',
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
