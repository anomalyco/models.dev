import { classifyAutoMerge, parseNameStatus } from "../src/sync/auto-merge.js";

const base = process.argv[2] ?? "HEAD^";
const head = process.argv[3] ?? "HEAD";
const diff = Bun.spawnSync(["git", "diff", "--name-status", base, head], {
  stdout: "pipe",
  stderr: "inherit",
});

if (diff.exitCode !== 0) process.exit(diff.exitCode);

const decision = await classifyAutoMerge(parseNameStatus(diff.stdout.toString()));
const summary = decision.safe
  ? `Safe to auto-merge: ${decision.created} created, ${decision.updated} updated, ${decision.deleted} deleted.`
  : `Manual review required: ${decision.reasons.join("; ")}.`;

console.log(summary);
if (process.env.GITHUB_OUTPUT) {
  await Bun.write(Bun.file(process.env.GITHUB_OUTPUT), `safe=${decision.safe}\nsummary=${summary}\n`, { createPath: true });
}
