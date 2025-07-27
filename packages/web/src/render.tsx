/** @jsx jsx */
/** @jsxImportSource hono/jsx */

import { generate } from "spin.dev";
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
          href="https://github.com/sst/spin.dev"
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
          <input type="text" id="search" placeholder="Filter articles" />
          <span class="search-shortcut">⌘K</span>
        </div>
      </div>
    </header>

    <table>
      <thead>
        <tr>
        <th class="sortable" data-type="text">
            Provider <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Title <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Published <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Site <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="number">
            Reading Time <span class="sort-indicator"></span>
          </th>
          <th class="sortable" data-type="text">
            Tags <span class="sort-indicator"></span>
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
            provider.articles ? Object.entries(provider.articles)
              .sort(([, articleA], [, articleB]) =>
                new Date(articleB.created_at).getTime() - new Date(articleA.created_at).getTime()
              )
              .map(([articleId, article]) => (
                <tr key={`${providerId}-${articleId}`}>
                  <td>
                    <strong>{article.title}</strong>
                    {article.description && (
                      <div style="font-size: 0.9em; color: #666; margin-top: 4px;">
                        {article.description.slice(0, 45)}...
                      </div>
                    )}
                  </td>
                  <td>
                    {new Date(article.created_at).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                  <td>{(() => {
                    try {
                      return new URL(article.url).hostname.replace("www.", "");
                    } catch {
                      return "-";
                    }
                  })()}</td>
                  <td>
                    {article.reading_time_minutes !== undefined
                      ? `${article.reading_time_minutes} min`
                      : "-"}
                  </td>
                  <td>
                    {article.tags && article.tags.length > 0
                      ? article.tags.join(", ")
                      : "-"}
                  </td>
                  <td>
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style="color: #0066cc; text-decoration: none;"
                    >
                      Read Article →
                    </a>
                  </td>
                </tr>
              )) : []
          )}
      </tbody>
    </table>
  </Fragment>
);
