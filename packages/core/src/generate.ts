import path from "path";

import { Content, Provider } from "./schema.js";

export async function generate(directory: string) {
  const result = {} as Record<string, Provider>;
  for await (const providerPath of new Bun.Glob("*/provider*.toml").scan({
    cwd: directory,
    absolute: true,
  })) {
    const providerID = path.basename(path.dirname(providerPath));
    const toml = await import(providerPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => mod.default);
    toml.id = providerID;

    // Ensure provider has a name – default to directory name if not provided
    if (!("name" in toml)) {
      toml.name = providerID;
    }
    const provider = Provider.safeParse(toml);
    if (!provider.success) {
      provider.error.cause = toml;
      throw provider.error;
    }

    // Process contents if contents directory exists
    const contentsPath = path.join(directory, providerID, "content");
    try {
      provider.data.contents = {};
      for await (const contentPath of new Bun.Glob("**/*.toml").scan({
        cwd: contentsPath,
        absolute: true,
        followSymlinks: true,
      })) {
        const contentID = path.relative(contentsPath, contentPath).slice(0, -5);
        const toml = await import(contentPath, {
          with: {
            type: "toml",
          },
        }).then((mod) => mod.default);
        toml.id = contentID;
        const content = Content.safeParse(toml);
        if (!content.success) {
          content.error.cause = toml;
          throw content.error;
        }
        provider.data.contents[contentID] = content.data;
      }
    } catch (error) {
      // Content directory might not exist for all providers
      console.log(`No content directory found for provider ${providerID}`);
    }

    result[providerID] = provider.data;
  }

  return result;
}
