import { describe, expect, it } from 'vitest';

import { buildListQuery, eq, since } from '@/api/filter-builder';
import { isOptedOut, isPathInScope } from '@/settings/scope';

describe('isPathInScope', () => {
  const settings = { folders: ['Work', 'Areas/Projects'] };

  it.each([
    ['a note directly in a synced folder', 'Work/note.md'],
    ['a note nested deeper', 'Work/sub/deep/note.md'],
    ['a note in a nested synced folder', 'Areas/Projects/note.md'],
  ])('includes %s', (_label, path) => {
    expect(isPathInScope(path, settings)).toBe(true);
  });

  /** Segment matching, not string prefixes: `Work` must not capture `Workshop`. */
  it('does not capture a folder that merely starts with the same letters', () => {
    expect(isPathInScope('Workshop/note.md', settings)).toBe(false);
    expect(isPathInScope('Areas/ProjectsOld/note.md', settings)).toBe(false);
  });

  it.each([
    ['a note outside every synced folder', 'Personal/note.md'],
    ['a non-markdown file', 'Work/image.png'],
    ['a canvas', 'Work/board.canvas'],
  ])('excludes %s', (_label, path) => {
    expect(isPathInScope(path, settings)).toBe(false);
  });

  it('tolerates slashes around a configured folder', () => {
    expect(isPathInScope('Work/note.md', { folders: ['/Work/'] })).toBe(true);
  });

  /** A freshly installed plugin must sync nothing until told what to sync. */
  it.each([[[]], [['']], [undefined as unknown as string[]]])(
    'syncs nothing when folders is %p',
    (folders) => {
      expect(isPathInScope('Work/note.md', { folders })).toBe(false);
    },
  );
});

describe('isOptedOut', () => {
  it.each([['false'], ['False'], ['FALSE'], ['  false  ']])('opts out on %p', (value) => {
    expect(isOptedOut(value)).toBe(true);
  });

  /** Anything ambiguous keeps syncing — silently dropping a note is the worse failure. */
  it.each([[undefined], [''], ['true'], ['no'], ['0'], ['nope']])(
    'keeps syncing on %p',
    (value) => {
      expect(isOptedOut(value as string | undefined)).toBe(false);
    },
  );
});

describe('buildListQuery', () => {
  it('encodes the filter as one JSON blob', () => {
    const qs = buildListQuery({ filter: { source: eq('abc') } });

    expect(new URLSearchParams(qs).get('filter')).toBe('{"source":{"$eq":"abc"}}');
  });

  it('builds the incremental pull query', () => {
    const qs = buildListQuery({
      filter: {
        source: eq('src1'),
        updatedAt: since('2026-09-16T00:00:00.000Z'),
      },
      sort: '-updatedAt',
      limit: 100,
      contentFormat: 'markdown',
    });
    const params = new URLSearchParams(qs);

    expect(JSON.parse(params.get('filter')!)).toEqual({
      source: { $eq: 'src1' },
      updatedAt: { $gte: '2026-09-16T00:00:00.000Z' },
    });
    expect(params.get('sort')).toBe('-updatedAt');
    expect(params.get('limit')).toBe('100');
    expect(params.get('contentFormat')).toBe('markdown');
  });

  /** A bare scalar is rejected by the parser — every value must carry an operator. */
  it('wraps scalars in an operator', () => {
    expect(eq('x')).toEqual({ $eq: 'x' });
    expect(since('t')).toEqual({ $gte: 't' });
  });

  it('omits an empty filter rather than sending {}', () => {
    expect(buildListQuery({ filter: {} })).toBe('');
    expect(buildListQuery({})).toBe('');
  });
});
