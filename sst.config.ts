/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app() {
    return {
      name: "natepapes-com",
      home: "cloudflare",
    };
  },
  async run() {
    const worker = new sst.cloudflare.StaticSite("Site", {
      domain: $app.stage === "dev" ? "natepapes.com" : undefined,
      path: "./packages/web/",
      build: {
        output: "./dist",
        command: "./script/build.ts",
      },
    });

    return {
      url: worker.url,
    };
  },
});
