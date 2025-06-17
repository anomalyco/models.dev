import Index from "./index.html";
import { Rendered } from "./render";
import path from "path";

Bun.serve({
  port: 16_000,
  routes: {
    "/": Index,
    "/assets/*": (req) => {
      const file = Bun.file(
        path.join(import.meta.dir, new URL(req.url).pathname),
      );
      return new Response(file);
    },
  },
});

export const server = Bun.serve({
  development: true,
  async fetch(req) {
    // Reject WebSocket upgrade requests
    if (req.headers.get("upgrade") === "websocket") {
      return new Response("WebSocket upgrades not supported", {
        status: 426,
        headers: {
          Upgrade: "Required",
        },
      });
    }

    const url = new URL(req.url);
    url.host = "localhost:16000";
    const result = fetch(url.toString(), req);

    if (url.pathname !== "/") return result;

    let html = await result.then((r) => r.text());
    html = html.replace("<!--static-->", Rendered);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html",
      },
    });
  },
});
