// `bun models:sync2 <provider> [--dry-run] [--json] [--raw=<file>]`

import { plan, sync } from "./engine.js";
import { anthropic } from "./providers/anthropic.js";
import { baseten } from "./providers/baseten.js";
import { chutes } from "./providers/chutes.js";
import { cortecs } from "./providers/cortecs.js";
import { deepinfra } from "./providers/deepinfra.js";
import { engy } from "./providers/engy.js";
import { fireworksAi } from "./providers/fireworks-ai.js";
import { githubCopilot } from "./providers/github-copilot.js";
import { google } from "./providers/google.js";
import { huggingface } from "./providers/huggingface.js";
import { kilo } from "./providers/kilo.js";
import { meta } from "./providers/meta.js";
import { mistral } from "./providers/mistral.js";
import { modular } from "./providers/modular.js";
import { morph } from "./providers/morph.js";
import { nanoGpt } from "./providers/nano-gpt.js";
import { nearai } from "./providers/nearai.js";
import { novitaAi } from "./providers/novita-ai.js";
import { ollamaCloud } from "./providers/ollama-cloud.js";
import { openai } from "./providers/openai.js";
import { requesty } from "./providers/requesty.js";
import { tinfoil } from "./providers/tinfoil.js";
import { venice } from "./providers/venice.js";
import { xai } from "./providers/xai.js";
import type { SyncModule, SyncResult } from "./types.js";

export const modules: Record<string, SyncModule<any>> = { anthropic, baseten, chutes, cortecs, deepinfra, engy, "fireworks-ai": fireworksAi, "github-copilot": githubCopilot, google, huggingface, kilo, meta, mistral, modular, morph, "nano-gpt": nanoGpt, nearai, "novita-ai": novitaAi, "ollama-cloud": ollamaCloud, openai, requesty, tinfoil, venice, xai };

export { plan, sync };
export type * from "./types.js";

export async function main(args = process.argv.slice(2)) {
  const id = args.find((arg) => !arg.startsWith("-"));
  const module = id === undefined ? undefined : modules[id];
  if (module === undefined) {
    console.error(`Usage: bun models:sync2 <${Object.keys(modules).join("|")}> [--dry-run] [--json] [--raw=<file>]`);
    process.exitCode = 1;
    return;
  }
  const rawFile = args.find((arg) => arg.startsWith("--raw="))?.slice("--raw=".length);
  const raw = rawFile === undefined ? undefined : await Bun.file(rawFile).json();
  const result = await sync(module, { dryRun: args.includes("--dry-run"), raw });
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(summary(module, result, args.includes("--dry-run")));
}

function summary(module: SyncModule<any>, result: SyncResult, dryRun: boolean) {
  const { counts } = result.risk;
  const lines = [
    `${dryRun ? "Dry run: " : ""}${module.name}: ${counts.created} created, ${counts.updated} updated, ${counts.deleted} deleted, ${counts.deprecated} deprecated, ${counts.gaps} gaps`,
    ...result.changes.map((change) => `  ${change.kind} ${change.path}${change.fields.length > 0 ? ` (${change.fields.map((field) => field.path).join(", ")})` : ""}`),
    ...result.gaps.map((gap) => `  gap (${gap.kind}) ${gap.model}: ${gap.reason}${gap.missing.length > 0 ? `; missing ${gap.missing.join(", ")}` : ""}`),
    ...result.notices.map((notice) => `  notice: ${notice}`),
    result.risk.safe ? "  safe to auto-merge" : `  needs review: ${result.risk.reasons.join("; ")}`,
  ];
  return lines.join("\n");
}

if (import.meta.main) await main();
