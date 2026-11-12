// `bun models:sync2 <provider> [--dry-run] [--json] [--report=<file>] [--raw=<file> | --observations=<file>]`
// `bun models:sync2 <agent provider> --agent-brief --json`
// `bun models:sync2 --list[=agents]`

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
import { deepseek } from "./providers/deepseek.js";
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
import { moonshotai } from "./providers/moonshotai.js";
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

export const modules: Record<string, SyncModule<any>> = { aiand, aimlapi, ambient, anthropic, baseten, chutes, "cloudflare-ai-gateway": cloudflareAiGateway, "cloudflare-workers-ai": cloudflareWorkersAi, cortecs, crossmodel, deepinfra, deepseek, digitalocean, edenai, empiriolabs, engy, "fireworks-ai": fireworksAi, friendli, "github-copilot": githubCopilot, google, huggingface, hyper, inceptron, kilo, llmgateway, "llmgateway-providers": llmgatewayProviders, "merge-gateway": mergeGateway, meta, mistral, modular, moonshotai, morph, "nano-gpt": nanoGpt, nearai, "novita-ai": novitaAi, ofox, "ollama-cloud": ollamaCloud, openai, openrouter, ovhcloud, pioneer, prime, requesty, tinfoil, venice, vercel, wandb, xai };

// Hosts with no API to sync from: an agent reads their docs and writes an observation file.
export const agents: Record<string, AgentModule> = { "amazon-bedrock": amazonBedrock, azure, "google-vertex": googleVertex };

export { agentBrief, parseObservations, plan, sync };
export type * from "./types.js";

export async function main(args = process.argv.slice(2)) {
  const list = args.find((arg) => arg === "--list" || arg.startsWith("--list="));
  if (list !== undefined) {
    // A GitHub Actions matrix: API modules, or agent modules with --list=agents.
    const listed = list === "--list=agents" ? agents : modules;
    console.log(JSON.stringify({ include: Object.entries(listed).map(([provider, module]) => ({ provider, name: module.name })) }));
    return;
  }
  const id = args.find((arg) => !arg.startsWith("-"));
  const module = id === undefined ? undefined : modules[id] ?? agents[id];
  const value = (flag: string) => args.find((arg) => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3);
  if (module === undefined) {
    console.error([
      `Usage: bun models:sync2 <provider> [--dry-run] [--json] [--report=<file>] [--raw=<file> | --observations=<file>]`,
      `       bun models:sync2 <agent provider> --agent-brief --json`,
      `       bun models:sync2 --list[=agents]`,
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
  const observed = observationsFile === undefined ? undefined : await parseObservations(module, answerJSON(await Bun.file(observationsFile).text()));
  const result = await sync(module, { dryRun: args.includes("--dry-run"), raw, observed });
  const reportFile = value("report");
  if (reportFile !== undefined) await Bun.write(reportFile, report(module, result));
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(summary(module, result, args.includes("--dry-run")));
}

/** An observation file, or an agent's answer whose last ```json block is one. */
export function answerJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const block = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].at(-1);
    if (block === undefined) throw new Error("The observation file is neither JSON nor an answer with a ```json block");
    return JSON.parse(block[1]!);
  }
}

/** The sync pull request's body. */
export function report(module: SyncModule<any> | AgentModule, result: SyncResult) {
  const { counts } = result.risk;
  const code = (text: string) => `\`${text.replaceAll("`", "'")}\``;
  const field = (value: unknown) => (value === undefined ? "unset" : code(JSON.stringify(value)));
  const filled = result.gaps.filter((gap) => gap.kind !== "removal");
  const removals = result.gaps.filter((gap) => gap.kind === "removal");
  const section = (title: string, lines: string[]) => (lines.length === 0 ? [] : [`### ${title}`, "", ...lines, ""]);
  return [
    `Sync for ${module.name}: ${counts.created} created, ${counts.updated} updated, ${counts.deleted} deleted, ${counts.deprecated} deprecated.`,
    "",
    ...(result.risk.safe ? [] : section("Needs review", result.risk.reasons.map((reason) => `- ${reason}`))),
    ...section("Changes", result.changes.map((change) => {
      const fields = change.fields.map((item) => `${code(item.path)} ${field(item.before)} → ${field(item.after)}`);
      return `- ${change.kind} ${code(change.path)}${fields.length > 0 ? `: ${fields.join(", ").slice(0, 2000)}` : ""}`;
    })),
    ...section("Models the sync couldn't finish", filled.map((gap) => `- ${code(gap.model)} (${gap.kind}): ${gap.reason}`)),
    ...section("Dropped by the source, kept", removals.map((gap) => `- ${code(gap.model)}: ${gap.reason}`)),
    ...section("Notices", result.notices.map((notice) => `- ${notice}`)),
    ...section("Evidence", (result.evidence ?? []).map((item) => `- ${code(item.model)} (${item.fields.join(", ") || "listed"}): "${item.quote.replaceAll("\n", " ").slice(0, 300)}" ${item.url}`)),
  ].join("\n").slice(0, 60_000);
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
