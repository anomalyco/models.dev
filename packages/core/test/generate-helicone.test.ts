import { expect, test } from "bun:test";
import path from "node:path";

import { heliconeCost, newModelToml, updatedModelToml } from "../script/generate-helicone.js";
import { modelV2ToV1 } from "../src/translate.js";

const MODELS = path.join(import.meta.dir, "../../../providers/helicone/models");

function registryModel(pricing: Record<string, number>, overrides: Record<string, unknown> = {}) {
  return {
    id: "claude-3.7-sonnet",
    name: "Anthropic: Claude 3.7 Sonnet",
    author: "anthropic",
    contextLength: 200_000,
    maxOutput: 64_000,
    trainingDate: "2025-02-19T00:00:00.000Z",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportedParameters: ["tools", "tool_choice", "max_tokens", "temperature"],
    endpoints: [{ provider: "anthropic", pricing }],
    ...overrides,
  };
}

const claude = `# Toggle: thinking.type = enabled|disabled.
schema = 2
base_model = "anthropic/claude-3-7-sonnet-20250219"
name = "Anthropic: Claude 3.7 Sonnet"

[capabilities]
reasoning = { supported = true, toggle = true, budget = { min = 1_024, max = 63_999 } }

[cost.text.input]
price = 3
cache = { read = 0.3, write = { "5m" = 3.75, "1h" = 6 } }

[cost.text.output]
price = 15
`;

test("rounds float noise out of registry prices", () => {
  expect(heliconeCost(registryModel({ prompt: 3, completion: 15, cacheRead: 0.30000000000000004, cacheWrite: 3.75 }))).toEqual({
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write: 3.75,
  });
});

test("leaves an authored v2 file alone when the registry price is unchanged", () => {
  const model = registryModel({ prompt: 3, completion: 15, cacheRead: 0.30000000000000004, cacheWrite: 3.75 });
  expect(updatedModelToml(claude, model)).toBeUndefined();
});

test("updates only the price of an authored v2 file", () => {
  const model = registryModel({ prompt: 6, completion: 30, cacheRead: 0.6, cacheWrite: 7.5 });
  const next = updatedModelToml(claude, model)!;

  expect(next).toBe(claude
    .replace("price = 3\n", "price = 6\n")
    .replace("price = 15\n", "price = 30\n")
    .replace('cache = { read = 0.3, write = { "5m" = 3.75, "1h" = 6 } }', 'cache = { read = 0.6, write = { "5m" = 7.5, "1h" = 12 } }'));
});

test("reproduces every shipped file from its own price", async () => {
  for await (const file of new Bun.Glob("*.toml").scan({ cwd: MODELS })) {
    const text = await Bun.file(path.join(MODELS, file)).text();
    const id = file.slice(0, -5);
    const { cost } = modelV2ToV1({ ...(Bun.TOML.parse(text) as Record<string, unknown>), id }) as {
      cost?: Record<string, number>;
    };
    const pricing = cost && {
      prompt: cost.input,
      completion: cost.output,
      cacheRead: cost.cache_read,
      cacheWrite: cost.cache_write,
    };
    expect(updatedModelToml(text, registryModel(pricing ?? {}, { id, endpoints: pricing ? [{ provider: "anthropic", pricing }] : [] }))).toBeUndefined();
  }
});

test("writes new models as v2 files", () => {
  const toml = newModelToml(registryModel({ prompt: 3, completion: 15 }));
  const doc = Bun.TOML.parse(toml) as Record<string, unknown>;

  expect(doc.schema).toBe(2);
  expect(modelV2ToV1({ ...doc, id: "claude-3.7-sonnet" })).toMatchObject({
    name: "Anthropic: Claude 3.7 Sonnet",
    attachment: true,
    tool_call: true,
    reasoning: false,
    cost: { input: 3, output: 15 },
    limit: { context: 200_000, output: 64_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
  });
});

test("keeps provider overrides such as family when the price changes", () => {
  const text = `# Family: kept from v1.
schema = 2
base_model = "xai/grok-code-fast-1"
name = "xAI Grok Code Fast 1"
family = "grok"
knowledge = "2024-08"

[cost.text.input]
price = 0.2

[cost.text.output]
price = 1.5
`;
  const model = registryModel({ prompt: 0.25, completion: 1.5 }, { id: "grok-code-fast-1", author: "xai", endpoints: [{ provider: "xai", pricing: { prompt: 0.25, completion: 1.5 } }] });

  expect(updatedModelToml(text, model)).toBe(text.replace("price = 0.2\n", "price = 0.25\n"));
});
