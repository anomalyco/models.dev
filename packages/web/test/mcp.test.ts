import { expect, test } from "bun:test";
import {
  mcpRegistries,
  mcpServerHref,
  mcpServerName,
  mcpTransports,
  safeHttpUrl,
} from "../src/mcp-shared";

test("mcp server routes keep the registry name", () => {
  expect(mcpServerHref("io.github.example/weather")).toBe(
    "/mcp/io.github.example/weather",
  );
  expect(mcpServerName("/mcp/io.github.example/weather")).toBe(
    "io.github.example/weather",
  );
  expect(mcpServerName("/mcp/io.github.example/weather/")).toBe(
    "io.github.example/weather",
  );
  expect(mcpServerName("/mcp/io.github.example%2Fweather")).toBe(
    "io.github.example/weather",
  );
  expect(mcpServerName("/mcp")).toBeUndefined();
  expect(mcpServerName("/mcp/server")).toBeUndefined();
  expect(mcpServerName("/models")).toBeUndefined();
});

test("mcp summaries ignore unsafe urls", () => {
  const server = {
    name: "io.github.example/weather",
    description: "Weather",
    version: "1.0.0",
    packages: [
      { registryType: "npm", identifier: "weather", transport: "stdio" },
      { registryType: "npm", identifier: "weather", transport: "stdio" },
    ],
    remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
  };

  expect(mcpTransports(server)).toEqual(["stdio", "streamable-http"]);
  expect(mcpRegistries(server)).toEqual(["npm"]);
  expect(safeHttpUrl("https://example.com/mcp")).toBe("https://example.com/mcp");
  expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined();
});
