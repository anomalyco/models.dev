/** @jsx jsx */
/** @jsxImportSource hono/jsx */

import { existsSync } from "fs";
import { Fragment } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import { generate } from "models.dev";
import path from "path";

export const Providers = await generate(
  path.join(import.meta.dir, "..", "..", "..", "providers"),
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
    "logo.svg",
  );

  const defaultLogoPath = path.join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "providers",
    "logo.svg",
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

function renderProviderLogo(providerId: string) {
  const svgContent = providerLogos.get(providerId) || "";

  return <span dangerouslySetInnerHTML={{ __html: svgContent }} />;
}

const getModalityIcon = (modality: string) => {
  switch (modality) {
    case "text":
      return (
        <span class="modality-icon" data-tooltip="Text">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="4,7 4,4 20,4 20,7"></polyline>
            <line x1="9" y1="20" x2="15" y2="20"></line>
            <line x1="12" y1="4" x2="12" y2="20"></line>
          </svg>
        </span>
      );
    case "image":
      return (
        <span class="modality-icon" data-tooltip="Image">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect>
            <circle cx="9" cy="9" r="2"></circle>
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path>
          </svg>
        </span>
      );
    case "audio":
      return (
        <span class="modality-icon" data-tooltip="Audio">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <path d="m19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
          </svg>
        </span>
      );
    case "video":
      return (
        <span class="modality-icon" data-tooltip="Video">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m22 8-6 4 6 4V8Z"></path>
            <rect width="14" height="12" x="2" y="6" rx="2" ry="2"></rect>
          </svg>
        </span>
      );
    case "pdf":
      return (
        <span class="modality-icon" data-tooltip="PDF">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14,2 14,8 20,8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
            <polyline points="10,9 9,9 8,9"></polyline>
          </svg>
        </span>
      );
    default:
      return null;
  }
};

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
          <span class="search-shortcut">⌘K</span>
        </div>
        <div class="columns-container">
          <button id="columns-toggle" type="button">
            Columns
          </button>
          <div id="columns-picker" hidden></div>
        </div>
        <button id="help" type="button">
          How to use
        </button>
      </div>
    </header>
    <div id="table-scroll-container">
      <table id="main-table">
        <thead id="table-head"></thead>
        <tbody id="table-body"></tbody>
      </table>

    </div>
    <dialog id="modal">
      <div class="header">
        <h2>How to use</h2>
        <button id="close" type="button">
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
          If we don&apos;t have a provider&apos;s logo, a default logo is served
          instead.
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
  </Fragment>,
);
