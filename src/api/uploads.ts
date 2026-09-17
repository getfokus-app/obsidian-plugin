import { FokusApiError, classify } from './errors';
import { FokusSession } from './client';
import { buildMultipart } from './multipart';
import { HttpTransport, obsidianTransport } from './transport';

/**
 * File uploads.
 *
 * Separate from `FokusClient` because this is the one request that is not JSON:
 * it needs a hand-built multipart body and its own content type, and threading
 * that through the JSON client would complicate every other call for one case.
 *
 * The server requires an `entityId`, so the note must exist before its images
 * can be attached — which is why an adopted note is created, then uploaded to,
 * then updated with the rewritten body.
 */
export class UploadsApi {
  constructor(
    private session: () => FokusSession,
    /**
     * Injected for the same reason the JSON client's is: importing `requestUrl`
     * directly meant the headless harness could not drive this at all, so every
     * upload path was untested — which is how three images silently failed to
     * upload while the suite stayed green.
     */
    private transport: HttpTransport = obsidianTransport,
  ) {}

  async upload(input: {
    noteId: string;
    filename: string;
    contentType: string;
    data: ArrayBuffer;
  }): Promise<string> {
    const session = this.session();
    const { contentType, body } = buildMultipart(
      { entityType: 'note', entityId: input.noteId },
      {
        field: 'file',
        filename: input.filename,
        contentType: input.contentType,
        data: input.data,
      },
    );

    let response;
    try {
      response = await this.transport({
        url: `${session.apiUrl.replace(/\/+$/, '')}/v1/uploads`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'x-client-id': session.clientId,
          ...(session.workspaceId ? { 'x-workspace-id': session.workspaceId } : {}),
          'Content-Type': contentType,
        },
        body,
      });
    } catch (error) {
      throw new FokusApiError('offline', 0, `Could not reach Fokus: ${String(error)}`);
    }

    const parsed = (response.json ?? undefined) as Record<string, unknown> | undefined;
    if (response.status >= 400) {
      throw new FokusApiError(
        classify(response.status, parsed),
        response.status,
        String(parsed?.message ?? `HTTP ${response.status}`),
        parsed,
      );
    }

    const url = (parsed?.data as Record<string, unknown> | undefined)?.url ?? parsed?.url;
    if (typeof url !== 'string') {
      throw new FokusApiError('server', response.status, 'Upload returned no URL');
    }
    return url;
  }
}
