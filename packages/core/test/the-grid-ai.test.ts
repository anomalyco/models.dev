import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import {
  buildTheGridAiModel,
  fetchTheGridAiModels,
  parseTheGridAiModels,
  theGridAi,
  type TheGridAiModel,
} from "../src/sync/providers/the-grid-ai.js";

const row = (overrides: Partial<TheGridAiModel> = {}): TheGridAiModel => ({
  id: "agent-max",
  context_length: 1_000_000,
  max_input_tokens: 922_000,
  max_completion_tokens: 128_000,
  attachments: true,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  ...overrides,
});

const authored: ExistingModel = {
  name: "Agent Max",
  attachment: true,
  reasoning: true,
  reasoning_options: [{ type: "toggle" }],
  limit: { context: 1, input: 1, output: 1 },
  modalities: { input: ["text"], output: ["text"] },
};

test("registers an update-only hourly sync and never deletes absent entries", () => {
  expect(providers["the-grid-ai"]).toBe(theGridAi);
  expect(theGridAi.skipCreates).toBe(true);
  expect(theGridAi.trackMissingModels).toBe(true);
  expect(theGridAi.deleteMissing).toBe(false);
});

test("fetches the public catalog and rejects HTTP failures", async () => {
  let request: string | undefined;
  const fetcher = (async (input) => {
    request = String(input);
    return Response.json({ data: [row()] });
  }) as typeof fetch;
  await expect(fetchTheGridAiModels(fetcher)).resolves.toMatchObject({ data: [row()] });
  expect(request).toBe("https://api.thegrid.ai/v1/models");
  await expect(
    fetchTheGridAiModels((async () => new Response("bad gateway", { status: 502 })) as typeof fetch),
  ).rejects.toThrow("502");
});

test("rejects empty, duplicate, and malformed catalogs", () => {
  expect(() => parseTheGridAiModels({ data: [] })).toThrow();
  expect(() => parseTheGridAiModels({ data: [row(), row()] })).toThrow("duplicate");
  expect(() => parseTheGridAiModels({ data: [row({ context_length: 0 })] })).toThrow();
  expect(parseTheGridAiModels({ data: [row({ hugging_face_id: null } as Partial<TheGridAiModel>)] })).toHaveLength(1);
});

test("updates served limits and modalities and never writes cost", () => {
  const synced = buildTheGridAiModel(row(), authored);
  expect(synced).toMatchObject({
    name: "Agent Max",
    attachment: true,
    limit: { context: 1_000_000, input: 922_000, output: 128_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    reasoning_options: [{ type: "toggle" }],
  });
  expect(synced).not.toHaveProperty("cost");
  const priced = buildTheGridAiModel(row(), { ...authored, cost: { input: 1.5, output: 1.5 } });
  expect(priced).toMatchObject({ cost: { input: 1.5, output: 1.5 } });
});

test("keeps authored values when the listing omits serving fields", () => {
  const synced = buildTheGridAiModel(
    row({
      context_length: undefined,
      max_input_tokens: undefined,
      max_completion_tokens: undefined,
      attachments: undefined,
      architecture: undefined,
    }),
    authored,
  );
  expect(synced).toMatchObject({
    attachment: true,
    limit: { context: 1, input: 1, output: 1 },
    modalities: { input: ["text"], output: ["text"] },
  });
});

test("applies served limits through the base-model overlay", () => {
  const synced = buildTheGridAiModel(
    row({ context_length: 777_777, max_input_tokens: 702_000, max_completion_tokens: 77_777 }),
    { ...authored, base_model: "openai/gpt-5.6-sol" },
  );
  expect(synced).toMatchObject({
    base_model: "openai/gpt-5.6-sol",
    limit: { context: 777_777, input: 702_000, output: 77_777 },
  });
});

test("tracks every instrument row", () => {
  expect(theGridAi.sourceID(row())).toBe("agent-max");
  expect(theGridAi.sourceID(row({ id: "kimi-latest" }))).toBe("kimi-latest");
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("runner updates authored instruments, reports new ones, and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "the-grid-ai-sync-test-"));
  roots.push(root);
  const modelsDir = path.join(root, "providers/the-grid-ai/models");
  await mkdir(modelsDir, { recursive: true });
  const file = path.join(modelsDir, "agent-max.toml");
  const initial = await Bun.file("providers/the-grid-ai/models/agent-max.toml").text();
  await Bun.write(file, initial);
  const retired = path.join(modelsDir, "retired-instrument.toml");
  await Bun.write(retired, initial);
  const model = row({ context_length: 2_000_000, max_input_tokens: 1_900_000, max_completion_tokens: 256_000 });
  const provider = {
    ...theGridAi,
    modelsDir,
    fetchModels: async () => ({ data: [model, row({ id: "kimi-latest" })] }),
  };
  const result = await syncProvider(provider);
  expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0, unchanged: 1 });
  expect(result.notices.join("\n")).toContain("kimi-latest");
  expect(await Bun.file(path.join(modelsDir, "kimi-latest.toml")).exists()).toBe(false);
  expect(await Bun.file(retired).text()).toBe(initial);
  const content = await Bun.file(file).text();
  expect(content.startsWith("# Tokens on The Grid trade on an open market")).toBe(true);
  const parsed = Bun.TOML.parse(content) as Record<string, unknown>;
  expect(parsed).toMatchObject({
    limit: { context: 2_000_000, input: 1_900_000, output: 256_000 },
    modalities: { input: ["text", "image"] },
  });
  expect(parsed).not.toHaveProperty("cost");
  expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
});
