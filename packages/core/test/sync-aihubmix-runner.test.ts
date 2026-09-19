import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { syncProvider } from "../src/sync/index.js";
import { aihubmix } from "../src/sync/providers/aihubmix.js";

// A real sync installs module-level catalog state (the lab IDs, the relay
// listing, the canon cover) that every other AIHubMix test expects unset, so
// this one lives in its own file rather than leaking that state sideways.

test("AIHubMix sync carries a hand-authored note through an authoritative header rewrite", async () => {
  // Every other AIHubMix test hands `translateModel` a context it builds itself,
  // so the `header` callback could be wired nowhere and the suite would still be
  // green. This one drives the runner: the note has to survive a real sync, which
  // is the only place `authoritativeHeaders` actually replaces a file's header.
  const root = await mkdtemp(path.join(tmpdir(), "sync-aihubmix-header-"));
  const repo = path.join(import.meta.dirname, "..", "..", "..");
  const modelsDir = path.join(root, "providers", "aihubmix", "models");
  const relayPath = path.join(modelsDir, "deepseek-v4-pro-0813.toml");
  const listingURL = process.env.AIHUBMIX_MODELS_URL;
  const canonURL = process.env.AIHUBMIX_CANON_URL;
  const note = "# Probed 2026-09-15: low/high/max returned 522/564/510 reasoning tokens.\n";
  try {
    await mkdir(path.join(root, "models", "deepseek"), { recursive: true });
    await copyFile(
      path.join(repo, "models", "deepseek", "deepseek-v4-pro-0813.toml"),
      path.join(root, "models", "deepseek", "deepseek-v4-pro-0813.toml"),
    );
    await mkdir(modelsDir, { recursive: true });
    // A stale opening the block owns, and below it a note nothing else records.
    await Bun.write(
      relayPath,
      "# Toggle: enable_thinking = true|false\n" +
        note +
        'base_model = "deepseek/deepseek-v4-pro-0813"\nreasoning_options = [{ type = "toggle" }]\n',
    );

    const listing = path.join(root, "models.json");
    const canon = path.join(root, "canon.json");
    await Bun.write(
      listing,
      JSON.stringify({
        data: [
          {
            model_id: "deepseek-v4-pro-0813",
            model_name: "DeepSeek V4 Pro",
            vendor: "deepseek",
            pricing: { input: 0.6918, output: 2.0754, cache_read: 0.023058 },
            reasoning: true,
            reasoning_options: [
              { type: "toggle" },
              { type: "effort", values: ["low", "high", "max"] },
            ],
          },
        ],
      }),
    );
    await Bun.write(canon, JSON.stringify({ models: [{ id: "deepseek-v4-pro-0813" }] }));
    process.env.AIHUBMIX_MODELS_URL = pathToFileURL(listing).href;
    process.env.AIHUBMIX_CANON_URL = pathToFileURL(canon).href;

    expect(await syncProvider({ ...aihubmix, modelsDir })).toMatchObject({ updated: 1 });

    const content = await readFile(relayPath, "utf8");
    // The note is the whole point: a verification date cannot be re-derived.
    expect(content).toContain(note.trim());
    // The block is refreshed rather than appended beside the opening it replaces.
    expect(content).toContain("# Toggle:\n# $.enable_thinking = true|false");
    expect(content).toContain("# Effort: low|high|max");
    expect(content).not.toContain("# Toggle: enable_thinking = true|false\n");
    expect(Bun.TOML.parse(content)).toMatchObject({
      reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
    });
  } finally {
    if (listingURL === undefined) delete process.env.AIHUBMIX_MODELS_URL;
    else process.env.AIHUBMIX_MODELS_URL = listingURL;
    if (canonURL === undefined) delete process.env.AIHUBMIX_CANON_URL;
    else process.env.AIHUBMIX_CANON_URL = canonURL;
    await rm(root, { recursive: true, force: true });
  }
});
