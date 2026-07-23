export interface MissingModelIssueTarget {
  id: string;
  name: string;
  modelsDir: string;
}

export interface OpenMissingModelIssuesOptions {
  dryRun?: boolean;
}

function issueTitle(providerId: string, modelId: string) {
  return `[missing-model] ${providerId}: ${modelId}`;
}

function issueBody(provider: MissingModelIssueTarget, modelId: string) {
  return [
    `The **${provider.name}** catalog sync found remote model \`${modelId}\` that is not in the local catalog.`,
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| Provider | \`${provider.id}\` |`,
    `| Model ID | \`${modelId}\` |`,
    `| Expected path | \`${provider.modelsDir}/${modelId}.toml\` |`,
    "",
    "This provider uses `skipCreates` because the remote source is not enough to auto-author a full TOML.",
    "Add the model manually (prefer `base_model` when matching `models/` metadata exists).",
    "",
  ].join("\n");
}

/** Open one deduped GitHub issue per missing model ID (title-stable). */
export async function openMissingModelIssues(
  provider: MissingModelIssueTarget,
  modelIds: string[],
  options: OpenMissingModelIssuesOptions = {},
): Promise<string[]> {
  const ids = [...new Set(modelIds)].filter((id) => id.length > 0).sort();
  if (ids.length === 0) return [];

  const notices: string[] = [];
  const labels = ["automation", "model-sync", "missing-model", `provider:${provider.id}`];

  if (options.dryRun) {
    for (const modelId of ids) {
      const notice = `Would open GitHub issue for missing model \`${modelId}\` (\`${issueTitle(provider.id, modelId)}\`)`;
      notices.push(notice);
      console.log(notice);
    }
    return notices;
  }

  // Fail closed before listing/creating: a label failure here would otherwise
  // surface as one opaque `gh issue create` error per model.
  for (const label of labels) {
    const result = await runGh([
      "label",
      "create",
      label,
      "--color",
      "0E8A16",
      "--description",
      "Automated model catalog sync",
      "--force",
    ]);
    if (result.code !== 0) {
      throw new Error(`gh label create ${label} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
    }
  }

  const existingByTitle = await listTrackedTitles(provider.id);

  for (const modelId of ids) {
    const title = issueTitle(provider.id, modelId);
    const existing = existingByTitle.get(title);
    if (existing !== undefined) {
      const notice = `Missing model \`${modelId}\` already tracked by #${existing}`;
      notices.push(notice);
      console.log(notice);
      continue;
    }

    try {
      const number = await createIssue(title, issueBody(provider, modelId), labels);
      existingByTitle.set(title, number);
      const notice = `Opened GitHub issue #${number} for missing model \`${modelId}\``;
      notices.push(notice);
      console.log(notice);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const notice = `Failed to open GitHub issue for missing model \`${modelId}\`: ${message}`;
      notices.push(notice);
      console.error(notice);
    }
  }

  return notices;
}

const LIST_LIMIT = 1000;

async function listTrackedTitles(providerId: string) {
  // Include closed so a wontfix/closed issue does not reopen hourly.
  const result = await runGh([
    "issue",
    "list",
    "--state",
    "all",
    "--label",
    "missing-model",
    "--label",
    `provider:${providerId}`,
    "--limit",
    String(LIST_LIMIT),
    "--json",
    "number,title",
  ]);
  if (result.code !== 0) {
    throw new Error(`gh issue list failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }

  const issues = JSON.parse(result.stdout || "[]") as Array<{ number: number; title: string }>;
  // Fail closed when the window is full: older titles may have been truncated,
  // and creating against an incomplete list could reopen duplicates.
  if (issues.length >= LIST_LIMIT) {
    throw new Error(
      `gh issue list returned ${issues.length} issues (window limit ${LIST_LIMIT}); refusing to create against a possibly truncated dedupe list`,
    );
  }
  return new Map(issues.map((issue) => [issue.title, issue.number]));
}

async function createIssue(title: string, body: string, labels: string[]) {
  const args = ["issue", "create", "--title", title, "--body", body];
  for (const label of labels) args.push("--label", label);
  const result = await runGh(args);
  if (result.code !== 0) {
    throw new Error(`gh issue create failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }

  const url = result.stdout.trim();
  const number = url.match(/\/issues\/(\d+)\s*$/)?.[1] ?? url.match(/#(\d+)\s*$/)?.[1];
  if (number === undefined) {
    throw new Error(`gh issue create returned no issue number: ${url}`);
  }
  return Number(number);
}

async function runGh(args: string[]) {
  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}
