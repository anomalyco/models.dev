import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, type SyncedModel, type SyncProvider } from "../src/sync/index.js";

const REPO = path.join(import.meta.dirname, "..", "..", "..");

type Row = { id: string; model: SyncedModel } | { id: string; v2: Record<string, unknown> };

// A catalog in a temp dir: the real Inkling lab files and one OpenAI-compatible provider whose feed is `rows`.
async function sync(files: Record<string, string>, rows: Row[]) {
  const root = await mkdtemp(path.join(tmpdir(), "reasoning-field-"));
  await cp(path.join(REPO, "models", "thinkingmachines"), path.join(root, "models", "thinkingmachines"), { recursive: true });
  const modelsDir = path.join(root, "providers", "host", "models");
  await mkdir(path.join(modelsDir, "thinkingmachines"), { recursive: true });
  await writeFile(
    path.join(modelsDir, "..", "provider.toml"),
    'name = "Host"\nnpm = "@ai-sdk/openai-compatible"\nopencodeai = "@opencode/ai/providers/openai-compatible"\nenv = ["HOST_API_KEY"]\napi = "https://host.test/v1"\n',
  );
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(modelsDir, file), text);
  const provider: SyncProvider<Row> = {
    id: "host",
    name: "Host",
    modelsDir,
    fetchModels: async () => rows,
    parseModels: (raw) => raw as Row[],
    translateModel: (row) => row,
  };
  await syncProvider(provider);
  return (file: string) => readFile(path.join(modelsDir, file), "utf8");
}

const INKLING_SMALL = `schema = 2
base_model = "thinkingmachines/inkling-small"

[capabilities]
reasoning = { supported = true, effort = ["low", "high"] }

[api.chat-completions]
compatibility = { reasoning_field = "reasoning_content" }

[cost.text.input]
price = 1

[cost.text.output]
price = 2
`;

// What a module that rebuilds the model from its feed sends: no `interleaved`.
const row = (id: string, output: number, reasoning = true): Row => ({
  id: `thinkingmachines/${id}`,
  model: {
    base_model: `thinkingmachines/${id}`,
    ...(reasoning ? { reasoning_options: [{ type: "effort", values: ["low", "high"] }] } : { reasoning: false }),
    cost: { input: 1, output },
  } as SyncedModel,
});

test("an update from a module that leaves interleaved out keeps the file's reasoning field", async () => {
  const read = await sync({ "thinkingmachines/inkling-small.toml": INKLING_SMALL }, [row("inkling-small", 3)]);
  const text = await read("thinkingmachines/inkling-small.toml");
  expect(text).toContain("price = 3");
  expect(text).toContain('[api.chat-completions]\ncompatibility = { reasoning_field = "reasoning_content" }');
});

test("an update that turns reasoning off doesn't keep the reasoning field", async () => {
  const read = await sync({ "thinkingmachines/inkling-small.toml": INKLING_SMALL }, [row("inkling-small", 3, false)]);
  expect(await read("thinkingmachines/inkling-small.toml")).not.toContain("reasoning_field");
});

test("a new model takes the reasoning field from the host's previous model in the family", async () => {
  const read = await sync({ "thinkingmachines/inkling-small.toml": INKLING_SMALL }, [row("inkling-small", 2), row("inkling-2-small", 2)]);
  const text = await read("thinkingmachines/inkling-2-small.toml");
  expect(text).toContain("(api.chat-completions.compatibility.reasoning_field) come from thinkingmachines/inkling-small");
  expect(text).toContain('[api.chat-completions]\ncompatibility = { reasoning_field = "reasoning_content" }');
});

test("a new model that doesn't reason doesn't take the reasoning field", async () => {
  const read = await sync({ "thinkingmachines/inkling-small.toml": INKLING_SMALL }, [row("inkling-small", 2), row("inkling-2-small", 2, false)]);
  expect(await read("thinkingmachines/inkling-2-small.toml")).not.toContain("reasoning_field");
});

test("a new model written straight as a v2 file takes the reasoning field too", async () => {
  const read = await sync({ "thinkingmachines/inkling-small.toml": INKLING_SMALL }, [
    row("inkling-small", 2),
    {
      id: "thinkingmachines/inkling-2-small",
      v2: {
        schema: 2,
        base_model: "thinkingmachines/inkling-2-small",
        capabilities: { reasoning: { supported: true, effort: ["low", "high"] } },
        cost: { text: { input: { price: 1 }, output: { price: 2 } } },
      },
    },
  ]);
  expect(await read("thinkingmachines/inkling-2-small.toml")).toContain('[api.chat-completions]\ncompatibility = { reasoning_field = "reasoning_content" }');
});
