import { describe, expect, it } from 'vitest';

import { FokusApiError } from '@/api/errors';
import { HttpRequest } from '@/api/transport';
import { UploadsApi } from '@/api/uploads';

/**
 * `UploadsApi` had no unit coverage at all: the only thing reaching it was the
 * e2e suite, which is skipped unless a backend is running, so the default suite
 * was green with the upload path entirely unexecuted. That is the same shape as
 * the three harness-divergence bugs this plugin has already shipped.
 */
describe('UploadsApi', () => {
  const session = () => ({
    apiUrl: 'http://localhost:3000',
    token: 'tok',
    clientId: 'cid',
    workspaceId: 'ws',
  });

  const capture = (response: { status: number; json?: unknown }) => {
    const seen: HttpRequest[] = [];
    const api = new UploadsApi(session, async (request) => {
      seen.push(request);
      return response as never;
    });
    return { api, seen };
  };

  const png = new Uint8Array([1, 2, 3]).buffer;
  const input = {
    noteId: 'n1',
    filename: 'a.png',
    contentType: 'image/png',
    data: png,
  };

  it('posts multipart to the uploads endpoint with the session headers', async () => {
    const { api, seen } = capture({
      status: 201,
      json: { data: { url: '/v1/uploads/content/x' } },
    });

    await api.upload(input);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://localhost:3000/v1/uploads');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0]!.headers.Authorization).toBe('Bearer tok');
    expect(seen[0]!.headers['x-workspace-id']).toBe('ws');
    expect(seen[0]!.body).toBeInstanceOf(ArrayBuffer);
  });

  it('returns the URL the server put under data', async () => {
    const { api } = capture({
      status: 201,
      json: { data: { url: '/v1/uploads/content/abc' } },
    });

    expect(await api.upload(input)).toBe('/v1/uploads/content/abc');
  });

  /** A 429 must arrive as `rate-limited` or the engine cannot back off on it. */
  it('raises a rate-limited error on a 429', async () => {
    const { api } = capture({ status: 429, json: { message: 'Too many' } });

    await expect(api.upload(input)).rejects.toMatchObject({
      kind: 'rate-limited',
      status: 429,
    });
  });

  it('raises rather than returning undefined when the body carries no URL', async () => {
    const { api } = capture({ status: 201, json: { data: {} } });

    await expect(api.upload(input)).rejects.toThrow('Upload returned no URL');
  });

  it('reports a transport failure as offline', async () => {
    const api = new UploadsApi(session, async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(api.upload(input)).rejects.toMatchObject({ kind: 'offline' });
    await expect(api.upload(input)).rejects.toBeInstanceOf(FokusApiError);
  });

  it('omits the workspace header when no workspace is resolved', async () => {
    const seen: HttpRequest[] = [];
    const api = new UploadsApi(
      () => ({ apiUrl: 'http://localhost:3000/', token: 't', clientId: 'c' }),
      async (request) => {
        seen.push(request);
        return { status: 201, json: { data: { url: '/u/1' } } } as never;
      },
    );

    await api.upload(input);

    expect(seen[0]!.headers['x-workspace-id']).toBeUndefined();
    // the trailing slash must not produce `//v1/uploads`
    expect(seen[0]!.url).toBe('http://localhost:3000/v1/uploads');
  });
});
