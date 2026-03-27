/** @jsx jsx */
/** @jsxImportSource hono/jsx */

import { generate } from "models.dev";
import { Fragment } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import { existsSync } from "fs";
import path from "path";

export const Providers = await generate(
  path.join(import.meta.dir, "..", "..", "..", "providers")
);

// Function to load SVG content
const loadProviderSvg = async (providerId: string): Promise<string | null> => {
  const providerLogoPath = path.join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "providers",
    providerId,
    "logo.svg"
  );

  const defaultLogoPath = path.join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "providers",
    "logo.svg"
  );

  try {
    // Try provider-specific logo first
    if (existsSync(providerLogoPath)) {
      const file = Bun.file(providerLogoPath);
      return await file.text();
    }
    //
    // Fall back to default logo
    if (existsSync(defaultLogoPath)) {
      const file = Bun.file(defaultLogoPath);
      return await file.text();
    }
    return null;
  } catch (error) {
    console.warn(`Failed to load logo for provider ${providerId}:`, error);
    return null;
  }
};

// Create a cache of loaded SVGs at build time
const providerLogos = new Map<string, string>();

// Pre-load all provider logos
for (const [providerId] of Object.entries(Providers)) {
  const svgContent = await loadProviderSvg(providerId);
  if (svgContent) {
    providerLogos.set(providerId, svgContent);
  }
}

// Extract viewBox and inner content from an SVG string for <symbol> creation
function parseSvgForSymbol(svgStr: string): { viewBox: string; inner: string } {
  const viewBoxMatch = svgStr.match(/viewBox="([^"]*)"/);
  const viewBox = viewBoxMatch ? viewBoxMatch[1] : "0 0 24 24";
  // Extract content between <svg ...> and </svg>
  const innerMatch = svgStr.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
  const inner = innerMatch ? innerMatch[1].trim() : "";
  return { viewBox, inner };
}

