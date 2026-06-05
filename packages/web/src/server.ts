import Index from "../index.html";
import { getRenderedPage, Models, Providers } from "./render";
import path from "path";

const assetPort = Number(Bun.env.ASSET_PORT ?? 16000);

Bun.serve({
  port: assetPort,
  routes: {
    "/": Index,
    "/src/*": (req) => {
      const url = new URL(req.url);
      const file = Bun.file(
        path.join(import.meta.dir, "..", url.pathname.slice(1)),
      );
      return new Response(file);
    },
    "/favicon.svg": () =>
      new Response(Bun.file(path.join(import.meta.dir, "..", "public/favicon.svg")), {
        headers: {
          "Content-Type": "image/svg+xml",
        },
      }),
    "/social-share.png": () =>
      new Response(Bun.file(path.join(import.meta.dir, "..", "public/social-share.png")), {
        headers: {
          "Content-Type": "image/png",
        },
      }),
    "/assets/*": (req) => {
      const file = Bun.file(
        path.join(import.meta.dir, new URL(req.url).pathname)
      );
      return new Response(file);
    },
    "/logos/*": async (req) => {
      const url = new URL(req.url);
      const provider = url.pathname.split("/")[2].replace(".svg", "");
      const logoPath = path.join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "providers",
        provider,
        "logo.svg"
      );
      const defaultLogoPath = path.join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "providers",
        "logo.svg"
      );

      let file = Bun.file(logoPath);
      if (!(await file.exists())) {
        file = Bun.file(defaultLogoPath);
      }

      return new Response(file, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=3600",
        },
      });
    },
    "/api.json": () =>
      Response.json(Providers, {
        headers: {
          "Cache-Control": "public, max-age=3600",
        },
      }),
    "/models.json": () =>
      Response.json(Models, {
        headers: {
          "Cache-Control": "public, max-age=3600",
        },
      }),
    "/catalog.json": () =>
      Response.json(
        { models: Models, providers: Providers },
        {
          headers: {
            "Cache-Control": "public, max-age=3600",
          },
        },
      ),
  },
});

const server = Bun.serve({
  development: true,
  hostname: "0.0.0.0",
  port: Number(Bun.env.PORT ?? 3000),
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
    const rendered = getRenderedPage(url.pathname);
    if (rendered !== undefined) {
      const shellUrl = new URL(url);
      shellUrl.host = `localhost:${assetPort}`;
      shellUrl.pathname = "/";
      shellUrl.search = "";

      let html = await fetch(shellUrl.toString(), req).then((r) => r.text());
      html = html.replace("<!--static-->", rendered);
      return new Response(html, {
        headers: {
          "Content-Type": "text/html",
        },
      });
    }

    url.host = `localhost:${assetPort}`;
    return fetch(url.toString(), req);
  },
});

console.log(`Server running at ${server.hostname}:${server.port}`);
