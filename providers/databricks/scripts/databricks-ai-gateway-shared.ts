/**
 * Shared types and helpers for Databricks AI Gateway discovery (system.ai FMA routes).
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { z } from "zod";

const DestinationSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
});

const EndpointSchema = z.object({
  name: z.string().optional(),
  ai_gateway_url: z.string().optional(),
  config: z
    .object({
      destinations: z.array(DestinationSchema).optional(),
    })
    .optional(),
});

const EndpointsResponseSchema = z.object({
  endpoints: z.array(EndpointSchema).optional(),
});

export type Destination = z.infer<typeof DestinationSchema>;
export type Endpoint = z.infer<typeof EndpointSchema>;
export type EndpointsResponse = z.infer<typeof EndpointsResponseSchema>;

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
  const raw = await client.apiClient.request(
    {
      path: "/api/ai-gateway/v2/endpoints",
      method: "GET",
      headers: new Headers(),
      raw: false,
    },
    undefined,
  );

  const parsed = EndpointsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Unexpected response shape from /api/ai-gateway/v2/endpoints: ${parsed.error.message}`,
    );
  }

  return filterEndpoints(parsed.data.endpoints ?? []);
}

/** OpenAI-compatible base URL for chat/embeddings (no trailing slash). */
export function mlflowOpenAiBaseUrl(aiGatewayUrl: string): string {
  const u = aiGatewayUrl.replace(/\/$/, "");
  return `${u}/mlflow/v1`;
}
