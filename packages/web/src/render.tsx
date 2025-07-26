/** @jsx jsx */
/** @jsxImportSource hono/jsx */

import { generate } from "models.dev";
import { Fragment } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import path from "path";

export const Providers = await generate(
  path.join(import.meta.dir, "..", "..", "..", "providers")
);

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
        <h1>Nathan Papes</h1>
        <span class="slash"></span>
        <p>Software Consultant &amp; Developer</p>
        <span class="slash"></span>
        <p>A2</p>
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
          <input type="text" id="search" placeholder="Filter by model" />
          <span class="search-shortcut">⌘K</span>
        </div>
      </div>
    </header>

    <main>
      <section>
        <h2>About</h2>
        <p>
          Skateboarding was my favorite hobby growing up. Through exploring this hobby, I learned
          about computers because I wanted to make skateboard montage videos. Video editing was my
          introduction to learning how to Google technology questions properly. Little did I know
          that this experience would lay the foundation for my future.
        </p>
        <p>
          I took my first computer science course while in high school. I enjoyed the fast feedback
          and creative aspects that writing software offered. After this class, software felt like a
          viable career option for me, and I haven’t looked back since.
        </p>
        <p>
          I honed my software-building skills at CMU where I had my first programming job and
          completed my undergrad. After graduating I started my professional career building online
          wellness campaigns and cloud infrastructures to keep them online. I’ve led development
          projects, both working independently and with teams of engineers. Writing software is fun
          but the fulfillment from delivering something that is valuable to others is what keeps me
          motivated.
        </p>
        <p>
          Outside of work, I like spending time with family and friends. I embrace the outdoors in
          Michigan — snowboarding in the winter and skateboarding when it’s warmer.
        </p>
      </section>

      <section>
        <h2>Recent Blog Posts</h2>
        <ul>
          <li>
            <strong>Introducing SST v3 for Modern AWS Serverless Infrastructure</strong>
            <em>(June 24, 2025)</em>
          </li>
          <li>
            <strong>Aurora MySQL 8 Upgrade: Using the AWS Blue/Green Style</strong>
            <em>(February 12, 2025)</em>
          </li>
          <li>
            <strong>Optimize EF Core Database Query Performance</strong>
            <em>(October 29, 2024)</em>
          </li>
          <li>
            <strong>From Green to Great: Building Confidence in Consulting</strong>
            <em>(July 18, 2024)</em>
          </li>
        </ul>
      </section>

      <section>
        <h2>Connect</h2>
        <p>
          Learn more at
          <a href="https://atomicobject.com/team/nathan-papes" target="_blank" rel="noopener">
            atomicobject.com/team/nathan-papes
          </a>
        </p>
      </section>
    </main>



    <table>
      <thead>
        <tr>
          <th class="sortable" data-type="text">
            Provider <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Model <span class="sort-indicator"></span>
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
            Context Limit <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="number">
            Output Limit <span class="sort-indicator"></span>
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
      <tbody>
        {Object.entries(Providers)
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
                  <td class="model-id-cell">
                    <span class="model-id-text">{modelId}</span>
                    <button
                      class="copy-button"
                      onclick={`copyModelId(this, '${modelId}')`}
                    >
                      <svg
                        class="copy-icon"
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <rect
                          width="14"
                          height="14"
                          x="8"
                          y="8"
                          rx="2"
                          ry="2"
                        />
                        <path d="m4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                      </svg>
                      <svg
                        class="check-icon"
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        style="display: none;"
                      >
                        <polyline points="20,6 9,17 4,12" />
                      </svg>
                    </button>
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
                  <td>{renderCost(model.cost?.cache_read)}</td>
                  <td>{renderCost(model.cost?.cache_write)}</td>
                  <td>{model.limit.context.toLocaleString()}</td>
                  <td>{model.limit.output.toLocaleString()}</td>
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
  </Fragment>
);
