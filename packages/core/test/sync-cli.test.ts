import { expect, test } from "bun:test";

import { main } from "../src/sync/index.js";

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]) => void out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => void err.push(parts.join(" "));
  const exitCode = process.exitCode;
  try {
    await main(args);
    return { out: out.join("\n"), err: err.join("\n"), exitCode: process.exitCode };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exitCode;
  }
}

test("--help prints usage instead of syncing", async () => {
  for (const flag of ["--help", "-h"]) {
    const result = await run([flag]);
    expect(result.out).toContain("Usage:");
    expect(result.out).not.toContain("Sync summary");
  }
});

test("an unknown flag fails instead of syncing the default target", async () => {
  const result = await run(["--hlep"]);
  expect(result.err).toContain("Unknown flag: --hlep");
  expect(result.out).not.toContain("Sync summary");
  expect(result.exitCode).toBe(1);
});
