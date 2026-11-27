#!/usr/bin/env bun
/**
 * Download the latest version of every server in the official MCP registry.
 *
 * Source: https://registry.modelcontextprotocol.io/v0.1/servers?version=latest
 * The endpoint, cursor pagination, and `version=latest` filter are the v0.1
 * API from https://github.com/modelcontextprotocol/registry. `limit` cannot
 * exceed 100.
 *
 * The registry host is fetched directly. When that connection fails, set
 * MCP_REGISTRY_PROXY to a prefix such as https://r.jina.ai/ (the reader
 * allows about 20 requests a minute). The script remembers its cursor in
 * MCP_SYNC_STATE (default /tmp/mcp-sync) and can be resumed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import path from "path";

const root = path.join(import.meta.dir, "..");
const registryOrigin = "https://registry.modelcontextprotocol.io";
const stateDir = process.env.MCP_SYNC_STATE ?? "/tmp/mcp-sync";
const output = process.env.MCP_SYNC_OUTPUT ?? path.join(root, "mcp", "servers.json");
const jsonlPath = path.join(stateDir, "servers.jsonl");
const cursorPath = path.join(stateDir, "cursor.txt");
const pageSize = 100;

interface RegistryList {
  servers?: RegistryEntry[];
  metadata?: { nextCursor?: string; count?: number };
  status?: number;
  title?: string;
  detail?: string;
}

interface RegistryEntry {
  server?: {
    name?: string;
    title?: string;
    description?: string;
    version?: string;
    websiteUrl?: string;
    repository?: { url?: string };
    icons?: Array<{ src?: string }>;
    packages?: Array<{
      registryType?: string;
      identifier?: string;
      version?: string;
      runtimeHint?: string;
      transport?: { type?: string };
    }>;
    remotes?: Array<{ type?: string; url?: string }>;
  };
  _meta?: {
    "io.modelcontextprotocol.registry/official"?: {
      status?: string;
      statusMessage?: string;
      publishedAt?: string;
      updatedAt?: string;
      isLatest?: boolean;
    };
  };
}

mkdirSync(stateDir, { recursive: true });

const proxy = await detectProxy();
let cursor = existsSync(cursorPath) ? readFileSync(cursorPath, "utf8").trim() : "";
if (cursor === "DONE") cursor = "";
if (!cursor && existsSync(jsonlPath)) rmSync(jsonlPath);

const stamps: number[] = [];
let pages = 0;
let kept = 0;

for (;;) {
  await pace();
  const page = await fetchPage(cursor);
  const servers = page.servers ?? [];
  if (servers.length === 0 && !page.metadata?.nextCursor) break;

  const lines: string[] = [];
  for (const entry of servers) {
    const record = compact(entry);
    if (!record) continue;
    lines.push(JSON.stringify(record));
    kept++;
  }
  if (lines.length > 0) appendFileSync(jsonlPath, `${lines.join("\n")}\n`);

  pages++;
  const next = page.metadata?.nextCursor ?? "";
  writeFileSync(cursorPath, next);
  console.log(
    `mcp-sync page ${pages} kept ${kept} batch ${servers.length} cursor ${next || "(end)"}`,
  );
  if (!next) break;
  cursor = next;
}

const byName = new Map<string, Record<string, unknown>>();
if (existsSync(jsonlPath)) {
  for (const line of readFileSync(jsonlPath, "utf8").split("\n")) {
    if (!line) continue;
    const record = JSON.parse(line) as { name?: string; updatedAt?: string };
    if (!record.name) continue;
    const previous = byName.get(record.name) as { updatedAt?: string } | undefined;
    if (!previous || (record.updatedAt ?? "") >= (previous.updatedAt ?? "")) {
      byName.set(record.name, record);
    }
  }
}

const servers = [...byName.values()].sort((a, b) =>
  String(a.name).localeCompare(String(b.name)),
);
mkdirSync(path.dirname(output), { recursive: true });
const catalog = {
  source: `${registryOrigin}/v0.1/servers?version=latest`,
  syncedAt: new Date().toISOString(),
  count: servers.length,
  servers,
};
const temporary = `${output}.tmp`;
writeFileSync(temporary, JSON.stringify(catalog));
renameSync(temporary, output);
writeFileSync(cursorPath, "DONE");
console.log(`mcp-sync wrote ${servers.length} servers to ${output}`);

function compact(entry: RegistryEntry) {
  const server = entry.server;
  const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];
  if (!server?.name || !server.name.includes("/")) return undefined;
  if (meta?.status === "deleted") return undefined;
  if (meta && meta.isLatest === false) return undefined;

  const record: Record<string, unknown> = {
    name: server.name,
    description: server.description ?? "",
    version: server.version ?? "",
  };
  if (server.title) record.title = server.title;
  if (server.websiteUrl) record.website = server.websiteUrl;
  if (server.repository?.url) record.repository = server.repository.url;
  if (meta?.status && meta.status !== "active") record.status = meta.status;
  if (meta?.statusMessage) record.statusMessage = meta.statusMessage;
  if (meta?.publishedAt) record.publishedAt = meta.publishedAt;
  if (meta?.updatedAt) record.updatedAt = meta.updatedAt;

  const icon = server.icons?.find((item) => item.src?.startsWith("https://"))?.src;
  if (icon) record.icon = icon;

  const packages = (server.packages ?? [])
    .filter((item) => item.registryType && item.identifier)
    .map((item) => ({
      registryType: item.registryType,
      identifier: item.identifier,
      ...(item.version ? { version: item.version } : {}),
      ...(item.runtimeHint ? { runtimeHint: item.runtimeHint } : {}),
      ...(item.transport?.type ? { transport: item.transport.type } : {}),
    }));
  if (packages.length > 0) record.packages = packages;

  const remotes = (server.remotes ?? [])
    .filter((item) => item.type && item.url)
    .map((item) => ({ type: item.type, url: item.url }));
  if (remotes.length > 0) record.remotes = remotes;

  return record;
}

async function detectProxy() {
  if (process.env.MCP_REGISTRY_PROXY) return process.env.MCP_REGISTRY_PROXY;
  try {
    const response = await fetch(`${registryOrigin}/v0.1/ping`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      console.log("mcp-sync using the registry directly");
      return "";
    }
  } catch {
    // The registry host is unreachable from this network.
  }
  const fallback = "https://r.jina.ai/";
  console.log(`mcp-sync registry unreachable, using ${fallback}`);
  return fallback;
}

async function fetchPage(cursor: string): Promise<RegistryList> {
  const params = new URLSearchParams({ version: "latest", limit: String(pageSize) });
  if (cursor) params.set("cursor", cursor);
  const direct = `${registryOrigin}/v0.1/servers?${params}`;
  const url = proxy ? `${proxy}${direct}` : direct;

  for (let attempt = 1; attempt <= 6; attempt++) {
    const response = await fetch(url, {
      headers: proxy
        ? { "X-Return-Format": "text", "user-agent": "models.dev-mcp-sync" }
        : { accept: "application/json", "user-agent": "models.dev-mcp-sync" },
      signal: AbortSignal.timeout(90_000),
    });
    if (response.status === 429) {
      const retry = Number(response.headers.get("retry-after") ?? 60);
      console.log(`mcp-sync rate limited, waiting ${retry || 60}s`);
      stamps.length = 0;
      await sleep((retry || 60) * 1000);
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`registry ${response.status}: ${text.slice(0, 180)}`);
    }
    let parsed: RegistryList;
    try {
      parsed = JSON.parse(text) as RegistryList;
    } catch (error) {
      if (attempt === 6) throw error;
      console.log(`mcp-sync bad page, retry ${attempt}`);
      await sleep(2_000 * attempt);
      continue;
    }
    if (parsed.status === 429 || parsed.title === "Too Many Requests") {
      stamps.length = 0;
      await sleep(60_000);
      continue;
    }
    if (!parsed.servers || !parsed.metadata) {
      if (attempt === 6) {
        throw new Error(`unexpected registry page: ${text.slice(0, 180)}`);
      }
      console.log(`mcp-sync unexpected page, retry ${attempt}`);
      await sleep(2_000 * attempt);
      continue;
    }
    return parsed;
  }
  throw new Error("registry page failed");
}

async function pace() {
  if (!proxy) return;
  const now = Date.now();
  while (stamps.length > 0 && now - stamps[0]! >= 60_000) stamps.shift();
  if (stamps.length >= 18) {
    const wait = 60_000 - (now - stamps[0]!) + 500;
    console.log(`mcp-sync pacing ${Math.ceil(wait / 1000)}s`);
    await sleep(wait);
  }
  stamps.push(Date.now());
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
