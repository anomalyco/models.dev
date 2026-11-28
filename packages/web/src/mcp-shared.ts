export interface McpPackage {
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  transport?: string;
}

export interface McpRemote {
  type: string;
  url: string;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
}

export interface McpServerRecord {
  name: string;
  title?: string;
  description: string;
  version: string;
  website?: string;
  repository?: string;
  status?: "active" | "deprecated" | "deleted";
  statusMessage?: string;
  publishedAt?: string;
  updatedAt?: string;
  icon?: string;
  origin?: string;
  listing?: string;
  aliases?: string[];
  packages?: McpPackage[];
  remotes?: McpRemote[];
  tools?: McpTool[];
}

export interface McpCatalog {
  source: string;
  syncedAt: string;
  count: number;
  iranrouter?: {
    source: string;
    mcpUrl: string;
    count: number;
  };
  servers: McpServerRecord[];
}

export function mcpServerHref(name: string) {
  return `/mcp/${name}`;
}

export function mcpServerName(pathname: string) {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if (!normalized.startsWith("/mcp/")) return undefined;
  let name = normalized.slice("/mcp/".length);
  try {
    name = decodeURIComponent(name);
  } catch {
    return undefined;
  }
  if (!/^[^/]+\/[^/]+$/.test(name)) return undefined;
  return name;
}

export function mcpDisplayName(server: McpServerRecord) {
  return server.title || server.name;
}

export function mcpTransports(server: McpServerRecord) {
  const values = new Set<string>();
  for (const item of server.packages ?? []) {
    if (item.transport) values.add(item.transport);
  }
  for (const remote of server.remotes ?? []) {
    if (remote.type) values.add(remote.type);
  }
  return [...values];
}

export function mcpRegistries(server: McpServerRecord) {
  return [
    ...new Set(
      (server.packages ?? [])
        .map((item) => item.registryType)
        .filter((value) => Boolean(value)),
    ),
  ];
}

export function safeHttpUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
