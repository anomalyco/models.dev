import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider } from "../src/sync/index.js";

import { fetchNvidiaModels, nvidia, parseNvidiaCatalog, parseNvidiaModels } from "../src/sync/providers/nvidia.js";

const REPO = path.join(import.meta.dir, "../../..");

const catalog = [
  "# Models",
  "",
  "- [kimi-k3.1-pro](/abc123/kimi-k3_1-pro.md) — 1M-token context model",
  "- [glm-5-3-flash](/abc123/glm-5-3-flash.md) — Multimodal MoE",
  "- [laguna-xs-2.1](/abc123/laguna-xs-2.1.md) — Agentic coding",
].join("\n");

const list = (...ids: string[]) => ({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });

test("reads catalog slugs whichever way they spell dots", () => {
  expect([...parseNvidiaCatalog(catalog)]).toEqual(["kimi-k3-1-pro", "glm-5-3-flash", "laguna-xs-2-1"]);
});

test("marks an API model as listed only when the catalog has a page for it", () => {
  expect(parseNvidiaModels({
    models: list("moonshotai/kimi-k3.1-pro", "z-ai/glm-5.3-flash", "poolside/laguna-xs-2.1", "nvidia/retired-model"),
    catalog,
  })).toEqual([
    { id: "moonshotai/kimi-k3.1-pro", listed: true },
    { id: "z-ai/glm-5.3-flash", listed: true },
    { id: "poolside/laguna-xs-2.1", listed: true },
    { id: "nvidia/retired-model", listed: false },
  ]);
});

test("refuses an empty model list or a catalog page with no models", () => {
  expect(() => parseNvidiaModels({ models: list(), catalog })).toThrow();
  expect(() => parseNvidiaModels({ models: list("moonshotai/kimi-k3.1-pro"), catalog: "# Models" })).toThrow();
});

test("fetches both public NVIDIA sources without authentication", async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    expect(init).toBeUndefined();
    requests.push(String(input));
    return String(input).endsWith(".md") ? new Response(catalog) : Response.json(list("moonshotai/kimi-k3.1-pro"));
  };

  await expect(fetchNvidiaModels(fetcher)).resolves.toEqual({ models: list("moonshotai/kimi-k3.1-pro"), catalog });
  expect(requests).toEqual(["https://integrate.api.nvidia.com/v1/models", "https://build.nvidia.com/models.md"]);
});

test("reports only remote-only models the catalog lists, without creating or deleting TOMLs", () => {
  expect(nvidia.skipCreates).toBe(true);
  expect(nvidia.trackMissingModels).toBe(true);
  expect(nvidia.deleteMissing).toBe(false);
  expect(nvidia.sourceID({ id: "moonshotai/kimi-k3.1-pro", listed: true })).toBe("moonshotai/kimi-k3.1-pro");
  expect(nvidia.sourceID({ id: "nvidia/retired-model", listed: false })).toBeUndefined();
});

test("leaves shipped NVIDIA files byte-identical and creates nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nvidia-sync-"));
  const modelsDir = path.join(dir, "providers/nvidia/models");
  const ids = ["moonshotai/kimi-k3", "z-ai/glm-5.3"];
  for (const id of ids) {
    await mkdir(path.dirname(path.join(modelsDir, id)), { recursive: true });
    await Bun.write(path.join(modelsDir, `${id}.toml`), Bun.file(path.join(REPO, "providers/nvidia/models", `${id}.toml`)));
  }
  for (const lab of ["moonshotai/kimi-k3", "zhipuai/glm-5.3"]) {
    await mkdir(path.dirname(path.join(dir, "models", lab)), { recursive: true });
    await Bun.write(path.join(dir, "models", `${lab}.toml`), Bun.file(path.join(REPO, "models", `${lab}.toml`)));
  }
  const before = await Promise.all(ids.map((id) => Bun.file(path.join(modelsDir, `${id}.toml`)).text()));

  try {
    const result = await syncProvider({
      ...nvidia,
      modelsDir,
      async fetchModels() {
        // kimi-k3 is still returned, glm-5.3 is not, and two IDs have no local file.
        return { models: list("moonshotai/kimi-k3", "moonshotai/kimi-k3.1-pro", "nvidia/retired-model"), catalog };
      },
    });
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.notices.join("\n")).toContain("`moonshotai/kimi-k3.1-pro`");
    expect(result.notices.join("\n")).not.toContain("nvidia/retired-model");
    const after = await Promise.all(ids.map((id) => Bun.file(path.join(modelsDir, `${id}.toml`)).text()));
    expect(after).toEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
