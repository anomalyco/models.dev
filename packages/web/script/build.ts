#!/usr/bin/env bun

import { Rendered, Providers, Models } from "../src/render";
import fs from "fs/promises";
import path from "path";
import { $ } from "bun";

await fs.rm("./dist", { recursive: true, force: true });
await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "dist",
  target: "bun",
});

for await (const file of new Bun.Glob("./public/*").scan()) {
  await Bun.write(file.replace("./public/", "./dist/"), Bun.file(file));
}

// Copy provider logos to dist/logos/
await fs.mkdir("./dist/logos", { recursive: true });

// First, copy the default logo
const defaultLogoPath = "../../providers/logo.svg";
const defaultLogo = Bun.file(defaultLogoPath);
if (await defaultLogo.exists()) {
  await Bun.write("./dist/logos/default.svg", defaultLogo);
}

// Then copy provider-specific logos
const providersDir = "../../providers";
const entries = await fs.readdir(providersDir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory()) {
    const provider = entry.name;
    const logoPath = path.join(providersDir, provider, "logo.svg");
    const logoFile = Bun.file(logoPath);

    if (await logoFile.exists()) {
      await Bun.write(`./dist/logos/${provider}.svg`, logoFile);
    }
  }
}

let html = await Bun.file("./dist/index.html").text();
html = html.replace("<!--static-->", Rendered);
await Bun.write("./dist/index.html", html);
await Bun.write("./dist/api.json", JSON.stringify(Providers));
await Bun.write(
  "./dist/catalog.json",
  JSON.stringify({ models: Models, providers: Providers }),
);
await Bun.write("./dist/models.json", JSON.stringify(Models));

await $`mv ./dist/index.html ./dist/_index.html`;
await $`mv ./dist/api.json ./dist/_api.json`;
await $`mv ./dist/catalog.json ./dist/_catalog.json`;
await $`mv ./dist/models.json ./dist/_models.json`;
