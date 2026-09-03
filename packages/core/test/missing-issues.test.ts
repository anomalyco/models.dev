import { expect, spyOn, test } from "bun:test";

import { openMissingModelIssues } from "../src/sync/missing-issues.js";

const provider = { id: "test", name: "Test", modelsDir: "providers/test/models" };
const labels = ["automation", "model-sync", "missing-model", "provider:test"];
type Result = { stdout?: string; stderr?: string; code?: number };

async function withGh(
  options: {
    issues?: { number: number; title: string; state?: string }[];
    list?: Result;
    dispatch?: Result;
  },
  run: (calls: string[][]) => Promise<void>,
) {
  const repository = process.env.GITHUB_REPOSITORY;
  const calls: string[][] = [];
  let number = 100;
  const spawn = spyOn(Bun, "spawn").mockImplementation(((command: string[]) => {
    calls.push(command);
    let result: Result;
    switch (command.slice(0, 3).join(" ")) {
      case "gh label create":
        result = {};
        break;
      case "gh issue list":
        result = options.list ?? { stdout: JSON.stringify(options.issues ?? []) };
        break;
      case "gh issue create":
        result = { stdout: `https://github.com/test/models.dev/issues/${++number}\n` };
        break;
      case "gh api repos/test/models.dev/dispatches":
        result = options.dispatch ?? {};
        break;
      default:
        throw new Error(`Unexpected mocked command: ${command.join(" ")}`);
    }
    return {
      stdout: new Response(result.stdout ?? "").body,
      stderr: new Response(result.stderr ?? "").body,
      exited: Promise.resolve(result.code ?? 0),
    };
  }) as unknown as typeof Bun.spawn);
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    process.env.GITHUB_REPOSITORY = "test/models.dev";
    await run(calls);
  } finally {
    spawn.mockRestore();
    log.mockRestore();
    error.mockRestore();
    if (repository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = repository;
  }
}

test.serial("dedupes and sorts IDs, applies exact labels, and dispatches each issue number", async () => {
  await withGh({}, async (calls) => {
    const notices = await openMissingModelIssues(provider, ["z", "a", "", "z", "a"]);

    expect(calls.slice(0, 4)).toEqual(labels.map((label) => [
      "gh", "label", "create", label, "--color", "0E8A16", "--description",
      "Automated model catalog sync", "--force",
    ]));
    const creates = calls.filter((call) => call[1] === "issue" && call[2] === "create");
    expect(creates.map((call) => call[4])).toEqual(["[missing-model] test: a", "[missing-model] test: z"]);
    for (const call of creates) {
      expect(call.slice(7)).toEqual(labels.flatMap((label) => ["--label", label]));
    }
    expect(calls.filter((call) => call[1] === "api")).toEqual([101, 102].map((number) => [
      "gh", "api", "repos/test/models.dev/dispatches", "--method", "POST",
      "--field", "event_type=missing-model", "--field", "client_payload[provider]=test",
      "--field", `client_payload[issue_number]=${number}`,
    ]));
    expect(notices).toEqual([
      "Opened GitHub issue #101 and dispatched the issue fixer for missing model `a`",
      "Opened GitHub issue #102 and dispatched the issue fixer for missing model `z`",
    ]);
    expect(calls).toHaveLength(9);
  });
});

test.serial("dedupes exact titles from both open and closed issues", async () => {
  await withGh({ issues: [
    { number: 11, title: "[missing-model] test: open", state: "OPEN" },
    { number: 12, title: "[missing-model] test: closed", state: "CLOSED" },
    { number: 13, title: "[missing-model] other: new", state: "OPEN" },
  ] }, async (calls) => {
    const notices = await openMissingModelIssues(provider, ["open", "closed", "new"]);

    expect(calls[4]).toEqual([
      "gh", "issue", "list", "--state", "all", "--label", "missing-model",
      "--label", "provider:test", "--limit", "1000", "--json", "number,title",
    ]);
    expect(notices).toEqual([
      "Missing model `closed` already tracked by #12",
      "Opened GitHub issue #101 and dispatched the issue fixer for missing model `new`",
      "Missing model `open` already tracked by #11",
    ]);
    expect(calls.filter((call) => call[1] === "issue" && call[2] === "create").map((call) => call[4]))
      .toEqual(["[missing-model] test: new"]);
    expect(calls).toHaveLength(7);
  });
});

