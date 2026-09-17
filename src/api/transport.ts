import { requestUrl } from 'obsidian';

/**
 * The one HTTP call the client makes, behind an interface.
 *
 * In Obsidian this is `requestUrl`; in the headless harness it is Node's fetch.
 * That swap is what lets the real engine and the real client be exercised
 * against a real backend without launching an editor — the alternative is
 * testing a copy of the code that ships, which tests nothing.
 */
export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** A string for JSON, an ArrayBuffer for a multipart upload. */
  body?: string | ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON, or undefined when the body was empty or not JSON. */
  json: unknown;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * Obsidian's `requestUrl`, never `fetch`.
 *
 * `fetch` from the renderer sends an `app://obsidian.md` Origin, which is not on
 * the backend's CORS allowlist, so every request fails. `requestUrl` goes
 * through Electron's main process and sends no Origin at all, which the backend
 * explicitly permits.
 *
 * The import is static on purpose. `obsidian` is marked external and Obsidian
 * supplies it through its own `require` shim, which a dynamic `import()` does
 * not go through — esbuild leaves `await import('obsidian')` in the output
 * verbatim and it throws at runtime, on every request, with no `node_modules`
 * to fall back to.
 */
export async function obsidianTransport(request: HttpRequest): Promise<HttpResponse> {
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body as string | ArrayBuffer | undefined,
    // We classify failures ourselves; the default throws away the body, which is
    // where noteId, lockedBy and unrepresentable live.
    throw: false,
  });

  let json: unknown;
  try {
    json = response.json;
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}
