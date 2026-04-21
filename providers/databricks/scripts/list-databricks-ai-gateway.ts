#!/usr/bin/env bun
/**
 * List Databricks AI Gateway routes aligned with Unity Catalog system.ai foundation models.
 *
 * Uses Databricks WorkspaceClient (JavaScript SDK; same auth patterns as ~/.databrickscfg, profiles, env).
 *
 * Usage (from repo root):
 *   bun run databricks:list-gateway -- --profile YOUR_PROFILE
 *   bun run databricks:list-gateway -- --profile YOUR_PROFILE --json
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { fetchFilteredGatewayRoutes } from "./databricks-ai-gateway-shared.js";

function parseArgs() {
  const argv = process.argv.slice(2);
  let profile = process.env.DATABRICKS_CONFIG_PROFILE;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile" && argv[i + 1]) {
      profile = argv[++i];
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log(`Usage: list-databricks-ai-gateway.ts [--profile NAME] [--json]

  --profile   Databricks config profile (~/.databrickscfg). Default: DATABRICKS_CONFIG_PROFILE or SDK default chain.
  --json      Print JSON array instead of TSV lines.
`);
      process.exit(0);
    }
  }
  return { profile, json };
}

async function main() {
  const { profile, json } = parseArgs();

  const client = new WorkspaceClient(profile ? { profile } : {});
  const rows = await fetchFilteredGatewayRoutes(client);

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const hostUrl = (await client.apiClient.host).toString();
  console.log(`# host: ${hostUrl}`);
  console.log(`# count: ${rows.length}\n`);
  for (const r of rows) {
    console.log(`${r.gateway_name}\t${r.system_ai_destinations.join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
