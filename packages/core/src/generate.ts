import path from "path";

import { Provider, Content } from "./schema.js";

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

    // Process articles if articles directory exists
    const contentPath = path.join(directory, providerID, "content");
    try {
      provider.data.articles = {};
      for await (const articlePath of new Bun.Glob("**/*.toml").scan({
        cwd: contentPath,
        absolute: true,
        followSymlinks: true,
      })) {
        const articleID = path.relative(contentPath, articlePath).slice(0, -5);
        const toml = await import(articlePath, {
          with: {
            type: "toml",
          },
        }).then((mod) => mod.default);
        toml.id = articleID;
        const article = Content.safeParse(toml);
        if (!article.success) {
          article.error.cause = toml;
          throw article.error;
        }
        provider.data.articles[articleID] = article.data;
      }
    } catch (error) {
      // Content directory might not exist for all providers
      console.log(`No content directory found for provider ${providerID}`);
    }

    result[providerID] = provider.data;
  }

  return result;
}
