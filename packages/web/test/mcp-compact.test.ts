import { expect, test } from "bun:test";
import {
  compactMcpDetailShards,
  compactMcpWebCatalog,
  mcpDetailBucket,
} from "../src/mcp-compact";
import type { McpCatalog } from "../src/mcp-shared";

const catalog: McpCatalog = {
  source: "https://registry.modelcontextprotocol.io/v0.1/servers?version=latest",
  syncedAt: "2026-11-28T00:00:00.000Z",
  count: 1,
  servers: [
    {
      name: "io.github.example/weather",
      title: "Weather",
      description: "A long description that belongs on the detail page only.",
      version: "1.0.0",
      updatedAt: "2026-11-01T12:00:00.000Z",
      packages: [
        {
          registryType: "npm",
          identifier: "@example/weather",
          transport: "stdio",
          runtimeHint: "node",
        },
      ],
      remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
    },
  ],
};

test("web catalog drops descriptions and keeps browse fields", () => {
  const web = compactMcpWebCatalog(catalog);
  expect(web.count).toBe(1);
  expect(web.servers[0]).toEqual({
    n: "io.github.example/weather",
    t: "Weather",
    v: "1.0.0",
    u: "2026-11-01",
    tr: "stdio,streamable-http",
    rg: "npm",
  });
});

test("detail shards put each server in a stable bucket", () => {
  const bucket = mcpDetailBucket("io.github.example/weather");
  const shards = compactMcpDetailShards(catalog);
  expect(shards[bucket]?.[0]?.description).toContain("detail page only");
  expect(shards[bucket]?.[0]?.packages?.[0]).toEqual({
    registryType: "npm",
    identifier: "@example/weather",
    transport: "stdio",
  });
});
