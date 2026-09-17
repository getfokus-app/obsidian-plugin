import { eq, since } from '@/api/filter-builder';
import { FokusApiError } from '@/api/errors';
import { NotesApi } from '@/api/notes';
import { TagsApi } from '@/api/taxonomy';
import { UploadsApi } from '@/api/uploads';

import { FokusPort, NoteMissingError, PULL_PAGE_SIZE, RemoteNote } from './ports';

/**
 * The real Fokus, narrowed to what the engine needs.
 *
 * Every note carries `source` + `sourceOriginalId`. That pair is a unique index
 * on the server, which is what makes a re-sync update rather than duplicate —
 * and why `findBySourceOriginalId` can recover the whole mapping from nothing
 * but the ids in the vault's own frontmatter.
 */
export class ApiFokusPort implements FokusPort {
  constructor(
    private notes: NotesApi,
    private sourceId: string,
    private tags: TagsApi,
    private uploads: UploadsApi,
    /** Shown in Fokus as who holds the lock. */
    private vaultName?: string,
  ) {}

  async create(input: {
    title: string;
    markdown: string;
    sourceOriginalId: string;
    tagIds?: string[];
    bucketId?: string;
  }): Promise<RemoteNote> {
    try {
      const note = await this.notes.create({
        title: input.title,
        content: input.markdown,
        source: this.sourceId,
        sourceOriginalId: input.sourceOriginalId,
        ...(input.tagIds?.length ? { tags: input.tagIds } : {}),
        ...(input.bucketId ? { bucket: input.bucketId } : {}),
      });
      return toRemote(note);
    } catch (error) {
      // A duplicate is not a failure — it means this file is already linked, and
      // the server hands back the note to adopt exactly so no second lookup is
      // needed. Using it also covers the case a lookup cannot: the uniqueness
      // index is global while the list query is workspace-scoped, so the
      // existing note can be real and still invisible to a search. Without this
      // the file failed permanently and silently every time.
      const noteId = adoptableNoteId(error);
      if (noteId) return toRemote(await this.notes.get(noteId));
      throw error;
    }
  }

  async update(
    id: string,
    input: {
      title?: string;
      markdown?: string;
      tagIds?: string[];
      bucketId?: string | null;
    },
  ): Promise<RemoteNote> {
    try {
      const note = await this.notes.update(id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.markdown !== undefined ? { content: input.markdown } : {}),
        ...(input.tagIds !== undefined ? { tags: input.tagIds } : {}),
        // null clears the bucket; undefined leaves it. Dropping null meant
        // removing a folder mapping reported success and changed nothing.
        ...(input.bucketId !== undefined ? { bucket: input.bucketId } : {}),
      });
      return toRemote(note);
    } catch (error) {
      if (error instanceof FokusApiError && error.kind === 'not-found') {
        throw new NoteMissingError(id);
      }
      throw error;
    }
  }

  async resolveTags(names: string[]): Promise<string[]> {
    return names.length ? await this.tags.resolve(names) : [];
  }

  async listChangedSince(cursor: string): Promise<RemoteNote[]> {
    // Ascending, so paging by cursor actually advances. Newest-first returned
    // the same page forever and the tail was never seen again.
    const found = await this.notes.list({
      filter: { source: eq(this.sourceId), updatedAt: since(cursor) },
      sort: 'updatedAt',
      limit: PULL_PAGE_SIZE,
    });
    return found.map(toRemote);
  }

  async uploadAttachment(input: {
    noteId: string;
    filename: string;
    contentType: string;
    data: ArrayBuffer;
  }): Promise<string> {
    return await this.uploads.upload(input);
  }

  async lock(id: string): Promise<void> {
    await this.notes.lock(id, 'obsidian', this.vaultName);
  }

  async unlock(id: string): Promise<void> {
    await this.notes.unlock(id);
  }

  async findBySourceOriginalId(sourceOriginalId: string): Promise<RemoteNote | null> {
    const found = await this.notes.list({
      filter: {
        source: eq(this.sourceId),
        sourceOriginalId: eq(sourceOriginalId),
      },
      limit: 1,
    });
    return found.length ? toRemote(found[0]!) : null;
  }
}

function toRemote(note: {
  _id: string;
  content: string;
  title?: string;
  updatedAt: string;
  sourceOriginalId?: string;
}): RemoteNote {
  return {
    id: note._id,
    markdown: note.content,
    title: note.title,
    updatedAt: note.updatedAt,
    sourceOriginalId: note.sourceOriginalId,
  };
}

/**
 * The id of the note a 409 says already owns this external id.
 *
 * A held edit lock also answers 409, so the body decides which kind this is —
 * `kind` alone cannot tell them apart.
 */
function adoptableNoteId(error: unknown): string | undefined {
  if (!(error instanceof FokusApiError) || error.kind !== 'conflict') return undefined;
  const noteId = error.body?.noteId;
  return typeof noteId === 'string' ? noteId : undefined;
}
