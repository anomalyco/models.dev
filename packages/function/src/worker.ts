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
