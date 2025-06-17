import { Hono } from "hono";
import type { Fetcher } from "@cloudflare/workers-types";
import type { ApiData } from "./schemas";

interface Env {
  ASSETS: Fetcher;
}

// Create a typed Hono app
const app = new Hono<{ Bindings: Env }>();

// Root route
app.get("/", async (c) => {
  try {
    // Get the api.json file using env.ASSETS binding
    const apiJsonResponse = await c.env.ASSETS.fetch(
      new URL("api.json", c.req.url)
    );
    if (!apiJsonResponse) {
      throw new Error("api.json not found");
    }

    // Decode the JSON file
    const apiData = (await apiJsonResponse.json()) as ApiData;

    return c.html(
      <html>
        <head>
          <title>Models.dev &mdash; An open-source database of AI models</title>
          <meta name="description" content="Models.dev is a comprehensive open-source database of AI model specifications, pricing, and features." />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
          <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Rubik:wght@300..900&display=swap" rel="stylesheet" />
          <script src="/index.js"></script>
          <link rel="stylesheet" href="/index.css" />
          <link rel="icon" href="/favicon.svg" sizes="any" type="image/svg+xml" />
          <meta property="og:image" content="https://models.dev/social-share.png" />
        </head>
        <body>
          <header>
            <div class="left">
              <h1>Models.dev</h1>
              <span class="slash"></span>
              <p>An open-source database of AI models</p>
            </div>
            <div class="right">
              <a class="github" target="_blank" rel="noopener noreferrer" href="https://github.com/sst/models.dev">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
                  <path fill="currentColor" d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5c.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34c-.46-1.16-1.11-1.47-1.11-1.47c-.91-.62.07-.6.07-.6c1 .07 1.53 1.03 1.53 1.03c.87 1.52 2.34 1.07 2.91.83c.09-.65.35-1.09.63-1.34c-2.22-.25-4.55-1.11-4.55-4.92c0-1.11.38-2 1.03-2.71c-.1-.25-.45-1.29.1-2.64c0 0 .84-.27 2.75 1.02c.79-.22 1.65-.33 2.5-.33s1.71.11 2.5.33c1.91-1.29 2.75-1.02 2.75-1.02c.55 1.35.2 2.39.1 2.64c.65.71 1.03 1.6 1.03 2.71c0 3.82-2.34 4.66-4.57 4.91c.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2"></path>
                </svg>
              </a>
              <input type="text" id="searchInput" onkeyup="filterTable()" placeholder="Filter by provider or model..." />
              <button id="btnHowToUse">How to use</button>
            </div>
          </header>
          <table>
            <thead>
              <tr>
                <th class="sortable" data-column="provider">Provider <span class="sort-arrow"></span></th>
                <th class="sortable" data-column="model">Model <span class="sort-arrow"></span></th>
                <th class="sortable" data-column="provider-id">Provider ID <span class="sort-arrow"></span></th>
                <th class="sortable" data-column="model-id">Model ID <span class="sort-arrow"></span></th>
                <th class="sortable" data-column="attachment">Attachment <span class="sort-arrow"></span></th>
                <th class="sortable" data-column="reasoning">Reasoning <span class="sort-arrow"></span></th>
                <th class="sortable" data-column="temperature">Temperature <span class="sort-arrow"></span></th>
                <th class="sortable" data-column="input-cost" data-desc="per 1M tokens">Input Cost <span class="sort-arrow"></span></th>
                <th class="sortable" data-column="output-cost" data-desc="per 1M tokens">Output Cost <span class="sort-arrow"></span></th>
                <th class="sortable" data-column="input-cached-cost" data-desc="per 1M tokens">Input Cached Cost <span class="sort-arrow"></span></th>
                <th class="sortable" data-column="output-cached-cost" data-desc="per 1M tokens">Output Cached Cost <span class="sort-arrow"></span></th>
                <th class="sortable" data-column="context-limit">Context Limit <span class="sort-arrow"></span></th>
                <th class="sortable" data-column="output-limit">Output Limit <span class="sort-arrow"></span></th>
              </tr>
            </thead>
            <tbody id="tableBody">
              {Object.entries(apiData)
                .flatMap(([providerId, provider]) =>
                  Object.entries(provider.models)
                    .map(([modelId, model]) => (
                      <tr key={`${providerId}-${modelId}`} data-provider={provider.name} data-model={model.name} data-provider-id={providerId} data-model-id={modelId} data-attachment={model.attachment ? "1" : "0"} data-reasoning={model.reasoning ? "1" : "0"} data-temperature={model.temperature ? "1" : "0"} data-input-cost={model.cost.input} data-output-cost={model.cost.output} data-input-cached-cost={model.cost.inputCached} data-output-cached-cost={model.cost.outputCached} data-context-limit={model.limit.context} data-output-limit={model.limit.output}>
                        <td>{provider.name}</td>
                        <td>{model.name}</td>
                        <td>{providerId}</td>
                        <td>{modelId}</td>
                        <td>{model.attachment ? "Yes" : "No"}</td>
                        <td>{model.reasoning ? "Yes" : "No"}</td>
                        <td>{model.temperature ? "Yes" : "No"}</td>
                        <td>${model.cost.input}</td>
                        <td>${model.cost.output}</td>
                        <td>${model.cost.inputCached}</td>
                        <td>${model.cost.outputCached}</td>
                        <td>{model.limit.context}</td>
                        <td>{model.limit.output}</td>
                      </tr>
                    ))
                )}
            </tbody>
          </table>
          <dialog id="howToUse">
            <div class="header">
              <h2>How to use</h2>
              <button id="btnClose">
                <svg xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                >
                  <line x1="18" y1="6" x2="6" y2="18"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round" />
                  <line x1="6" y1="6" x2="18" y2="18"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round" />
                </svg>
              </button>
            </div>
            <div class="body">
              <p><a href="/">Models.dev</a> is a comprehensive open-source database of AI model specifications, pricing, and features.</p>
              <p>There&apos;s no single database with information about all the available AI models. We started Models.dev as a community-contributed project to address this. We also use it internally in <a href="https://opencode.ai" target="_blank" rel="noopener noreferrer">opencode</a>.</p>
              <h2>API</h2>
              <p>You can access this data through an API.</p>
              <div class="code-block">
                <code>curl <a href="/api.json">https://models.dev/api.json</a></code>
              </div>
              <p>Use the <b>Model ID</b> field to do a lookup on any model; it&apos;s the identifier used by <a href="https://ai-sdk.dev/" target="_blank" rel="noopener noreferrer">AI SDK</a>.</p>
              <h2>Contribute</h2>
              <p>The data is stored in the <a href="https://github.com/sst/models.dev" target="_blank" rel="noopener noreferrer">GitHub repo</a> as TOML files; organized by provider and model. This is used to generate this page and power the API.</p>
              <p>We need your help keeping this up to date. Feel free to edit the data and submit a pull request. Refer to the <a href="https://github.com/sst/models.dev/blob/dev/README.md">README</a> for more information.</p>
            </div>
            <div class="footer">
              <a href="https://github.com/sst/models.dev" target="_blank" rel="noopener noreferrer">Edit on GitHub</a>
              <a href="https://sst.dev" target="_blank" rel="noopener noreferrer">Created by SST</a>
            </div>
          </dialog>
        </body>
      </html >
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return c.html(
      <html>
        <body>
          <h1>Error</h1>
          <p>{error.message}</p>
        </body>
      </html>
    );
  }
});

// Default route - return 404 for any other path
app.all("*", (c) => {
  return c.html(
    <html>
      <body>
        <h1>404 - Not Found</h1>
        <p>The requested page does not exist.</p>
      </body>
    </html>,
    404
  );
});

export default {
  fetch: app.fetch,
};
