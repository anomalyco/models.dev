import { expect, test } from "bun:test";

import { buildReport, MAX_REPORT_LENGTH, type SyncResult } from "../src/sync/index.js";

function result(files: number, notices: string[] = []): SyncResult {
  return {
    id: "example",
    name: "Example",
    status: "changed",
    created: files,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    notices,
    files: Array.from({ length: files }, (_, i) => ({ status: "created" as const, path: `providers/example/models/lab/model-${i}.toml` })),
  };
}

test("lists every changed file when they fit", () => {
  const report = buildReport("example", [result(3)]);

  expect(report).toContain("- created: `providers/example/models/lab/model-2.toml`");
  expect(report).not.toContain("more (the full list is in the diff)");
});

test("stays under a pull request body's limit however many files changed", () => {
  const report = buildReport("example", [result(2_000, ["A notice."])]);

  expect(report.length).toBeLessThanOrEqual(MAX_REPORT_LENGTH);
  expect(report).toContain("| Example | changed | 2000 | 0 | 0 |");
  expect(report).toMatch(/- \.\.\.and \d+ more \(the full list is in the diff\)/);
  expect(report).toContain("A notice.");
  expect(report).toContain("This PR was created automatically by the model sync workflow.");
});

test("cuts notices that alone run past the limit, keeping the footer", () => {
  const report = buildReport("example", [result(1, ["x".repeat(MAX_REPORT_LENGTH)])]);

  expect(report.length).toBeLessThanOrEqual(MAX_REPORT_LENGTH);
  expect(report).toContain("was cut to fit a pull request body");
  expect(report.trimEnd()).toEndWith("This PR was created automatically by the model sync workflow.");
});