test.serial.each([
  ["test", undefined],
  ["test", "Missing reasoning_options"],
  ["cloudflare-ai-gateway", "Missing reasoning_options"],
] as const)("includes model-specific diagnostics and curation guidance for %s (%s)", async (id, reason) => {
  await withGh({}, async (calls) => {
    const modelId = "lab/reasoner";
    await openMissingModelIssues({ ...provider, id, modelsDir: `providers/${id}/models` }, [modelId], {
      reasons: { unrelated: "Do not leak this diagnostic", ...(reason === undefined ? {} : { [modelId]: reason }) },
    });
    const create = calls.find((call) => call[1] === "issue" && call[2] === "create")!;
    const body = create[6]!;

    expect(body).toContain(`| Expected path | \`providers/${id}/models/${modelId}.toml\` |`);
    expect(body).not.toContain("Do not leak this diagnostic");
    if (reason === undefined) {
      expect(body).toContain("prefer `base_model`");
      expect(body).toContain("not in the local catalog");
      expect(body).toContain("This provider uses `skipCreates`");
      expect(body).not.toContain("Sync diagnostic:");
    } else {
      expect(body).toContain("Do not guess missing values or use empty reasoning controls as a placeholder.");
      expect(body).toContain("Re-run the provider sync and `bun validate`.");
      expect(body).toContain(`Sync diagnostic: ${reason}`);
      expect(body).toContain("Any existing local entry was left unchanged.");
      expect(body).not.toContain("This provider uses `skipCreates`");
    }
    if (id === "cloudflare-ai-gateway") {
      expect(body).toContain('`providers/cloudflare-ai-gateway/curation.toml` under `[models."lab/reasoner"]`');
      expect(body).toContain("Editing only the generated TOML will not fix this sync.");
      expect(body).toContain("Put source URLs and exact reasoning wire paths in the curation entry's `note` array");
      expect(body).toContain("generated headers are replaced from it");
      expect(body).toContain("Do not add the model to `skip` merely to silence missing metadata.");
    } else {
      expect(body).not.toContain("providers/cloudflare-ai-gateway/curation.toml");
    }
  });
});

test.serial("dry runs and empty IDs make no subprocess calls", async () => {
  await withGh({}, async (calls) => {
    expect(await openMissingModelIssues(provider, ["z", "a", "z", ""], { dryRun: true })).toEqual([
      "Would open GitHub issue for missing model `a` (`[missing-model] test: a`)",
      "Would open GitHub issue for missing model `z` (`[missing-model] test: z`)",
    ]);
    expect(await openMissingModelIssues(provider, [])).toEqual([]);
    expect(await openMissingModelIssues(provider, ["", ""])).toEqual([]);
    expect(calls).toEqual([]);
  });
});

test.serial.each([
  ["list failure", { code: 1, stderr: "list unavailable" }, "gh issue list failed: list unavailable"],
  ["full 1000-issue window", { stdout: JSON.stringify(Array.from({ length: 1000 }, (_, number) => ({ number, title: `issue ${number}` }))) },
    "refusing to create against a possibly truncated dedupe list"],
] as const)("creates nothing on %s", async (_name, list, message) => {
  await withGh({ list }, async (calls) => {
    await expect(openMissingModelIssues(provider, ["new"])).rejects.toThrow(message);
    expect(calls.map((call) => call.slice(1, 3))).toEqual([
      ["label", "create"], ["label", "create"], ["label", "create"], ["label", "create"], ["issue", "list"],
    ]);
  });
});

test.serial("reports a dispatch failure without claiming the issue fixer ran or creating twice", async () => {
  await withGh({ dispatch: { code: 1, stderr: "dispatch unavailable" } }, async (calls) => {
    const notices = await openMissingModelIssues(provider, ["new", "new"]);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("missing model `new`");
    expect(notices[0]).toContain("issue fixer dispatch failed: dispatch unavailable");
    expect(notices[0]).not.toContain("dispatched the issue fixer");
    expect(calls.filter((call) => call[1] === "issue" && call[2] === "create")).toHaveLength(1);
    expect(calls.filter((call) => call[1] === "api")).toHaveLength(1);
    expect(calls).toHaveLength(7);
  });
});
