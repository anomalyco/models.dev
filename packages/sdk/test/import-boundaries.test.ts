// Enforces the package's structural promises:
// - the root client has zero dependencies (no effect, no zod, no core) and
//   never touches the snapshot;
// - the snapshot entrypoint is fully self-contained (imports nothing);
// - the effect client pulls in effect but nothing else.
//
// Implementation modules are bundled with local files inlined and packages
// kept external, so any package dependency must surface as an import
// statement in the output. The barrel entrypoints are checked statically
// (bun currently over-shakes re-export-only entrypoints of sideEffects:false
// packages, so bundling them directly would test nothing).

import { expect, test } from "bun:test"
import path from "node:path"

const src = path.join(import.meta.dirname, "..", "src")

// A string that only ever appears in the snapshot payload.
const SNAPSHOT_SENTINEL = '\\"302ai\\"'

async function bundle(entrypoint: string) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    packages: "external",
    throw: true,
  })
  const output = await result.outputs[0]!.text()
  const imports = [...output.matchAll(/^(?:import|export)[^"'\n]*["']([^"'\n]+)["'];?\s*$/gm)].map(
    (match) => match[1]!,
  )
  return { output, imports }
}

async function specifiers(file: string) {
  const source = await Bun.file(path.join(src, file)).text()
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]!)
}

test("root client bundles with no package imports and no snapshot", async () => {
  const { output, imports } = await bundle(path.join(src, "client.ts"))
  expect(imports).toEqual([])
  expect(output.includes(SNAPSHOT_SENTINEL)).toBe(false)
  expect(output.length).toBeLessThan(100_000)
})

test("root barrel only re-exports zero-dependency local modules", async () => {
  const allowed = ["./client.js", "./error.js", "./generated.js", "./types.js"]
  for (const specifier of await specifiers("index.ts")) {
    expect(allowed).toContain(specifier)
  }
})

test("snapshot entrypoint is self-contained", async () => {
  const { imports } = await bundle(path.join(src, "snapshot.js"))
  expect(imports).toEqual([])
})

test("effect client bundles with only effect imports", async () => {
  const { output, imports } = await bundle(path.join(src, "effect", "client.ts"))
  expect(imports.length).toBeGreaterThan(0)
  expect(imports.every((specifier) => specifier === "effect" || specifier.startsWith("effect/"))).toBe(true)
  expect(output.includes(SNAPSHOT_SENTINEL)).toBe(false)
})

test("effect barrel only re-exports the effect client and local types", async () => {
  const allowed = ["./effect/client.js", "./generated.js", "./types.js"]
  for (const specifier of await specifiers("effect.ts")) {
    expect(allowed).toContain(specifier)
  }
})
