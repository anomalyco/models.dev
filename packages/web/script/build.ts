#!/usr/bin/env bun

import { RenderedPages, Providers, Models } from "../src/render";
import fs from "fs/promises";
import path from "path";

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

// Copy lab logos to dist/logos/labs/
await fs.mkdir("./dist/logos/labs", { recursive: true });

const labsDir = "../../labs";
try {
  const labEntries = await fs.readdir(labsDir, { withFileTypes: true });
  for (const entry of labEntries) {
    if (entry.isDirectory()) {
      const lab = entry.name;
      const logoPath = path.join(labsDir, lab, "logo.svg");
      const logoFile = Bun.file(logoPath);

      if (await logoFile.exists()) {
        await Bun.write(`./dist/logos/labs/${lab}.svg`, logoFile);
      }
    }
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

const template = await Bun.file("./dist/index.html").text();

for (const [route, rendered] of RenderedPages) {
  const filePath = route === "/"
    ? "./dist/_index.html"
    : path.join("./dist", route, "index.html");

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, template.replace("<!--static-->", rendered));
}

await Bun.write("./dist/api.json", JSON.stringify(Providers));
await Bun.write(
  "./dist/catalog.json",
  JSON.stringify({ models: Models, providers: Providers }),
);
await Bun.write("./dist/models.json", JSON.stringify(Models));

await fs.rename("./dist/api.json", "./dist/_api.json");
await fs.rename("./dist/catalog.json", "./dist/_catalog.json");
await fs.rename("./dist/models.json", "./dist/_models.json");

await fs.rm("./dist/index.html", { force: true });
