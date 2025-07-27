#!/usr/bin/env bun

import { Rendered, Providers } from "../src/render";
import fs from "fs/promises";

await fs.rm("./dist", { recursive: true, force: true });
await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "dist",
  target: "bun",
});

for await (const file of new Bun.Glob("./public/*").scan()) {
  await Bun.write(file.replace("./public/", "./dist/"), Bun.file(file));
}

// Find the HTML file with hash name
const htmlFiles = new Bun.Glob("./dist/*.html");
const htmlFile = (await Array.fromAsync(htmlFiles.scan()))[0];

if (htmlFile) {
  let html = await Bun.file(htmlFile).text();
  html = html.replace("<!--static-->", Rendered);
  await Bun.write(htmlFile, html);
  
  // Also create index.html as a copy for easier access
  await Bun.write("./dist/index.html", html);
}

await Bun.write("./dist/api.json", JSON.stringify(Providers));
