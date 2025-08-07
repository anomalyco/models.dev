/** @jsx jsx */
/** @jsxImportSource hono/jsx */

import { generate } from "@merlin/core";
import { Fragment } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import path from "path";

export const Providers = await generate(
  path.join(import.meta.dir, "..", "..", "..", "providers")
);

export const Rendered = renderToString(
  <Fragment>
    <header>
      <div class="left">
        <h1>Nate Papes</h1>
        <span class="slash"></span>
        <p>Contents</p>
      </div>
      <div class="right">
        <div class="search-container">
          <input
            type="text"
            id="search"
            placeholder="Filter contents"
            autofocus
          />
          <span class="search-shortcut">⌘K</span>
        </div>
      </div>
    </header>

    <table>
      <thead>
        <tr>
          <th class="sortable" data-type="text">
            Title <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="date">
            Published <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Site <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="number">
            Time Est.<span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Link <span class="sort-indicator"></span>
          </th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(Providers)
          .sort(([, providerA], [, providerB]) =>
            providerA.name.localeCompare(providerB.name)
          )
          .flatMap(([providerId, provider]) =>
            provider.contents
              ? Object.entries(provider.contents)
                  .sort(
                    ([, contentA], [, contentB]) =>
                      new Date(contentB.created_at).getTime() -
                      new Date(contentA.created_at).getTime()
                  )
                  .map(([contentId, content]) => (
                    <tr key={`${providerId}-${contentId}`}>
                      <td>
                        <strong>{content.title}</strong>
                        {content.description && (
                          <div class="content-description">
                            {content.description.slice(0, 45)}
                            {content.description.length > 45 ? "..." : ""}
                          </div>
                        )}
                      </td>
                      <td>
                        {new Date(content.created_at).toLocaleDateString(
                          "en-US",
                          {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          }
                        )}
                      </td>
                      <td>
                        {new URL(content.url).hostname.replace("www.", "")}
                      </td>
                      <td>
                        {content.estimated_time_minutes !== undefined
                          ? `${content.estimated_time_minutes} min${
                              content.estimated_time_minutes > 1 ? "s" : ""
                            }`
                          : "-"}
                      </td>
                      <td>
                        <a
                          href={content.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          goto →
                        </a>
                      </td>
                    </tr>
                  ))
              : []
          )}
      </tbody>
    </table>

    <footer class="site-footer">
      <div class="footer-left">
        <div class="footer-item">
          <a
            class="github"
            target="_blank"
            rel="noopener noreferrer"
            href="https://github.com/papes1ns/merlin"
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
        </div>
        <div class="footer-item">
          Version:{" "}
          {await Bun.file(
            path.join(import.meta.dir, "..", "..", "..", "VERSION")
          ).text()}
        </div>
        <img
          alt="merln"
          aria-label="merln"
          width="60"
          height="20"
          src="/favicon.svg"
        />
      </div>
      <div class="footer-right">
        <a href="#" id="open-terms" role="modal">
          Terms and Privacy
        </a>
      </div>
    </footer>

    <div id="terms-modal" class="modal">
      <div class="modal-content terms">
        <h2>Terms and Privacy</h2>
        <section>
          <h3>Terms</h3>
          <p>
            The JSON API is available at{" "}
            <a href="/api.json" target="_blank">
              /api.json
            </a>
          </p>
          <p>
            There is a ruleset for crawlers in the{" "}
            <a href="/robots.txt" target="_blank">
              /robots.txt
            </a>{" "}
            file.
          </p>
          <p>
            Contact me at{" "}
            <a href="mailto:hello@natepapes.com" target="_blank">
              hello@natepapes.com
            </a>
          </p>
        </section>
        <section>
          <h3>Privacy</h3>
          <p>PII is not collected.</p>
          <p>Cloudflare sets cookies to keep the service protected.</p>
        </section>
        <section>
          <h3>Acknowledgements</h3>
          <p>
            This project was forked from the{" "}
            <a href="https://models.dev" target="_blank">
              models.dev
            </a>{" "}
            project built by the{" "}
            <a href="https://sst.dev" target="_blank">
              SST team
            </a>
            .
          </p>
        </section>
        <button id="close-terms">Close</button>
      </div>
    </div>
  </Fragment>
);
