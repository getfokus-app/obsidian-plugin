import { FokusApiError, classify } from './errors';
import { HttpTransport, obsidianTransport } from './transport';

export interface FokusSession {
  apiUrl: string;
  token: string;
  /** Generated once per install. Must differ from every other Fokus client. */
  clientId: string;
  workspaceId?: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Set false for the few endpoints that must NOT be workspace-scoped. */
  workspace?: boolean;
  query?: string;
}

/**
 * The only way this plugin talks to Fokus.
 *
 * The transport is injected so the headless harness can drive this exact class
 * against a real backend; in Obsidian it defaults to `requestUrl` (see
 * transport.ts for why never `fetch`).
 */
export class FokusClient {
  constructor(
    private session: FokusSession,
    private transport: HttpTransport = obsidianTransport,
  ) {}

  update(session: Partial<FokusSession>): void {
    this.session = { ...this.session, ...session };
  }

  get workspaceId(): string | undefined {
    return this.session.workspaceId;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';

    // A write with no workspace header is the worst failure this API has: it
    // returns 201 and stores the note with no workspace, so it is invisible in
    // every Fokus client. There is no error to notice and no way to find the
    // note afterwards. Refuse locally rather than create one.
    if (options.workspace !== false && method !== 'GET' && !this.session.workspaceId) {
      throw new FokusApiError(
        'validation',
        0,
        'No workspace selected. This write would be saved outside every workspace and be invisible in Fokus.',
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.session.token}`,
      'x-client-id': this.session.clientId,
    };
    if (options.workspace !== false && this.session.workspaceId) {
      headers['x-workspace-id'] = this.session.workspaceId;
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const url = `${this.session.apiUrl.replace(/\/+$/, '')}${path}${options.query ? `?${options.query}` : ''}`;

    let response;
    try {
      response = await this.transport({
        url,
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      throw new FokusApiError('offline', 0, `Could not reach Fokus: ${String(error)}`);
    }

    if (response.status === 204) return undefined as T;

    const body = response.json as Record<string, unknown> | undefined;

    if (response.status >= 400) {
      const kind = classify(response.status, body);
      const message = Array.isArray(body?.message)
        ? (body!.message as string[]).join(', ')
        : String(body?.message ?? `HTTP ${response.status}`);
      throw new FokusApiError(kind, response.status, message, body);
    }

    return body as T;
  }
}
