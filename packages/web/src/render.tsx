/** @jsx jsx */
/** @jsxImportSource hono/jsx */

import { generate } from "models.dev";
import { Fragment } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import path from "path";
import { TableRowFields, renderRow } from "./shared.js";

export const Providers = await generate(
  path.join(import.meta.dir, "..", "..", "..", "providers")
);

export const INITIAL_ROW_COUNT = 50;

export const TableRows: TableRowFields[] = Object.entries(Providers)
  .sort(([, providerA], [, providerB]) =>
    providerA.name.localeCompare(providerB.name)
  )
  .flatMap(([providerId, provider]) =>
    Object.entries(provider.models)
      .filter(([, model]) => model.status !== "alpha")
      .sort(([, modelA], [, modelB]) => modelA.name.localeCompare(modelB.name))
      .map(([modelId, model]) => ({
        providerId,
        providerName: provider.name,
        modelId,
        modelName: model.name,
        family: model.family,
        toolCall: model.tool_call,
        reasoning: model.reasoning,
        input: model.modalities.input,
        output: model.modalities.output,
        inputCost: model.cost?.input,
        outputCost: model.cost?.output,
        reasoningCost: model.cost?.reasoning,
        cacheReadCost: model.cost?.cache_read,
        cacheWriteCost: model.cost?.cache_write,
        audioInputCost: model.cost?.input_audio,
        audioOutputCost: model.cost?.output_audio,
        contextLimit: model.limit.context,
        inputLimit: model.limit.input,
        outputLimit: model.limit.output,
        structuredOutput: model.structured_output,
        temperature: model.temperature ?? false,
        openWeights: model.open_weights,
        knowledge: model.knowledge,
        releaseDate: model.release_date,
        lastUpdated: model.last_updated,
      }))
  );

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
        <div class="search-container">
          <input type="text" id="search" placeholder="Search models" />
          <span class="search-shortcut">⌘K</span>
        </div>
        <button id="help">How to use</button>
      </div>
    </header>
    <div id="table-viewport" class="table-viewport">
      <table id="models-table">
      <thead>
        <tr>
          <th class="sortable" data-type="text">
            Provider <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Model <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Family <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Provider ID <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Model ID <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="boolean">
            Tool Call <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="boolean">
            Reasoning <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="modalities">
            Input <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="modalities">
            Output <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="number">
            <div class="header-container">
              <span class="header-text">
                Input Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number">
            <div class="header-container">
              <span class="header-text">
                Output Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number">
            <div class="header-container">
              <span class="header-text">
                Reasoning Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number">
            <div class="header-container">
              <span class="header-text">
                Cache Read Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number">
            <div class="header-container">
              <span class="header-text">
                Cache Write Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number">
            <div class="header-container">
              <span class="header-text">
                Audio Input Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number">
            <div class="header-container">
              <span class="header-text">
                Audio Output Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number">
            Context Limit <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="number">
            Input Limit <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="number">
            Output Limit <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="boolean">
            Structured Output <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="boolean">
            Temperature <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Weights <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Knowledge <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Release Date <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Last Updated <span class="sort-indicator"></span>
          </th>
        </tr>
      </thead>
      <tbody id="models-table-body" dangerouslySetInnerHTML={{
        __html: TableRows.slice(0, INITIAL_ROW_COUNT).map((row, i) => renderRow(row, i)).join('')
      }} />
      </table>
    </div>
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
          <a href="/">Models.dev</a> is a comprehensive open-source database of
          AI model specifications, pricing, and features.
        </p>
        <p>
          There&apos;s no single database with information about all the
          available AI models. We started Models.dev as a community-contributed
          project to address this. We also use it internally in{" "}
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
          Use the <b>Model ID</b> field to do a lookup on any model; it&apos;s
          the identifier used by{" "}
          <a
            href="https://ai-sdk.dev/"
            target="_blank"
            rel="noopener noreferrer"
          >
            AI SDK
          </a>
          .
        </p>
        <h2>Logos</h2>
        <p>
          Provider logos are available at <code>/logos/{`{provider}`}.svg</code>{" "}
          where <code>{`{provider}`}</code> is the <b>Provider ID</b>.
        </p>
        <div class="code-block">
          <code>
            curl{" "}
            <a href="/logos/anthropic.svg">
              https://models.dev/logos/anthropic.svg
            </a>
          </code>
        </div>
        <p>
          If we don't have a provider's logo, a default logo is served instead.
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
          as TOML files; organized by provider and model. The logo is stored as
          an SVG. This is used to generate this page and power the API.
        </p>
        <p>
          We need your help keeping this up to date. Feel free to edit the data
          and submit a pull request. Refer to the{" "}
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
        <a href="https://sst.dev" target="_blank" rel="noopener noreferrer">
          Created by SST
        </a>
      </div>
    </dialog>
    <script
      dangerouslySetInnerHTML={{
        __html: `window.__TABLE_DATA__ = ${JSON.stringify(TableRows)}`,
      }}
    ></script>
  </Fragment>
);