// Build SVG defs block with all symbols
function buildSvgDefs(): string {
  let symbols = "";

  // Modality icon symbols
  symbols += `<symbol id="icon-text" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,7 4,4 20,4 20,7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></symbol>`;
  symbols += `<symbol id="icon-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></symbol>`;
  symbols += `<symbol id="icon-audio" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="m19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></symbol>`;
  symbols += `<symbol id="icon-video" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"></path><rect width="14" height="12" x="2" y="6" rx="2" ry="2"></rect></symbol>`;
  symbols += `<symbol id="icon-pdf" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14,2 14,8 20,8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10,9 9,9 8,9"></polyline></symbol>`;

  // Copy/check icon symbols
  symbols += `<symbol id="icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="m4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></symbol>`;
  symbols += `<symbol id="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20,6 9,17 4,12"/></symbol>`;

  // Provider logo symbols
  for (const [providerId, svgContent] of providerLogos.entries()) {
    const { viewBox, inner } = parseSvgForSymbol(svgContent);
    symbols += `<symbol id="logo-${providerId}" viewBox="${viewBox}">${inner}</symbol>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:none"><defs>${symbols}</defs></svg>`;
}

const svgDefsBlock = buildSvgDefs();

const getModalityIcon = (modality: string) => {
  const iconId = `icon-${modality}`;
  const tooltip = modality.charAt(0).toUpperCase() + modality.slice(1);
  return (
    <span class="modality-icon" data-tooltip={tooltip}>
      <svg width="16" height="16"><use href={`#${iconId}`} /></svg>
    </span>
  );
};

function renderProviderLogo(providerId: string) {
  return (
    <span class="provider-logo">
      <svg width="16" height="16"><use href={`#logo-${providerId}`} /></svg>
    </span>
  );
}

const renderCost = (cost?: number) => {
  return cost === undefined ? "-" : `$${cost.toFixed(2)}`;
};

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
          <button id="filter-toggle" class="filter-toggle" aria-expanded="false" title="Toggle filters">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
            </svg>
            <span id="filter-badge" class="filter-badge" hidden></span>
          </button>
          <span class="search-shortcut">⌘K</span>
        </div>
        <button id="help">How to use</button>
      </div>
    </header>
    <div id="filter-bar" class="filter-bar" hidden>
      <div class="filter-bar-inner">
        <div class="filter-group">
          <span class="filter-group-label">Features</span>
          <div class="filter-chips">
            <button class="filter-chip" data-filter="reasoning">Reasoning</button>
            <button class="filter-chip" data-filter="tool_call">Tool Call</button>
            <button class="filter-chip" data-filter="open_weights">Open Weights</button>
            <button class="filter-chip" data-filter="structured_output">Structured Output</button>
          </div>
        </div>
        <div class="filter-group">
          <span class="filter-group-label">Input</span>
          <div class="filter-chips">
            <button class="filter-chip" data-filter="input-text">Text</button>
            <button class="filter-chip" data-filter="input-image">Image</button>
            <button class="filter-chip" data-filter="input-audio">Audio</button>
            <button class="filter-chip" data-filter="input-video">Video</button>
            <button class="filter-chip" data-filter="input-pdf">PDF</button>
          </div>
        </div>
        <div class="filter-group">
          <span class="filter-group-label">Output</span>
          <div class="filter-chips">
            <button class="filter-chip" data-filter="output-text">Text</button>
            <button class="filter-chip" data-filter="output-image">Image</button>
            <button class="filter-chip" data-filter="output-audio">Audio</button>
            <button class="filter-chip" data-filter="output-video">Video</button>
          </div>
        </div>
        <div class="filter-group">
          <span class="filter-group-label">Status</span>
          <div class="filter-chips">
            <button class="filter-chip" data-filter="hide-deprecated">Hide Deprecated</button>
            <button class="filter-chip" data-filter="hide-beta">Hide Beta</button>
          </div>
        </div>
        <div class="filter-actions">
          <span id="filter-count" class="filter-count" hidden></span>
          <button id="clear-filters" class="filter-clear" hidden>Clear all</button>
        </div>
      </div>
    </div>
    <span dangerouslySetInnerHTML={{ __html: svgDefsBlock }} />
    <div id="scroll-sentinel-top" class="scroll-sentinel"></div>
    <table class="not-ready">
      <thead>
        <tr>
          <th class="sortable" data-type="text" data-column="provider">
            Provider <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text" data-column="model">
            Model <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text" data-column="family">
            Family <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text" data-column="provider-id">
            Provider ID <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text" data-column="model-id">
            Model ID <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="boolean" data-column="tool-call">
            Tool Call <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="boolean" data-column="reasoning">
            Reasoning <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="modalities" data-column="input">
            Input <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="modalities" data-column="output">
            Output <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="number" data-column="input-cost">
            <div class="header-container">
              <span class="header-text">
                Input Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number" data-column="output-cost">
            <div class="header-container">
              <span class="header-text">
                Output Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number" data-column="reasoning-cost">
            <div class="header-container">
              <span class="header-text">
                Reasoning Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number" data-column="cache-read-cost">
            <div class="header-container">
              <span class="header-text">
                Cache Read Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number" data-column="cache-write-cost">
            <div class="header-container">
              <span class="header-text">
                Cache Write Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number" data-column="audio-input-cost">
            <div class="header-container">
              <span class="header-text">
                Audio Input Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number" data-column="audio-output-cost">
            <div class="header-container">
              <span class="header-text">
                Audio Output Cost
                <br />
                <span class="desc">per 1M tokens</span>
              </span>
              <span class="sort-indicator"></span>
            </div>
          </th>
          <th class="sortable" data-type="number" data-column="context-limit">
            Context Limit <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="number" data-column="input-limit">
            Input Limit <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="number" data-column="output-limit">
            Output Limit <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="boolean" data-column="structured-output">
            Structured Output <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="boolean" data-column="temperature">
            Temperature <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text" data-column="weights">
            Weights <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text" data-column="knowledge">
            Knowledge <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text" data-column="release-date">
            Release Date <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text" data-column="last-updated">
            Last Updated <span class="sort-indicator"></span>
          </th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(Providers)
          .sort(([, providerA], [, providerB]) =>
            providerA.name.localeCompare(providerB.name)
          )
          .flatMap(([providerId, provider]) =>
            Object.entries(provider.models)
              .filter(([, model]) => model.status !== "alpha")
              .sort(([, modelA], [, modelB]) =>
                modelA.name.localeCompare(modelB.name)
              )
              .map(([modelId, model]) => (
                <tr
                  key={`${providerId}-${modelId}`}
                  data-provider={provider.name.toLowerCase()}
                  data-provider-id={providerId}
                  data-model={model.name.toLowerCase()}
                  data-model-id={modelId}
                  data-family={model.family ?? ""}
                  data-reasoning={model.reasoning ? "1" : "0"}
                  data-tool-call={model.tool_call ? "1" : "0"}
                  data-open-weights={model.open_weights ? "1" : "0"}
                  data-structured-output={model.structured_output === undefined ? "" : model.structured_output ? "1" : "0"}
                  data-temperature={model.temperature ? "1" : "0"}
                  data-attachment={model.attachment ? "1" : "0"}
                  data-input-modalities={model.modalities.input.join(",")}
                  data-output-modalities={model.modalities.output.join(",")}
                  data-input-cost={model.cost?.input?.toString() ?? ""}
                  data-output-cost={model.cost?.output?.toString() ?? ""}
                  data-context-limit={model.limit.context.toString()}
                  data-output-limit={model.limit.output.toString()}
                  data-status={model.status ?? ""}
                >
                  <td>
                    <div class="provider-cell">
                      {renderProviderLogo(providerId)}
                      <span>{provider.name}</span>
                    </div>
                  </td>
                  <td>{model.name}</td>
                  <td>{model.family ?? "-"}</td>
                  <td>{providerId}</td>
                  <td>
                    <div class="model-id-cell">
                      <span class="model-id-text">{modelId}</span>
                      <button
                        class="copy-button"
                        onclick={`copyModelId(this, '${modelId}')`}
                      >
                        <svg class="copy-icon" width="14" height="14"><use href="#icon-copy" /></svg>
                        <svg class="check-icon" width="14" height="14" style="display: none;"><use href="#icon-check" /></svg>
                      </button>
                    </div>
                  </td>
                  <td>{model.tool_call ? "Yes" : "No"}</td>
                  <td>{model.reasoning ? "Yes" : "No"}</td>
                  <td>
                    <div class="modalities">
                      {model.modalities.input.map((modality) =>
                        getModalityIcon(modality)
                      )}
                    </div>
                  </td>
                  <td>
                    <div class="modalities">
                      {model.modalities.output.map((modality) =>
                        getModalityIcon(modality)
                      )}
                    </div>
                  </td>
                  <td>{renderCost(model.cost?.input)}</td>
                  <td>{renderCost(model.cost?.output)}</td>
                  <td>{renderCost(model.cost?.reasoning)}</td>
                  <td>{renderCost(model.cost?.cache_read)}</td>
                  <td>{renderCost(model.cost?.cache_write)}</td>
                  <td>{renderCost(model.cost?.input_audio)}</td>
                  <td>{renderCost(model.cost?.output_audio)}</td>
                  <td>{model.limit.context.toLocaleString()}</td>
                  <td>{model.limit.input?.toLocaleString() ?? "-"}</td>
                  <td>{model.limit.output.toLocaleString()}</td>
                  <td>
                    {model.structured_output === undefined
                      ? "-"
                      : model.structured_output
                        ? "Yes"
                        : "No"}
                  </td>
                  <td>{model.temperature ? "Yes" : "No"}</td>
                  <td>{model.open_weights ? "Open" : "Closed"}</td>
                  <td>
                    {model.knowledge ? model.knowledge.substring(0, 7) : "-"}
                  </td>
                  <td>{model.release_date}</td>
                  <td>{model.last_updated}</td>
                </tr>
              ))
          )}
      </tbody>
    </table>
    <div id="scroll-sentinel" class="scroll-sentinel"></div>
    <div id="ghost-container" class="ghost-container"></div>
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
        <h2>Search</h2>
        <p>
          The search bar supports natural language and keyword filters. Combine them freely.
        </p>
        <p><b>Examples</b></p>
        <div class="code-block">
          <code>bedrock claude sort:input</code>
        </div>
        <div class="code-block">
          <code>in:image out:text in:&lt;5 out:&lt;15</code>
        </div>
        <p><b>Filter keywords</b></p>
        <table class="help-table">
          <tbody>
            <tr><td><code>in:</code></td><td>Input modality or cost — <code>in:image</code>, <code>in:&lt;5</code></td></tr>
            <tr><td><code>out:</code></td><td>Output modality or cost — <code>out:video</code>, <code>out:&lt;15</code></td></tr>
            <tr><td><code>ctx:</code></td><td>Context limit — <code>ctx:&gt;100k</code></td></tr>
            <tr><td><code>p:</code></td><td>Provider — <code>p:openai</code></td></tr>
            <tr><td><code>f:</code></td><td>Family — <code>f:gpt</code></td></tr>
            <tr><td><code>status:</code></td><td>Status — <code>status:deprecated</code></td></tr>
          </tbody>
        </table>
        <p><b>Sort keywords</b> — prefix with <code>-</code> for descending (input/ -input)</p>
        <table class="help-table">
          <tbody>
            <tr><td><code>sort:input</code></td><td>Input cost</td></tr>
            <tr><td><code>sort:output</code></td><td>Output cost</td></tr>
            <tr><td><code>sort:reasoning</code></td><td>Reasoning cost</td></tr>
            <tr><td><code>sort:cache-r</code></td><td>Cache read cost</td></tr>
            <tr><td><code>sort:cache-w</code></td><td>Cache write cost</td></tr>
            <tr><td><code>sort:audio-in</code></td><td>Audio input cost</td></tr>
            <tr><td><code>sort:audio-out</code></td><td>Audio output cost</td></tr>
            <tr><td><code>sort:context</code></td><td>Context limit</td></tr>
            <tr><td><code>sort:release</code></td><td>Release date</td></tr>
            <tr><td><code>sort:update</code></td><td>Last updated</td></tr>
          </tbody>
        </table>
        <p>
          Numbers support <code>k</code> and <code>m</code> suffixes. Multiple words use AND logic.
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
  </Fragment>
);
