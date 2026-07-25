import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncProvider, type SyncProvider } from "../src/sync/index.js";
import { sference, type SferenceModel } from "../src/sync/providers/sference.js";

const mockCatalog: SferenceModel[] = [
  {
    id: "Qwen/Qwen3.6-35B-A3B", object: "model", created: 1712345678, owned_by: "sference",
    display_name: "Qwen3.6 35B", provider: "Qwen", modality: "text_generation",
    context_tokens: 262144,
    capabilities: { thinking: { supported: true, types: { enabled: { supported: true } } }, tools: { supported: true }, image_input: { supported: false }, pdf_input: { supported: false } },
    pricing: { input_per_million_usd: 0, output_per_million_usd: 0, cached_input_per_million_usd: null },
  },
  {
    id: "zai-org/GLM-5.2", object: "model", created: 1712345678, owned_by: "sference",
    display_name: "GLM 5.2", provider: "Zhipu", modality: "text_generation",
    context_tokens: 1048576,
    capabilities: { thinking: { supported: true, types: { enabled: { supported: true } } }, tools: { supported: true }, image_input: { supported: false }, pdf_input: { supported: false } },
    pricing: { input_per_million_usd: 1.2, output_per_million_usd: 4.2, cached_input_per_million_usd: 0.26 },
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Flash", object: "model", created: 1712345678, owned_by: "sference",
    display_name: "DeepSeek V4 Flash", provider: "DeepSeek", modality: "text_generation",
    context_tokens: 1048576,
    capabilities: { thinking: { supported: true, types: { enabled: { supported: true } } }, tools: { supported: true }, image_input: { supported: false }, pdf_input: { supported: false } },
    pricing: { input_per_million_usd: 0.08, output_per_million_usd: 0.2, cached_input_per_million_usd: 0.02 },
  },
  {
    id: "bottlecapai/ThinkingCap-Qwen3.6-27B", object: "model", created: 1712345678, owned_by: "sference",
    display_name: "ThinkingCap Qwen3.6 27B", provider: "BottleCap AI", modality: "text_generation",
    context_tokens: 262144,
    capabilities: { thinking: { supported: true, types: { enabled: { supported: true } } }, tools: { supported: true }, image_input: { supported: false }, pdf_input: { supported: false } },
    pricing: { input_per_million_usd: 0.4, output_per_million_usd: 2.6, cached_input_per_million_usd: null },
  },
];

test("syncProvider writes factored TOMLs from the public /v1/models shape", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sference-sync-"));
  const modelsDir = path.join(dir, "providers", "sference", "models");
  const metadataDir = path.join(dir, "models");
  // Seed canonical metadata so base_model resolves.
  await mkdir(path.join(metadataDir, "alibaba"), { recursive: true });
  await mkdir(path.join(metadataDir, "zhipuai"), { recursive: true });
  await mkdir(path.join(metadataDir, "deepseek"), { recursive: true });
  await mkdir(path.join(metadataDir, "bottlecapai"), { recursive: true });
  await writeFile(path.join(metadataDir, "alibaba", "qwen3.6-35b-a3b.toml"), 'name = "Qwen3.6 35B-A3B"\nfamily = "qwen"\nreasoning = true\nopen_weights = true\nattachment = true\ntool_call = true\n[limit]\ncontext = 262144\noutput = 65536\n[modalities]\ninput = ["text", "image", "video", "audio"]\noutput = ["text"]\n');
  await writeFile(path.join(metadataDir, "zhipuai", "glm-5.2.toml"), 'name = "GLM-5.2"\nfamily = "glm"\nreasoning = true\nopen_weights = true\ntool_call = true\nattachment = false\n[limit]\ncontext = 1000000\noutput = 131072\n[modalities]\ninput = ["text"]\noutput = ["text"]\n');
  await writeFile(path.join(metadataDir, "deepseek", "deepseek-v4-flash.toml"), 'name = "DeepSeek V4 Flash"\nfamily = "deepseek-flash"\nreasoning = true\nopen_weights = true\ntool_call = true\nattachment = false\n[limit]\ncontext = 1000000\noutput = 384000\n[modalities]\ninput = ["text"]\noutput = ["text"]\n');
  await writeFile(path.join(metadataDir, "bottlecapai", "thinkingcap-qwen3.6-27b.toml"), 'name = "ThinkingCap Qwen3.6 27B"\nfamily = "qwen"\nreasoning = true\nopen_weights = true\ntool_call = true\nattachment = true\n[limit]\ncontext = 262144\noutput = 65536\n[modalities]\ninput = ["text", "image", "video", "audio"]\noutput = ["text"]\n');
  await mkdir(modelsDir, { recursive: true });

  const provider: SyncProvider<SferenceModel> = {
    ...sference,
    modelsDir,
    async fetchModels() {
      return { object: "list" as const, data: mockCatalog };
    },
  };

  const result = await syncProvider(provider, { dryRun: false });
  expect(result.created).toBe(4);
  expect(result.deleted).toBe(0);

  const glm = await readFile(path.join(modelsDir, "zai-org", "GLM-5.2.toml"), "utf8");
  expect(glm).toContain('base_model = "zhipuai/glm-5.2"');
  expect(glm).toContain("input = 1.2");
  expect(glm).toContain("cache_read = 0.26");
  expect(glm).toContain("[[reasoning_options]]");
  // Output tracks context: the catalog window overrides both base fields.
  expect(glm).toContain("[limit]\ncontext = 1_048_576\noutput = 1_048_576");

  const qwen = await readFile(path.join(modelsDir, "Qwen", "Qwen3.6-35B-A3B.toml"), "utf8");
  expect(qwen).toContain("input = 0");
  expect(qwen).toContain("output = 0");
  // Context matches base and is stripped; output still overrides base's 65_536.
  expect(qwen).toContain("[limit]\noutput = 262_144");

  const ds = await readFile(path.join(modelsDir, "deepseek-ai", "DeepSeek-V4-Flash.toml"), "utf8");
  expect(ds).toContain('base_model = "deepseek/deepseek-v4-flash"');
  expect(ds).toContain("input = 0.08");

  // A second sync should be a no-op (idempotent).
  const result2 = await syncProvider(provider, { dryRun: false });
  expect(result2.created).toBe(0);
  expect(result2.updated).toBe(0);

  await rm(dir, { recursive: true, force: true });
});
