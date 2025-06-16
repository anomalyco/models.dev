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
          <title>Models.dev — An open-source database of LLMs</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
          <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Rubik:wght@300..900&display=swap" rel="stylesheet" />
          <script
            dangerouslySetInnerHTML={{
              __html: `
              function filterTable() {
                const searchInput = document.getElementById('searchInput').value.toLowerCase();
                const rows = document.querySelectorAll('table tbody tr');
                
                rows.forEach(row => {
                  const provider = row.cells[0].textContent.toLowerCase();
                  const providerId = row.cells[1].textContent.toLowerCase();
                  const model = row.cells[2].textContent.toLowerCase();
                  const modelId = row.cells[3].textContent.toLowerCase();
                  
                  if (provider.includes(searchInput) || model.includes(searchInput) || providerId.includes(searchInput) || modelId.includes(searchInput)) {
                    row.style.display = '';
                  } else {
                    row.style.display = 'none';
                  }
                });
              }
            `,
            }}
          />
          <style dangerouslySetInnerHTML={{
            __html: `
    /* CSS Reset/Normalize */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :root {
      --header-height: 56px;
      --font-mono: 'IBM Plex Mono', monospace;
    }

    :root {
      --color-brand: #FD9527;
      --color-background: #FFF;
      --color-border: #DDD;
      --color-header-background: rgba(255, 255, 255, 0.75);

      --color-text: #333;
      --color-text-secondary: #666;
      --color-text-tertiary: #999;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --color-brand: #FD9527;
        --color-background: #1E1E1E;
        --color-border: #333;
        --color-header-background: rgba(30, 30, 30, 0.75);

        --color-text: #FFF;
        --color-text-secondary: #AAA;
        --color-text-tertiary: #666;
      }
    }

    html, body {
      font-family: 'Rubik', sans-serif;
      line-height: 1.6;
      color: var(--color-text);
      background-color: var(--color-background);
    }

    input, button {
      font-family: inherit;
    }

    header {
      top: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      height: var(--header-height);
      padding: 0 0.75rem;
      background-color: var(--color-background);
      position: fixed;
      width: 100%;

      & > div {
        display: flex;
        align-items: center;

        &.left {
          position: relative;
          align-items: baseline;
        }
        &.right {
          gap: 0.75rem;
        }
      }

      h1 {
        font-size: 1rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: -0.5px;
      }
      p {
        font-size: 0.875rem;
        color: var(--color-text-tertiary);
      }
      .slash {
        margin-left: 0.625rem;
        margin-right: 0.25rem;
        display: block;
        position: relative;
        top: 1px;
        width: 0;
        line-height: 1;
        height: 0.75rem;
        border-right: 2px solid var(--color-border);
        transform: translateX(-50%) rotate(20deg);
        transform-origin: top center;
      }
      a.github {
        color: var(--color-text-secondary);
        svg {
          opacity: 0.85;
        }
      }
      input {
        font-size: 0.8125rem;
        line-height: 1.1;
        padding: 0.5rem 0.625rem;
        border-radius: 0.25rem;
        border: 1px solid var(--color-border);
        background: none;
        color: var(--color-text);

        &:focus {
          border-color: var(--color-brand);
          outline: none;
        }
      }
    }

    table {
      border-collapse: separate;
      border-spacing: 0;
      font-size: 0.875rem;
      width: 100%;
      margin-top: var(--header-height);
    }

    thead, tbody {
    }

    table thead th {
      position: sticky;
      top: var(--header-height);
      border-top: 1px solid var(--color-border);
      border-bottom: 1px solid var(--color-border);
      font-size: 0.75rem;
      padding: 0.75rem 0.75rem calc(0.75rem - 2px);
      line-height: 1;
      font-weight: 400;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--color-text-secondary);
      backdrop-filter: blur(6px);
      background-color: var(--color-header-background);
    }

    table thead th[data-desc]::after {
      color: var(--color-text-tertiary);
      margin-top: 0.5em;
      content: attr(data-desc);
      display: block;
      font-size: 0.625rem;
      font-weight: normal;
    }

    th, td {
      padding: 0.75rem;
      text-align: left;
      border-bottom: 1px solid var(--color-border);
      white-space: nowrap;
    }

    tbody {
      td {
        color: var(--color-text-tertiary);
      }
      td:nth-child(1) {
        font-weight: 500;
      }
      td:nth-child(1), td:nth-child(2) {
        color: var(--color-text);
      }
      td:nth-child(5) {
      }
      td:nth-child(5),
      td:nth-child(6),
      td:nth-child(7) {
        font-size: 0.8125rem;
        font-family: var(--font-mono);
        text-transform: uppercase;
      }
      td:nth-child(3),
      td:nth-child(4),
      td:nth-child(8),
      td:nth-child(9),
      td:nth-child(10),
      td:nth-child(11),
      td:nth-child(12),
      td:nth-child(13) {
        font-size: 0.8125rem;
        font-family: var(--font-mono);
      }
    }
`
          }} />
        </head>
        <body>
          <header>
            <div class="left">
              <h1>Models.dev</h1>
              <span class="slash"></span>
              <p>An open-source database of LLMs</p>
            </div>
            <div class="right">
              <a class="github" target="_blank" rel="noopener noreferrer" href="https://github.com/sst/models.dev">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
                  <path fill="currentColor" d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5c.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34c-.46-1.16-1.11-1.47-1.11-1.47c-.91-.62.07-.6.07-.6c1 .07 1.53 1.03 1.53 1.03c.87 1.52 2.34 1.07 2.91.83c.09-.65.35-1.09.63-1.34c-2.22-.25-4.55-1.11-4.55-4.92c0-1.11.38-2 1.03-2.71c-.1-.25-.45-1.29.1-2.64c0 0 .84-.27 2.75 1.02c.79-.22 1.65-.33 2.5-.33s1.71.11 2.5.33c1.91-1.29 2.75-1.02 2.75-1.02c.55 1.35.2 2.39.1 2.64c.65.71 1.03 1.6 1.03 2.71c0 3.82-2.34 4.66-4.57 4.91c.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2"></path>
                </svg>
              </a>
              <input type="text" id="searchInput" onkeyup="filterTable()" placeholder="Filter by provider or model..." />
            </div>
          </header>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th>Provider ID</th>
                <th>Model ID</th>
                <th>Attachment</th>
                <th>Reasoning</th>
                <th>Temperature</th>
                <th data-desc="per 1M tokens">Input Cost</th>
                <th data-desc="per 1M tokens">Output Cost</th>
                <th data-desc="per 1M tokens">Input Cached Cost</th>
                <th data-desc="per 1M tokens">Output Cached Cost</th>
                <th>Context Limit</th>
                <th>Output Limit</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(apiData)
                .sort(([, providerA], [, providerB]) =>
                  providerA.name.localeCompare(providerB.name)
                )
                .flatMap(([providerId, provider]) =>
                  Object.entries(provider.models)
                    .sort(([, modelA], [, modelB]) =>
                      modelA.name.localeCompare(modelB.name)
                    )
                    .map(([modelId, model]) => (
                      <tr key={`${providerId}-${modelId}`}>
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
        </body>
      </html>
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

//               /* Header Styles */
//               .page-header {
//                 position: fixed;
//                 top: 0;
//                 left: 0;
//                 right: 0;
//                 background-color: #fff;
//                 border-bottom: 2px solid #e0e0e0;
//                 padding: 16px 20px;
//                 display: flex;
//                 justify-content: space-between;
//                 align-items: center;
//                 z-index: 100;
// display: none;
//               }
//               .page-header h1 {
//                 font-size: 24px;
//                 font-weight: 600;
//                 color: #333;
//               }
//               .search-container {
//                 display: flex;
//                 align-items: center;
//               }
//               #searchInput {
//                 padding: 10px 16px;
//                 width: 300px;
//                 font-size: 16px;
//                 border: 2px solid #e0e0e0;
//                 border-radius: 8px;
//                 outline: none;
//                 transition: border-color 0.2s ease;
//               }
//               #searchInput:focus {
//                 border-color: #007bff;
//               }
//               /* Table Styles */
//               .table-container {
//                 /**overflow-x: auto;
//                 width: 100%;**/
//               }
//               table {
//                 width: 100%;
//                 font-family: 'Rubik', sans-serif;
//                 font-size: 14px;
//                 border-collapse: collapse;
//                 min-width: 800px;
//               }
//               thead th {
//                 position: sticky;
//                 /** top: 72px; **/
//                 background-color: #f8f9fa;
//                 z-index: 50;
//               }
//               th {
//                 background-color: #f8f9fa;
//                 padding: 12px 8px;
//                 text-align: left;
//                 font-weight: 600;
//                 border-bottom: 2px solid #dee2e6;
//                 white-space: nowrap;
//               }
//               td {
//                 padding: 10px 8px;
//                 border-bottom: 1px solid #dee2e6;
//                 white-space: nowrap;
//               }
//               tbody tr:hover {
//                 background-color: #f8f9fa;
//               }
//               /* Responsive Design */
//               @media (max-width: 768px) {
//                 .page-header {
//                   flex-direction: column;
//                   gap: 12px;
//                   padding: 12px 16px;
//                 }
//                 .page-header h1 {
//                   font-size: 20px;
//                 }
//                 #searchInput {
//                   width: 100%;
//                   max-width: 300px;
//                 }
//                 .table-container {
//                   margin-top: 96px;
//                 }
//                 table {
//                   min-width: unset;
//                 }
//                 thead {
//                   top: 96px;
//                 }
//                 th, td {
//                   padding: 8px 6px;
//                   font-size: 12px;
//                 }
//               }
//               @media (max-width: 480px) {
//                 .page-header {
//                   padding: 10px 12px;
//                 }
//                 .table-container {
//                   margin-top: 76px;
//                 }
//                 .page-header h1 {
//                   font-size: 18px;
//                 }
//                 #searchInput {
//                   font-size: 14px;
//                   padding: 8px 12px;
//                 }
//                 th, td {
//                   padding: 6px 4px;
//                   font-size: 11px;
//                 }
//               }
