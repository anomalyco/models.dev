#!/usr/bin/env bun
// Publishes @opencode-ai/models to npm, opencode-style:
// - the version is never stored in git: it is read from npm
//   plus a semver bump computed here (patch by default);
// - `--if-changed` (scheduled data releases) skips publishing when the
//   freshly generated snapshot payload is byte-identical to the one inside
//   the currently published tarball;
// - package.json is restored after publishing.
//
// Auth: npm Trusted Publishing (OIDC) in CI — no token needed once the
// package is linked to this repo+workflow on npmjs.com. `--provenance` is
// added automatically when running in GitHub Actions.

import path from "node:path"
import { appendFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { $ } from "bun"
import { loadCatalog, snapshotPayload } from "./generate.ts"

const pkg = path.join(import.meta.dirname, "..")
const packageName = "@opencode-ai/models"
const packageJsonPath = path.join(pkg, "package.json")

const bumpArg = process.argv.find((argument) => argument.startsWith("--bump="))?.slice("--bump=".length) ?? "patch"
const ifChanged = process.argv.includes("--if-changed")

if (!["patch", "minor", "major"].includes(bumpArg)) {
  console.error(`Invalid --bump=${bumpArg}; expected patch, minor, or major`)
  process.exit(1)
}

async function currentVersion(): Promise<string> {
  return (await $`npm view ${packageName} version`.text()).trim()
}

function bump(version: string, kind: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10))
  if (kind === "major") return `${major + 1}.0.0`
  if (kind === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** The `const data = ...` line of the published dist/snapshot.js, or undefined. */
async function publishedSnapshotLine(): Promise<string | undefined> {
  const directory = await mkdtemp(path.join(tmpdir(), "models-dev-publish-"))
  try {
    const tarball = (await $`npm pack ${packageName}@latest --pack-destination ${directory}`.cwd(directory).text())
      .trim()
      .split("\n")
      .at(-1)!
    await $`tar -xzf ${path.join(directory, tarball)} -C ${directory}`
    const file = Bun.file(path.join(directory, "package", "dist", "snapshot.js"))
    if (!(await file.exists())) return undefined
    const text = await file.text()
    return text.split("\n").find((line) => line.startsWith("const data = "))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (ifChanged) {
  const catalog = await loadCatalog()
  const fresh = `const data = /* @__PURE__ */ JSON.parse(${JSON.stringify(snapshotPayload(catalog))})`
  const published = await publishedSnapshotLine()
  if (published === fresh) {
    console.log("Snapshot unchanged since the published version; skipping publish")
    process.exit(0)
  }
}

const current = await currentVersion()
const next = bump(current, bumpArg)

console.log(`Publishing ${packageName}@${next} (${bumpArg} bump from ${current})`)

const packageJsonText = await Bun.file(packageJsonPath).text()
const packageJson = JSON.parse(packageJsonText)

try {
  packageJson.version = next
  await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n")

  const provenance = process.env["GITHUB_ACTIONS"] === "true" ? ["--provenance"] : []
  await $`npm publish --access public ${provenance}`.cwd(pkg)

  const output = process.env["GITHUB_OUTPUT"]
  if (output !== undefined) await appendFile(output, `version=${next}\n`)
  console.log(`Published ${packageName}@${next}`)
} finally {
  await Bun.write(packageJsonPath, packageJsonText)
}
