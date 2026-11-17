import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider } from "../src/sync/index";
import { topxai } from "../src/sync/providers/topxai";

const basic = { unit: "per_million_tokens", input: 1, output: 5, cache_read: 0.05 };
const row = {
  model_name: "chat",
  supported_endpoint_types: ["openai", "openai-response"],
  auto_route: "shared",
  route_prices: { shared: basic, official: { ...basic, input: 30 } },
};
const feed = (data: unknown[]) => ({ success: true, pricing_version: "route-usd-v1", data });

test("selects chat routes from a successful public catalog and rejects incomplete pricing", () => {
  const media = { ...row, supported_endpoint_types: ["image-generation", "openai", "image-edit"] };
  const video = { ...row, supported_endpoint_types: ["video-generation"] };
  const system = { ...row, supported_endpoint_types: ["systemone"] };
  expect(topxai.parseModels(feed([row, media, video, system])).map((m) => m.id)).toEqual(["chat"]);
  for (const invalid of [
    feed([]), feed([media]), { ...feed([row]), success: false }, { ...feed([row]), pricing_version: "other" },
    feed([{ ...row, auto_route: "missing" }]), feed([row, { ...row, model_name: "CHAT" }]),
    feed([{ ...row, route_prices: { shared: { ...basic, input: -1 } } }]),
  ]) expect(() => topxai.parseModels(invalid)).toThrow();
});

test("reprices only the default route, retains a missing ID and leaves new IDs for review", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-topxai-"));
  try {
    const modelsDir = path.join(root, "providers/topxai/models");
    await mkdir(modelsDir, { recursive: true });
    const sample = [
      "# Source and API probe evidence", "schema = 2", 'name = "Chat"', 'description = "Chat fixture"',
      'release_date = "2026-01-01"', "open_weights = false", "[modalities]", 'input = ["text"]', 'output = ["text"]',
      "[capabilities]", "reasoning = { supported = false }", "tools = { supported = true }",
      "temperature = false", "top_p = false", "top_k = false", "[limit]", "context = 1000", "output = 200",
      "[api.responses]", 'capabilities = { tools = { freeform = ["regex"] } }',
      "[cost.text.input]", "price = 10", "cache = { read = 2, write = 3 }",
      "[[cost.text.input.overrides]]", "when = { context = { gt = 100 } }", "price = 20",
      "[[cost.text.input.overrides]]", 'when = { region = { equals = "us" } }', "price = 8",
      "[cost.text.output]", "price = 50", "[cost.web_search]", "price = 10", "",
    ].join("\n");
    const file = path.join(modelsDir, "chat.toml");
    await Bun.write(file, sample);
    await Bun.write(path.join(modelsDir, "absent.toml"), sample);
    const tier = {
      ...basic, cache_write: 2, cache_write_1h: 3,
      long_context: { min_input_tokens: 101, input: 2, output: 7.5, cache_read: 0.1, cache_write: 4, cache_write_1h: 6 },
    };
    const source = (price: typeof basic) => ({
      ...topxai, modelsDir,
      async fetchModels() {
        return feed([{ ...row, max_output: 100, route_prices: { shared: price } }, { ...row, model_name: "new-chat" }]);
      },
    });
    const done = await syncProvider(source(tier), { openIssues: false });
    expect(done).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    expect(done.notices.join("\n")).toContain("absent.toml");
    expect(await Bun.file(path.join(modelsDir, "absent.toml")).text()).toBe(sample);
    expect(await Bun.file(path.join(modelsDir, "new-chat.toml")).exists()).toBe(false);
    const updated = await Bun.file(file).text();
    expect(updated.startsWith("# Source and API probe evidence")).toBe(true);
    const parsed = Bun.TOML.parse(updated);
    expect(parsed).toMatchObject({
      api: { responses: { capabilities: { tools: { freeform: ["regex"] } } } },
      limit: { context: 1000, output: 100 },
      cost: {
        web_search: { price: 10 },
        text: {
          input: {
            price: 1, cache: { read: 0.05, write: { "5m": 2, "1h": 3 } },
            overrides: [
              { when: { context: { gt: 100 } }, price: 2, cache: { read: 0.1, write: { "5m": 4, "1h": 6 } } },
              { when: { region: { equals: "us" } }, price: 8 },
            ],
          },
          output: { price: 5, overrides: [{ when: { context: { gte: 101 } }, price: 7.5 }] },
        },
      },
    });
    expect((await syncProvider(source(tier), { openIssues: false })).updated).toBe(0);
    await syncProvider(source(basic), { openIssues: false });
    const after = Bun.TOML.parse(await Bun.file(file).text());
    expect(after).toMatchObject({
      cost: { text: {
        input: { price: 1, cache: { read: 0.05 }, overrides: [{ when: { region: { equals: "us" } }, price: 8 }] },
        output: { price: 5 },
      } },
    });
    expect(after).not.toHaveProperty("cost.text.output.overrides");
    expect(after).not.toHaveProperty("cost.text.input.cache.write");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
