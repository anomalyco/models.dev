#!/usr/bin/env bun
// Builds dist/: regenerates snapshot + generated types, compiles with tsc,
// and copies the snapshot module (which tsc does not process) into dist.

import path from "node:path"
import { rm } from "node:fs/promises"
import { $ } from "bun"
import { generate } from "./generate.ts"

const pkg = path.join(import.meta.dirname, "..")
const dist = path.join(pkg, "dist")

export async function build() {
  await generate()
  await rm(dist, { recursive: true, force: true })
  await $`bunx tsc -p tsconfig.build.json`.cwd(pkg)
  await Bun.write(path.join(dist, "snapshot.js"), Bun.file(path.join(pkg, "src", "snapshot.js")))
  await Bun.write(path.join(dist, "snapshot.d.ts"), Bun.file(path.join(pkg, "src", "snapshot.d.ts")))
}

if (import.meta.main) {
  await build()
  console.log("built dist/")
}
