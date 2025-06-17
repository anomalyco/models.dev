/** @jsx jsx */
/** @jsxImportSource hono/jsx */

import { generate } from "@models.dev/core"
import { Fragment } from "hono/jsx"
import { renderToString } from "hono/jsx/dom/server"
import path from "path"

const apiData = await generate(
  path.join(import.meta.dir, "..", "..", "..", "providers")
)


export const Rendered = renderToString(
  <Fragment>
    <header>
      <div class="left">
        <h1>Models.dev</h1>
        <span class="slash"></span>
        <p>An open-source database of AI models</p>
      </div>
      <div class="right">
        <a
          class="github"
          target="_blank"
          rel="noopener noreferrer"
          href="https://github.com/sst/models.dev"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
          >
            <path
              fill="currentColor"
              d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5c.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34c-.46-1.16-1.11-1.47-1.11-1.47c-.91-.62.07-.6.07-.6c1 .07 1.53 1.03 1.53 1.03c.87 1.52 2.34 1.07 2.91.83c.09-.65.35-1.09.63-1.34c-2.22-.25-4.55-1.11-4.55-4.92c0-1.11.38-2 1.03-2.71c-.1-.25-.45-1.29.1-2.64c0 0 .84-.27 2.75 1.02c.79-.22 1.65-.33 2.5-.33s1.71.11 2.5.33c1.91-1.29 2.75-1.02 2.75-1.02c.55 1.35.2 2.39.1 2.64c.65.71 1.03 1.6 1.03 2.71c0 3.82-2.34 4.66-4.57 4.91c.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2"
            ></path>
          </svg>
        </a>
        <input
          type="text"
          id="search"
          placeholder="Filter by provider or model..."
        />
        <button id="help">How to use</button>
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
          <th data-desc="per 1M tokens">Cache Read Cost</th>
          <th data-desc="per 1M tokens">Cache Write Cost</th>
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
                  <td>{model.cost.cache_read ? `$${model.cost.cache_read}` : "-"}</td>
                  <td>{model.cost.cache_write ? `$${model.cost.cache_write}` : "-"}</td>
                  <td>{model.limit.context}</td>
                  <td>{model.limit.output}</td>
                </tr>
              ))
          )}
      </tbody>
    </table>
    <dialog id="modal">
      <div class="header">
        <h2>How to use</h2>
        <button id="close">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <line
              x1="18"
              y1="6"
              x2="6"
              y2="18"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
            <line
              x1="6"
              y1="6"
              x2="18"
              y2="18"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
      <div class="body">
        <p>
          <a href="/">Models.dev</a> is a comprehensive open-source
          database of AI model specifications, pricing, and features.
        </p>
        <p>
          There&apos;s no single database with information about all the
          available AI models. We started Models.dev as a
          community-contributed project to address this. We also use it
          internally in{" "}
          <a
            href="https://opencode.ai"
            target="_blank"
            rel="noopener noreferrer"
          >
            opencode
          </a>
          .
        </p>
        <h2>API</h2>
        <p>You can access this data through an API.</p>
        <div class="code-block">
          <code>
            curl <a href="/api.json">https://models.dev/api.json</a>
          </code>
        </div>
        <p>
          Use the <b>Model ID</b> field to do a lookup on any model;
          it&apos;s the identifier used by{" "}
          <a
            href="https://ai-sdk.dev/"
            target="_blank"
            rel="noopener noreferrer"
          >
            AI SDK
          </a>
          .
        </p>
        <h2>Contribute</h2>
        <p>
          The data is stored in the{" "}
          <a
            href="https://github.com/sst/models.dev"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub repo
          </a>{" "}
          as TOML files; organized by provider and model. This is used to
          generate this page and power the API.
        </p>
        <p>
          We need your help keeping this up to date. Feel free to edit the
          data and submit a pull request. Refer to the{" "}
          <a href="https://github.com/sst/models.dev/blob/dev/README.md">
            README
          </a>{" "}
          for more information.
        </p>
      </div>
      <div class="footer">
        <a
          href="https://github.com/sst/models.dev"
          target="_blank"
          rel="noopener noreferrer"
        >
          Edit on GitHub
        </a>
        <a
          href="https://sst.dev"
          target="_blank"
          rel="noopener noreferrer"
        >
          Created by SST
        </a>
      </div>
    </dialog>
  </Fragment>
)

