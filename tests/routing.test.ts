import { describe, expect, it } from 'vitest';

import { bucketForPath } from '@/settings/scope';

describe('bucketForPath', () => {
  it('maps a note in a mapped folder', () => {
    expect(bucketForPath('Work/note.md', { Work: 'bucket-work' })).toBe('bucket-work');
  });

  it('maps a note nested deeper', () => {
    expect(bucketForPath('Work/a/b/note.md', { Work: 'bucket-work' })).toBe('bucket-work');
  });

  /** The specific mapping has to win, whichever order the keys arrive in. */
  it.each([
    [{ Work: 'general', 'Work/Clients': 'clients' }],
    [{ 'Work/Clients': 'clients', Work: 'general' }],
  ])('prefers the longest matching folder (%#)', (mappings) => {
    expect(bucketForPath('Work/Clients/acme.md', mappings)).toBe('clients');
  });

  it('returns nothing when no folder matches', () => {
    expect(bucketForPath('Personal/note.md', { Work: 'bucket-work' })).toBeUndefined();
  });

  /** Segment matching, not prefixes: `Work` must not capture `Workshop`. */
  it('does not match a folder that merely starts the same', () => {
    expect(bucketForPath('Workshop/note.md', { Work: 'bucket-work' })).toBeUndefined();
  });

  /**
   * These come from the Fokus UI, where a stray space or the wrong case is easy
   * to type — and used to mean silence rather than a mapping.
   */
  it.each([
    ['a trailing space', { 'Work ': 'b' }],
    ['a leading space', { ' Work': 'b' }],
    ['a trailing slash', { 'Work/': 'b' }],
    ['a leading slash', { '/Work': 'b' }],
    ['a Windows separator', { 'Work\\Sub': 'b' }],
    ['different case', { work: 'b' }],
  ])('tolerates %s', (_label, mappings) => {
    const path = Object.keys(mappings)[0]!.includes('\\') ? 'Work/Sub/note.md' : 'Work/note.md';
    expect(bucketForPath(path, mappings)).toBe('b');
  });

  it.each([
    ['an empty key', { '': 'b' }],
    ['a slash-only key', { '/': 'b' }],
    ['a whitespace key', { '   ': 'b' }],
    ['an empty bucket id', { Work: '' }],
  ])('ignores %s', (_label, mappings) => {
    expect(bucketForPath('Work/note.md', mappings)).toBeUndefined();
  });

  it.each([[{}], [undefined as unknown as Record<string, string>]])(
    'returns nothing for %p',
    (mappings) => {
      expect(bucketForPath('Work/note.md', mappings)).toBeUndefined();
    },
  );
});
