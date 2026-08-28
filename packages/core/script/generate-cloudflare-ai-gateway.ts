#!/usr/bin/env bun

import { syncProviderByID } from "../src/sync/index.js";

const check = process.argv.includes("--check");
const result = await syncProviderByID("cloudflare-ai-gateway", { dryRun: check });

if (check) {
  if (result.files.length > 0) {
    console.error(`--check: ${result.files.length} file(s) out of date`);
    process.exit(1);
  }
  console.log("--check: up to date");
}
