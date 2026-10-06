import {
  filterCatalogByModelType,
  filterModelsByModelType,
  filterProvidersByModelType,
  InvalidModelTypeError,
  MODEL_TYPES,
  parseModelTypes,
} from "@models.dev/core/src/filter.js";
import type { ModelTypeValue } from "@models.dev/core/src/filter.js";
import { hitEvent } from "@models.dev/core/src/hit.js";

export interface Env {
  ASSETS: any;
  PosthogToken: string;
  LakeEndpoint: string;
  LakeToken: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get("cf-connecting-ip") ?? undefined;
    const country = request.headers.get("cf-ipcountry") ?? undefined;
    const agent = request.headers.get("user-agent") ?? undefined;
    if (agent?.includes("opencode") || agent?.includes("bun")) {
      ctx.waitUntil(
        fetch("https://us.i.posthog.com/i/v0/e/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            api_key: JSON.parse(env.PosthogToken).value,
            event: "hit",
            distinct_id: ip ?? "unknown",
            properties: {
              $process_person_profile: false,
              user_agent: agent ?? "unknown",
              country: country ?? "unknown",
              path: url.pathname,
            },
          }),
        }),
      );

      ctx.waitUntil(
        sendHit(
          JSON.parse(env.LakeEndpoint).value,
          JSON.parse(env.LakeToken).value,
          JSON.stringify([
            hitEvent(new Date().toISOString(), {
              method: request.method,
              path: url.pathname,
              useragent: agent,
              ip,
              cf_country: country,
            }),
          ]),
        ),
      );
    }

    if (url.pathname === "/model-schema.json") {
      const apiResponse = await catalogResponse(url, request, env, "api");
      if (!apiResponse.ok) return apiResponse;
      const providers = (await apiResponse.json()) as Record<
        string,
        { models: Record<string, unknown> }
      >;

      const modelIds: string[] = [];
      for (const [providerId, provider] of Object.entries(providers)) {
        for (const modelId of Object.keys(provider.models)) {
          modelIds.push(`${providerId}/${modelId}`);
        }
      }

      const schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://models.dev/model-schema.json",
        $defs: {
          Model: {
            type: "string",
            enum: modelIds.sort(),
            description: "AI model identifier in provider/model format",
          },
        },
      };

      return new Response(JSON.stringify(schema, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    if (url.pathname === "/api.json") {
      return catalogResponse(url, request, env, "api");
    } else if (url.pathname === "/models.json") {
      return catalogResponse(url, request, env, "models");
    } else if (url.pathname === "/catalog.json") {
      return catalogResponse(url, request, env, "catalog");
    } else if (
      url.pathname === "/" ||
      url.pathname === "/index.html" ||
      url.pathname === "/index"
    ) {
      url.pathname = "/_index";
    } else if (isHtmlRoute(url.pathname)) {
      url.pathname = htmlRouteAssetPath(url.pathname);
    } else if (url.pathname.startsWith("/logos/")) {
      // Check if the specific provider logo exists in static assets
      const logoResponse = await env.ASSETS.fetch(
        new Request(url.toString(), request),
      );

      if (logoResponse.status === 404) {
        // Fallback to default logo
        const defaultUrl = new URL(url);
        defaultUrl.pathname = "/logos/default.svg";
        return await env.ASSETS.fetch(
          new Request(defaultUrl.toString(), request),
        );
      }

      return logoResponse;
    }

    const response = await env.ASSETS.fetch(
      new Request(url.toString(), request),
    );
    if (response.status !== 404) return response;

    return new Response(null, {
      status: 302,
      headers: { Location: "/" },
    });
  },
};

async function sendHit(endpoint: string, token: string, body: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
    await response?.body?.cancel();
    if (response?.ok) return;
    const retryable =
      !response || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2)
      throw new Error(
        `Lake hit delivery failed: ${response?.status ?? "network error"}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
}

type CatalogEndpoint = "api" | "models" | "catalog";

async function catalogResponse(
  url: URL,
  request: Request,
  env: Env,
  endpoint: CatalogEndpoint,
) {
  let filter;
  try {
    filter = parseModelTypes(url.searchParams.get("type"));
  } catch (error) {
    if (!(error instanceof InvalidModelTypeError)) throw error;
    return Response.json(
      {
        error: error.message,
        allowed: [...MODEL_TYPES, "all"],
      },
      {
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
      },
    );
  }

  const assetUrl = new URL(url);
  const suffix = filter === "default"
    ? ""
    : filter === "all"
      ? "-all"
      : filter.length === 1
        ? `-${filter[0]}`
        : undefined;
  assetUrl.pathname = `/_${endpoint}${suffix ?? "-all"}.json`;
  assetUrl.search = "";
  const assetResponse = await env.ASSETS.fetch(
    new Request(assetUrl.toString(), request),
  );
  if (!assetResponse.ok || suffix !== undefined) return assetResponse;

  const value = await assetResponse.json();
  const filtered = endpoint === "api"
    ? filterProvidersByModelType(
        value as Record<string, CatalogProvider>,
        filter,
      )
    : endpoint === "models"
      ? filterModelsByModelType(
          value as Record<string, CatalogModel>,
          filter,
        )
      : filterCatalogByModelType(
          value as {
            providers: Record<string, CatalogProvider>;
            models: Record<string, CatalogModel>;
          },
          filter,
        );

  const headers = new Headers(assetResponse.headers);
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(JSON.stringify(filtered), { headers });
}

interface CatalogModel {
  type?: ModelTypeValue;
}

interface CatalogProvider {
  models: Record<string, CatalogModel>;
}

function isHtmlRoute(pathname: string) {
  return (
    pathname === "/models" ||
    pathname === "/providers" ||
    pathname === "/labs" ||
    pathname.startsWith("/models/") ||
    pathname.startsWith("/providers/") ||
    pathname.startsWith("/labs/")
  );
}

function htmlRouteAssetPath(pathname: string) {
  const normalized =
    pathname !== "/" && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return `${normalized}/index.html`;
}
