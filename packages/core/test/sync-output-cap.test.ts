import { expect, test } from "bun:test";

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { capOutputAtContext, syncProvider } from "../src/sync/index";

const model = (limit?: { context?: number; input?: number; output?: number }) =>
  ({ id: "m", base_model: "lab/m", ...(limit ? { limit } : {}) }) as any;

test("caps a synced output that is larger than the host's context", () => {
  expect(capOutputAtContext(model({ context: 8_192, output: 16_384 }), { limit: { context: 1_000_000, output: 100_000 } }).limit).toEqual({
    context: 8_192,
    output: 8_192,
  });
});

test("caps an output inherited from a lab with a larger window", () => {
  expect(capOutputAtContext(model({ context: 40_000 }), { limit: { context: 131_072, output: 131_072 } }).limit).toEqual({
    context: 40_000,
    output: 40_000,
  });
});

test("drops the output when the capped value is the lab's own", () => {
  expect(capOutputAtContext(model({ context: 8_192, output: 16_384 }), { limit: { context: 8_192, output: 8_192 } }).limit).toEqual({
    context: 8_192,
  });
});

test("leaves a model alone when output fits or context is unknown", () => {
  const fits = model({ context: 128_000, output: 64_000 });
  expect(capOutputAtContext(fits, undefined)).toBe(fits);
  const unknown = model({ output: 64_000 });
  expect(capOutputAtContext(unknown, undefined)).toBe(unknown);
});

test("leaves models that don't output text alone", () => {
  const tts = { ...model({ context: 8_192, output: 16_384 }), modalities: { input: ["text"], output: ["audio"] } };
  expect(capOutputAtContext(tts, undefined)).toBe(tts);
  // Lab metadata reaches sync in v1 form, where an embedding's output is "text".
  const embed = model({ context: 512, output: 1_024 });
  expect(capOutputAtContext(embed, { modalities: { output: ["text"] } }, true)).toBe(embed);
});

const lab = (output: string, limit: string) => `schema = 2
name = "Lab Model"
description = "Test model"
open_weights = false
release_date = "2026-01-01"

[modalities]
input = ["text"]
output = ["${output}"]

[capabilities]
tools = { supported = false }
reasoning = { supported = false }
temperature = false
top_p = false
top_k = false

[limit]
${limit}
`;

async function syncHost(labOutput: string, labLimit: string) {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-output-cap-"));
  try {
    const modelsDir = path.join(root, "providers", "host", "models");
    await mkdir(modelsDir, { recursive: true });
    await mkdir(path.join(root, "models", "acme"), { recursive: true });
    await Bun.write(path.join(root, "providers", "host", "provider.toml"), 'name = "Host"\nnpm = "@ai-sdk/openai-compatible"\nenv = ["HOST_API_KEY"]\napi = "https://example.com/v1"\ndoc = "https://example.com"\n');
    await Bun.write(path.join(root, "models", "acme", "m.toml"), lab(labOutput, labLimit));
    await syncProvider(
      {
        id: "host",
        name: "Host",
        modelsDir,
        async fetchModels() {
          return [{ id: "m" }];
        },
        parseModels: (raw) => raw as { id: string }[],
        translateModel: (source) => ({
          id: source.id,
          model: { base_model: "acme/m", limit: { context: 512, output: 1_024 } } as any,
        }),
      },
      { openIssues: false },
    );
    return await readFile(path.join(modelsDir, "m.toml"), "utf8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("sync keeps an output above the context when the lab outputs no text", async () => {
  const written = await syncHost("embedding", "context = 8_192\noutput = 0");
  expect(written).toContain("context = 512");
  expect(written).toContain("output = 1_024");
});

test("sync caps an output above the context when the lab outputs text", async () => {
  const written = await syncHost("text", "context = 8_192\noutput = 4_096");
  expect(written).toContain("context = 512");
  expect(written).toContain("output = 512");
  expect(written).not.toContain("output = 1_024");
});
