// Fetch helpers for source modules.

/** GETs `url` and returns its JSON body. Throws on a non-2xx response, naming the source. */
export async function fetchJSON(url: string, options: { source: string; headers?: Record<string, string> }): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json", ...options.headers } });
  if (!response.ok) throw new Error(`${options.source} request failed: ${response.status} ${response.statusText} (${url})`);
  return response.json();
}

/** GETs `url` and returns its body as text. Throws on a non-2xx response, naming the source. */
export async function fetchText(url: string, options: { source: string; headers?: Record<string, string> }): Promise<string> {
  const response = await fetch(url, { headers: options.headers });
  if (!response.ok) throw new Error(`${options.source} request failed: ${response.status} ${response.statusText} (${url})`);
  return response.text();
}

/** An environment variable, or an error saying which sync needs it. */
export function requireEnv(source: string, ...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  throw new Error(`${source} sync requires ${names.join(" or ")}`);
}

export const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });
