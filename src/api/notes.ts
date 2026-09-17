import { FokusClient } from './client';
import { ListQuery, buildListQuery } from './filter-builder';

export interface FokusNote {
  _id: string;
  title?: string;
  /** Markdown when the request asked for it, otherwise stringified TipTap JSON. */
  content: string;
  sourceOriginalId?: string;
  updatedAt: string;
  icon?: string;
  editLock?: { owner: string; label?: string; expiresAt: string };
}

export interface CreateNoteInput {
  title: string;
  content: string;
  source: string;
  sourceOriginalId: string;
  icon?: string;
  /** null clears it; omitting it leaves whatever is there. */
  bucket?: string | null;
  tags?: string[];
}

/**
 * Notes as this plugin uses them: always in markdown.
 *
 * `contentFormat=markdown` is what keeps a single converter on the server. A
 * client with its own copy drifts from the server's the moment either is fixed,
 * and its idea of "canonical" then differs — which rewrites the file on every
 * sync. Creating returns the server's normalised markdown in the same response,
 * so adopting a file takes one round trip.
 */
export class NotesApi {
  constructor(private client: FokusClient) {}

  async create(input: CreateNoteInput): Promise<FokusNote> {
    const { data } = await this.client.request<{ data: FokusNote }>('/v1/notes', {
      method: 'POST',
      body: input,
      query: 'contentFormat=markdown',
    });
    return data;
  }

  async update(id: string, patch: Partial<CreateNoteInput>): Promise<FokusNote> {
    const { data } = await this.client.request<{ data: FokusNote }>(`/v1/notes/${id}`, {
      method: 'PUT',
      body: patch,
      query: 'contentFormat=markdown',
    });
    return data;
  }

  async get(id: string): Promise<FokusNote> {
    const { data } = await this.client.request<{ data: FokusNote }>(`/v1/notes/${id}`, {
      query: 'contentFormat=markdown',
    });
    return data;
  }

  async list(query: ListQuery): Promise<FokusNote[]> {
    const { data } = await this.client.request<{ data: FokusNote[] }>('/v1/notes', {
      query: buildListQuery({ ...query, contentFormat: 'markdown' }),
    });
    return data ?? [];
  }

  /** Take or renew the edit lock while this vault is the one writing. */
  async lock(id: string, owner: string, label?: string): Promise<void> {
    await this.client.request(`/v1/notes/${id}/lock`, {
      method: 'POST',
      body: { owner, ...(label ? { label } : {}) },
    });
  }

  async unlock(id: string): Promise<void> {
    await this.client.request(`/v1/notes/${id}/lock`, { method: 'DELETE' });
  }
}
