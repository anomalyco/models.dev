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

    const worker = new sst.cloudflare.Worker("Server", {
      url: true,
      domain: $app.stage === "dev" ? "models.dev" : undefined,
      link: [
        new sst.Secret("PosthogToken"),
        new sst.Secret("LakeUrl"),
        new sst.Secret("LakeSecret"),
      ],
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

    return {
      url: worker.url,
    };
  },
});
