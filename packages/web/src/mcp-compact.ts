import type { McpCatalog, McpServerRecord } from "./mcp-shared.js";

export const MCP_DETAIL_BUCKETS = 256;

export interface McpWebServer {
  n: string;
  t?: string;
  v: string;
  u?: string;
  s?: string;
  tr?: string;
  rg?: string;
}

export interface McpWebCatalog {
  source: string;
  syncedAt: string;
  count: number;
  servers: McpWebServer[];
}

export function mcpDetailBucket(name: string, buckets = MCP_DETAIL_BUCKETS) {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % buckets;
}

export function compactMcpWebCatalog(catalog: McpCatalog): McpWebCatalog {
  return {
    source: catalog.source,
    syncedAt: catalog.syncedAt,
    count: catalog.servers.length,
    servers: catalog.servers.map(compactMcpWebServer),
  };
}

export function compactMcpDetailShards(catalog: McpCatalog) {
  const shards = Array.from({ length: MCP_DETAIL_BUCKETS }, () => [] as McpServerRecord[]);
  for (const server of catalog.servers) {
    shards[mcpDetailBucket(server.name)]!.push(compactMcpDetailServer(server));
  }
  return shards;
}

function compactMcpWebServer(server: McpServerRecord): McpWebServer {
  const transports = new Set<string>();
  const registries = new Set<string>();
  for (const item of server.packages ?? []) {
    if (item.transport) transports.add(item.transport);
    if (item.registryType) registries.add(item.registryType);
  }
  for (const remote of server.remotes ?? []) {
    if (remote.type) transports.add(remote.type);
  }

  const record: McpWebServer = {
    n: server.name,
    v: server.version || "",
  };
  if (server.title) record.t = server.title;
  if (server.updatedAt) record.u = server.updatedAt.slice(0, 10);
  if (server.status && server.status !== "active") record.s = server.status;
  if (transports.size > 0) record.tr = [...transports].join(",");
  if (registries.size > 0) record.rg = [...registries].join(",");
  return record;
}

function compactMcpDetailServer(server: McpServerRecord): McpServerRecord {
  const record: McpServerRecord = {
    name: server.name,
    description: server.description || "",
    version: server.version || "",
  };
  if (server.title) record.title = server.title;
  if (server.website) record.website = server.website;
  if (server.repository) record.repository = server.repository;
  if (server.status) record.status = server.status;
  if (server.statusMessage) record.statusMessage = server.statusMessage;
  if (server.publishedAt) record.publishedAt = server.publishedAt;
  if (server.updatedAt) record.updatedAt = server.updatedAt;
  const packages = (server.packages ?? []).map((item) => ({
    registryType: item.registryType,
    identifier: item.identifier,
    ...(item.version ? { version: item.version } : {}),
    ...(item.transport ? { transport: item.transport } : {}),
  }));
  if (packages.length > 0) record.packages = packages;
  if (server.remotes && server.remotes.length > 0) record.remotes = server.remotes;
  return record;
}
