/** @jsx jsx */
/** @jsxImportSource hono/jsx */

export function McpDirectoryPage() {
  return (
    <section class="table-section" data-mcp-directory>
      <div class="section-heading">
        <h3>MCP Servers</h3>
        <span id="mcp-count">…</span>
      </div>
      <div class="mcp-toolbar">
        <input
          id="mcp-filter"
          type="search"
          placeholder="Filter servers"
          autocomplete="off"
          spellcheck="false"
          aria-label="Filter MCP servers"
        />
        <p id="mcp-synced">
          Latest versions from the official MCP registry and the IranRouter marketplace.
        </p>
      </div>
      <div class="table-wrap">
        <table data-mcp-table>
          <caption class="sr-only">MCP servers</caption>
          <thead>
            <tr>
              <th class="sortable" data-mcp-sort="name" data-type="text" scope="col" aria-sort="ascending">
                <button type="button" class="sort-button">
                  Server
                  <span class="sort-indicator" aria-hidden="true">↑</span>
                </button>
              </th>
              <th scope="col">Description</th>
              <th class="sortable" data-mcp-sort="version" data-type="text" scope="col">
                <button type="button" class="sort-button">
                  Version
                  <span class="sort-indicator" aria-hidden="true"></span>
                </button>
              </th>
              <th scope="col">Transport</th>
              <th scope="col">Package</th>
              <th class="sortable" data-mcp-sort="updated" data-type="text" scope="col">
                <button type="button" class="sort-button">
                  Updated
                  <span class="sort-indicator" aria-hidden="true"></span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody id="mcp-rows">
            <tr>
              <td colspan={6}>Loading MCP servers…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mcp-pager" id="mcp-pager"></div>
    </section>
  );
}

export function McpDetailPage() {
  return (
    <div data-mcp-detail>
      <p class="mcp-loading" id="mcp-detail-status">
        Loading MCP server…
      </p>
      <div id="mcp-detail"></div>
    </div>
  );
}
