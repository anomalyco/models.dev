// `bun models:sync2 <provider> [--dry-run] [--json] [--raw=<file> | --observations=<file>]`
// `bun models:sync2 <agent provider> --agent-brief --json`

import { agentBrief, parseObservations } from "./agent.js";
import { plan, sync } from "./engine.js";
import { aiand } from "./providers/aiand.js";
import { aimlapi } from "./providers/aimlapi.js";
import { amazonBedrock } from "./providers/amazon-bedrock.js";
import { ambient } from "./providers/ambient.js";
import { anthropic } from "./providers/anthropic.js";
import { azure } from "./providers/azure.js";
import { baseten } from "./providers/baseten.js";
import { chutes } from "./providers/chutes.js";
import { cloudflareAiGateway } from "./providers/cloudflare-ai-gateway.js";
import { cloudflareWorkersAi } from "./providers/cloudflare-workers-ai.js";
import { cortecs } from "./providers/cortecs.js";
import { crossmodel } from "./providers/crossmodel.js";
import { deepinfra } from "./providers/deepinfra.js";
import { digitalocean } from "./providers/digitalocean.js";
import { edenai } from "./providers/edenai.js";
import { empiriolabs } from "./providers/empiriolabs.js";
import { engy } from "./providers/engy.js";
import { fireworksAi } from "./providers/fireworks-ai.js";
import { friendli } from "./providers/friendli.js";
import { githubCopilot } from "./providers/github-copilot.js";
import { google } from "./providers/google.js";
import { googleVertex } from "./providers/google-vertex.js";
import { huggingface } from "./providers/huggingface.js";
import { hyper } from "./providers/hyper.js";
import { inceptron } from "./providers/inceptron.js";
import { kilo } from "./providers/kilo.js";
import { llmgateway, llmgatewayProviders } from "./providers/llmgateway.js";
import { mergeGateway } from "./providers/merge-gateway.js";
import { meta } from "./providers/meta.js";
import { mistral } from "./providers/mistral.js";
import { modular } from "./providers/modular.js";
import { morph } from "./providers/morph.js";
import { nanoGpt } from "./providers/nano-gpt.js";
import { nearai } from "./providers/nearai.js";
import { novitaAi } from "./providers/novita-ai.js";
import { ofox } from "./providers/ofox.js";
import { ollamaCloud } from "./providers/ollama-cloud.js";
import { openai } from "./providers/openai.js";
import { openrouter } from "./providers/openrouter.js";
import { ovhcloud } from "./providers/ovhcloud.js";
import { pioneer } from "./providers/pioneer.js";
import { prime } from "./providers/prime.js";
import { requesty } from "./providers/requesty.js";
import { tinfoil } from "./providers/tinfoil.js";
import { venice } from "./providers/venice.js";
import { vercel } from "./providers/vercel.js";
import { wandb } from "./providers/wandb.js";
import { xai } from "./providers/xai.js";
import type { AgentModule, SyncModule, SyncResult } from "./types.js";

export const modules: Record<string, SyncModule<any>> = { aiand, aimlapi, ambient, anthropic, baseten, chutes, "cloudflare-ai-gateway": cloudflareAiGateway, "cloudflare-workers-ai": cloudflareWorkersAi, cortecs, crossmodel, deepinfra, digitalocean, edenai, empiriolabs, engy, "fireworks-ai": fireworksAi, friendli, "github-copilot": githubCopilot, google, huggingface, hyper, inceptron, kilo, llmgateway, "llmgateway-providers": llmgatewayProviders, "merge-gateway": mergeGateway, meta, mistral, modular, morph, "nano-gpt": nanoGpt, nearai, "novita-ai": novitaAi, ofox, "ollama-cloud": ollamaCloud, openai, openrouter, ovhcloud, pioneer, prime, requesty, tinfoil, venice, vercel, wandb, xai };

// Hosts with no API to sync from: an agent reads their docs and writes an observation file.
export const agents: Record<string, AgentModule> = { "amazon-bedrock": amazonBedrock, azure, "google-vertex": googleVertex };

export { agentBrief, parseObservations, plan, sync };
export type * from "./types.js";

export async function main(args = process.argv.slice(2)) {
  const id = args.find((arg) => !arg.startsWith("-"));
  const module = id === undefined ? undefined : modules[id] ?? agents[id];
  const value = (flag: string) => args.find((arg) => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3);
  if (module === undefined) {
    console.error([
      `Usage: bun models:sync2 <provider> [--dry-run] [--json] [--raw=<file> | --observations=<file>]`,
      `       bun models:sync2 <agent provider> --agent-brief --json`,
      `Providers: ${Object.keys(modules).join(", ")}`,
      `Agent providers (run from --observations only): ${Object.keys(agents).join(", ")}`,
    ].join("\n"));
    process.exitCode = 1;
    return;
  }
  if (args.includes("--agent-brief")) {
    if (module.kind !== "agent") throw new Error(`${module.name} syncs from its API; --agent-brief is for agent providers (${Object.keys(agents).join(", ")})`);
    console.log(JSON.stringify(await agentBrief(module), null, 2));
    return;
  }
  const rawFile = value("raw");
  const observationsFile = value("observations");
  if (rawFile !== undefined && observationsFile !== undefined) throw new Error("Pass --raw or --observations, not both");
  if (module.kind === "agent" && observationsFile === undefined) throw new Error(`${module.name} is an agent provider; pass --observations=<file>`);
  const raw = rawFile === undefined ? undefined : await Bun.file(rawFile).json();
  const observed = observationsFile === undefined ? undefined : await parseObservations(module, await Bun.file(observationsFile).json());
  const result = await sync(module, { dryRun: args.includes("--dry-run"), raw, observed });
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(summary(module, result, args.includes("--dry-run")));
}

function summary(module: SyncModule<any> | AgentModule, result: SyncResult, dryRun: boolean) {
  const { counts } = result.risk;
  const lines = [
    `${dryRun ? "Dry run: " : ""}${module.name}: ${counts.created} created, ${counts.updated} updated, ${counts.deleted} deleted, ${counts.deprecated} deprecated, ${counts.gaps} gaps`,
    ...result.changes.map((change) => `  ${change.kind} ${change.path}${change.fields.length > 0 ? ` (${change.fields.map((field) => field.path).join(", ")})` : ""}`),
    ...result.gaps.map((gap) => `  gap (${gap.kind}) ${gap.model}: ${gap.reason}${gap.missing.length > 0 ? `; missing ${gap.missing.join(", ")}` : ""}`),
    ...result.notices.map((notice) => `  notice: ${notice}`),
    ...(result.evidence ?? []).map((item) => `  evidence ${item.model} (${item.fields.join(", ") || "listed"}): ${item.url}`),
    result.risk.safe ? "  safe to auto-merge" : `  needs review: ${result.risk.reasons.join("; ")}`,
  ];
  return lines.join("\n");
}

if (import.meta.main) await main();
