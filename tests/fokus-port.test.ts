import { describe, expect, it } from 'vitest';

import { FokusApiError } from '@/api/errors';
import { ApiFokusPort } from '@/sync/fokus-port';

/** Tag resolution is exercised in its own tests; here it is out of the way. */
const noTags = { resolve: async () => [] } as never;
const noUploads = { upload: async () => '/u/1' } as never;

const note = (id: string, content = '# X') => ({
  _id: id,
  content,
  title: 't',
  updatedAt: '2026-09-16T00:00:00.000Z',
});

/**
 * The port is where the wire protocol is handled, so the engine never sees it.
 * The in-memory fake cannot cover any of this — it has no HTTP.
 */
describe('ApiFokusPort.create', () => {
  it('returns the created note', async () => {
    const notes = {
      create: async () => note('n1'),
      get: async () => note('n1'),
    } as never;

    const result = await new ApiFokusPort(notes, 'src1', noTags, noUploads).create({
      title: 't',
      markdown: '# X',
      sourceOriginalId: 'uid-1',
    });

    expect(result.id).toBe('n1');
  });

  /**
   * The server hands back the note to adopt precisely so no second lookup is
   * needed — and a lookup would not find it anyway when the uniqueness index is
   * global but the list query is workspace-scoped.
   */
  it('adopts the existing note when the id is already taken', async () => {
    let fetched: string | undefined;
    const notes = {
      create: async () => {
        throw new FokusApiError('conflict', 409, 'already linked', {
          noteId: 'existing-1',
        });
      },
      get: async (id: string) => {
        fetched = id;
        return note(id, '# Already there');
      },
    } as never;

    const result = await new ApiFokusPort(notes, 'src1', noTags, noUploads).create({
      title: 't',
      markdown: '# X',
      sourceOriginalId: 'uid-1',
    });

    expect(fetched).toBe('existing-1');
    expect(result.markdown).toBe('# Already there');
  });

  /** A held edit lock also answers 409; only the body distinguishes them. */
  it('rethrows a 409 that is not a duplicate', async () => {
    const notes = {
      create: async () => {
        throw new FokusApiError('conflict', 409, 'being edited elsewhere', {
          lockedBy: 'obsidian',
        });
      },
      get: async () => note('n1'),
    } as never;

    await expect(
      new ApiFokusPort(notes, 'src1', noTags, noUploads).create({
        title: 't',
        markdown: '# X',
        sourceOriginalId: 'uid-1',
      }),
    ).rejects.toMatchObject({ kind: 'conflict' });
  });

  it.each([
    ['a 422 the markdown cannot carry', new FokusApiError('unrepresentable', 422, 'nope')],
    ['being offline', new FokusApiError('offline', 0, 'down')],
    ['a paywall', new FokusApiError('pro-required', 403, 'pro')],
  ])('rethrows %s', async (_label, error) => {
    const notes = {
      create: async () => {
        throw error;
      },
      get: async () => note('n1'),
    } as never;

    await expect(
      new ApiFokusPort(notes, 'src1', noTags, noUploads).create({
        title: 't',
        markdown: '# X',
        sourceOriginalId: 'uid-1',
      }),
    ).rejects.toBe(error);
  });
});
