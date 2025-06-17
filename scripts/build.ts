#!/usr/bin/env bun

import fs from "fs/promises";
import { Rendered } from "../web/render";

await Bun.build({
  entrypoints: ["./web/index.html"],
  outdir: "dist",
  target: "bun",
});

for await (const file of new Bun.Glob("./web/assets/*").scan()) {
  await Bun.write(file.replace("./web/", "./dist/"), Bun.file(file));
}

let html = await Bun.file("./dist/index.html").text();
html = html.replace("<!--static-->", Rendered);
await Bun.write("./dist/index.html", html);
