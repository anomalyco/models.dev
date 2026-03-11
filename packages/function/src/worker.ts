export interface Env {
  ASSETS: any;
  PosthogToken: string;
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
      const providerParam = url.searchParams.get("provider");
      const flattenParam = url.searchParams.get("flatten");

      if (providerParam) {
        const apiResponse = await env.ASSETS.fetch(
          new Request(url.toString(), request),
        );
        const providers = (await apiResponse.json()) as Record<
          string,
          { models: Record<string, unknown> }
        >;

        if (providers[providerParam]) {
          const models = providers[providerParam].models;

          if (flattenParam === "true") {
            const flattened = Object.entries(models).map(
              ([id, model]) => ({ id, ...model as object }),
            );
            return new Response(JSON.stringify(flattened), {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=3600",
              },
            });
          }

          return new Response(JSON.stringify(models), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=3600",
            },
          });
        }

        return new Response(
          JSON.stringify({ error: `Provider '${providerParam}' not found` }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
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
