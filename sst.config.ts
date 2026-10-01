/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app() {
    return {
      name: "models-dev",
      home: "cloudflare",
    };
  },
  async run() {
    const { spawnSync } = await import("child_process");

    const ret = spawnSync("./script/build.ts", [], {
      cwd: "./packages/web",
      stdio: "inherit",
    });
    if (ret.status !== 0) throw new Error("Build failed");

    const posthog = new sst.Secret("PosthogToken");
    const endpoint = new sst.Secret("LakeEndpoint");
    const token = new sst.Secret("LakeToken");
    const worker = new sst.cloudflare.Worker("Server", {
      url: true,
      domain: $app.stage === "dev" ? "models.dev" : undefined,
      link: $resolve([endpoint.value, token.value]).apply((values) => {
        if (!/^https:\/\/[a-f0-9]{32}\.ingest\.cloudflare\.com\/?$/.test(values[0]))
          throw new Error("LakeEndpoint must be a Cloudflare stream endpoint");
        if (!values[1].trim()) throw new Error("LakeToken must not be empty");
        return [posthog, endpoint, token];
      }),
      handler: "./packages/function/src/worker.ts",
      assets: {
        directory: "./packages/web/dist",
      },
      transform: {
        worker: {
          observability: { enabled: true },
        },
      },
    });

    if ($app.stage === "dev") {
      const zone = cloudflare.getZoneOutput({
        filter: {
          account: { id: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID! },
          name: "opencode.ai",
        },
      });

      new cloudflare.WorkersCustomDomain("OpenCodeDomain", {
        accountId: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID!,
        environment: "production",
        hostname: "models.opencode.ai",
        service: worker.nodes.worker.scriptName,
        zoneId: zone.zoneId,
      });
    }

    return {
      url: worker.url,
    };
  },
});
