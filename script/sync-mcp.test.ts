import { expect, test } from "bun:test";
import { assertCatalogNotShrunk, compact } from "./sync-mcp";

test("compact keeps latest active registry servers", () => {
  const record = compact({
    server: {
      name: "io.github.example/weather",
      title: "Weather",
      description: "Forecasts",
      version: "1.2.0",
      websiteUrl: "https://example.com",
      packages: [
        {
          registryType: "npm",
          identifier: "@example/weather",
          version: "1.2.0",
          transport: { type: "stdio" },
        },
      ],
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        status: "active",
        isLatest: true,
        updatedAt: "2026-11-01T00:00:00Z",
      },
    },
  });

  expect(record).toMatchObject({
    name: "io.github.example/weather",
    title: "Weather",
    version: "1.2.0",
    packages: [
      {
        registryType: "npm",
        identifier: "@example/weather",
        version: "1.2.0",
        transport: "stdio",
      },
    ],
  });
});

test("compact drops deleted, non-latest, and invalid names", () => {
  expect(
    compact({
      server: { name: "weather", description: "", version: "1" },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
    }),
  ).toBeUndefined();
  expect(
    compact({
      server: { name: "io.github.example/weather", description: "", version: "1" },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted", isLatest: true } },
    }),
  ).toBeUndefined();
  expect(
    compact({
      server: { name: "io.github.example/weather", description: "", version: "1" },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: false } },
    }),
  ).toBeUndefined();
});

test("assertCatalogNotShrunk blocks truncated writes", () => {
  expect(() => assertCatalogNotShrunk(1000, 76290)).toThrow(/refused to overwrite/);
  expect(() => assertCatalogNotShrunk(76290, 76290)).not.toThrow();
  expect(() => assertCatalogNotShrunk(1000, 76290, { allowShrink: true })).not.toThrow();
  expect(() => assertCatalogNotShrunk(1000, undefined)).not.toThrow();
});
