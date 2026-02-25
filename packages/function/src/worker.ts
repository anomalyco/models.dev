export interface Env {
  ASSETS: any;
  PosthogToken: string;
}

async function fetchAsset<T>(env: Env, path: string): Promise<T> {
  const response = await env.ASSETS.fetch(new Request(new URL(path, "http://assets.local")));
  if (!response.ok) {
    throw new Error(`Failed to fetch ${path}: ${response.status}`);
  }
  return response.json();
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const country = request.headers.get("cf-ipcountry") || "unknown";
    const agent = request.headers.get("user-agent") || "unknown";
    if (agent.includes("opencode") || agent.includes("bun")) {
      ctx.waitUntil(
        fetch("https://us.i.posthog.com/i/v0/e/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            api_key: JSON.parse(env.PosthogToken).value,
            event: "hit",
            distinct_id: ip,
            properties: {
              $process_person_profile: false,
              user_agent: agent,
              country,
              path: url.pathname,
            },
          }),
        }),
      );
    }

    // Search API endpoint
    if (url.pathname === "/search") {
      const query = url.searchParams.get("q")?.toLowerCase() || "";
      const providerFilter = url.searchParams.get("provider")?.toLowerCase() || "";
      const limit = parseInt(url.searchParams.get("limit") || "") || undefined;

      try {
        // Load search index and providers metadata
        const [searchIndex, providersMeta] = await Promise.all([
          fetchAsset<Array<{ p: string; m: string; n: string }>>(env, "/_search-index.json"),
          fetchAsset<Record<string, { id: string; name: string; env: string[]; npm: string; api?: string; doc: string }>>(env, "/_providers.json"),
        ]);

        // Filter matches
        const matches: Array<{ p: string; m: string }> = [];
        for (const item of searchIndex) {
          if (providerFilter && item.p.toLowerCase() !== providerFilter) continue;
          if (query && !item.m.toLowerCase().includes(query) && !item.n.toLowerCase().includes(query)) continue;
          matches.push({ p: item.p, m: item.m });
          if (limit && matches.length >= limit) break;
        }

        if (matches.length === 0) {
          return new Response(JSON.stringify({ total: 0, results: [] }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Fetch model details in parallel
        const modelPromises = matches.map((match) => {
          const safeModelId = match.m.replace(/\//g, "__");
          return fetchAsset(env, `/_models/${match.p}/${safeModelId}.json`);
        });
        const models = await Promise.all(modelPromises);

        // Build response (align with api.json structure)
        const results: Record<string, { id: string; name: string; env: string[]; npm: string; api?: string; doc: string; models: Record<string, any> }> = {};
        for (let i = 0; i < matches.length; i++) {
          const match = matches[i];
          const providerMeta = providersMeta[match.p];
          if (!results[match.p]) {
            results[match.p] = {
              ...providerMeta,
              models: {},
            };
          }
          results[match.p].models[match.m] = models[i];
        }

        return new Response(JSON.stringify({ total: matches.length, results }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return new Response(JSON.stringify({ error: "Search failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname === "/model-schema.json") {
      const apiUrl = new URL(url);
      apiUrl.pathname = "/_api.json";
      const apiResponse = await env.ASSETS.fetch(
        new Request(apiUrl.toString(), request),
      );
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
      url.pathname = "/_api.json";
    } else if (
      url.pathname === "/" ||
      url.pathname === "/index.html" ||
      url.pathname === "/index"
    ) {
      url.pathname = "/_index";
    } else if (url.pathname.startsWith("/logos/")) {
      // Check if the specific provider logo exists in static assets
      const logoResponse = await env.ASSETS.fetch(new Request(url.toString(), request));

      if (logoResponse.status === 404) {
        // Fallback to default logo
        const defaultUrl = new URL(url);
        defaultUrl.pathname = "/logos/default.svg";
        return await env.ASSETS.fetch(new Request(defaultUrl.toString(), request));
      }

      return logoResponse;
    } else {
      // redirect to "/"
      return new Response(null, {
        status: 302,
        headers: { Location: "/" },
      });
    }

    return await env.ASSETS.fetch(new Request(url.toString(), request));
  },
};
