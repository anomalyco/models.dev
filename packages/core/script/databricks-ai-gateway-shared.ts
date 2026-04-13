/**
 * Shared types and helpers for Databricks AI Gateway discovery (system.ai FMA routes).
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";

export interface Destination {
  name?: string;
  type?: string;
}

export interface Endpoint {
  name?: string;
  ai_gateway_url?: string;
  config?: { destinations?: Destination[] };
}

export interface EndpointsResponse {
  endpoints?: Endpoint[];
}

export interface FilteredGatewayRoute {
  gateway_name: string;
  system_ai_destinations: string[];
  ai_gateway_url?: string;
}

export function isSystemAiFma(dest: Destination | undefined): boolean {
  if (!dest) return false;
  const t = dest.type ?? "";
  const name = dest.name ?? "";
  return t === "PAY_PER_TOKEN_FOUNDATION_MODEL" && name.startsWith("system.ai.");
}

export function filterEndpoints(endpoints: Endpoint[]): FilteredGatewayRoute[] {
  const out: FilteredGatewayRoute[] = [];

  for (const ep of endpoints) {
    const name = ep.name ?? "";
    if (!name.startsWith("databricks-")) continue;
    const dests = ep.config?.destinations ?? [];
    const sysAi = dests
      .filter(isSystemAiFma)
      .map((d) => d.name!)
      .filter(Boolean);
    if (sysAi.length === 0) continue;
    out.push({
      gateway_name: name,
      system_ai_destinations: sysAi,
      ai_gateway_url: ep.ai_gateway_url,
    });
  }
  out.sort((a, b) => a.gateway_name.localeCompare(b.gateway_name));
  return out;
}

export async function fetchFilteredGatewayRoutes(
  client: WorkspaceClient,
): Promise<FilteredGatewayRoute[]> {
  const raw = (await client.apiClient.request(
    {
      path: "/api/ai-gateway/v2/endpoints",
      method: "GET",
      headers: new Headers(),
      raw: false,
    },
    undefined,
  )) as EndpointsResponse;

  return filterEndpoints(raw.endpoints ?? []);
}

/** OpenAI-compatible base URL for chat/embeddings (no trailing slash). */
export function mlflowOpenAiBaseUrl(aiGatewayUrl: string): string {
  const u = aiGatewayUrl.replace(/\/$/, "");
  return `${u}/mlflow/v1`;
}
