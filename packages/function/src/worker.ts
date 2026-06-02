export interface Env {
  ASSETS: any;
  PosthogToken: string;
  LakeUrl: string;
  LakeSecret: string;
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
    const time = new Date().toISOString();
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
        fetch(JSON.parse(env.LakeUrl).value, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${JSON.parse(env.LakeSecret).value}`,
          },
          body: JSON.stringify({
            events: [
              {
                _datalake_key: "inference.event",
                event_timestamp: time,
                event_date: time.slice(0, 10),
                event_type: "models.hit",
                ip: string(ip),
                ip_prefix: string(ipPrefix(ip)),
                user_agent: string(agent),
                cf_country: string(country),
                path: string(url.pathname),
              },
            ],
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
    } else if (
      url.pathname === "/" ||
      url.pathname === "/index.html" ||
      url.pathname === "/index"
    ) {
      url.pathname = "/_index";
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

// Returns a stable lookup key for an IP address.
// IPv4: full address as /32 (e.g. "203.0.113.45/32").
// IPv6: the /64 network prefix (e.g. "2001:db8:abcd:1234::/64"). ISPs commonly
// rotate the lower 64 host bits via SLAAC privacy extensions (RFC 8981), so
// grouping by /64 collapses those rotations into one key.
function ipPrefix(ip: string | undefined) {
  if (!ip) return undefined;
  if (ip.includes(".") && !ip.includes(":")) return `${ip}/32`;
  if (!ip.includes(":")) return undefined;

  // Expand "::" to its full form, then keep the first 4 hextets.
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return undefined;
  const full = [...headParts, ...new Array(missing).fill("0"), ...tailParts];
  if (full.length !== 8) return undefined;

  const prefix = full
    .slice(0, 4)
    .map((part) => part.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":");
  return `${prefix}::/64`;
}

function string(value: string | undefined) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return undefined;
}
