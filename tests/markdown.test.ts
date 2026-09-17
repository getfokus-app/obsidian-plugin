import { describe, expect, it } from 'vitest';

import { canonicalBody } from '@/markdown/canonical';
import { readScalar, reassemble, splitFrontmatter } from '@/markdown/frontmatter';
import { sha256 } from '@/markdown/hash';

describe('splitFrontmatter', () => {
  it('separates frontmatter from body', () => {
    const { frontmatter, body, hasFrontmatter } = splitFrontmatter(
      '---\nfokus-id: abc\ntags: [a]\n---\n\n# Title\n\nBody.',
    );

    expect(hasFrontmatter).toBe(true);
    expect(frontmatter).toBe('fokus-id: abc\ntags: [a]');
    expect(body.trim()).toBe('# Title\n\nBody.');
  });

  it('handles an empty frontmatter block', () => {
    expect(splitFrontmatter('---\n---\nBody.')).toMatchObject({
      frontmatter: '',
      body: 'Body.',
      hasFrontmatter: true,
    });
  });

  it('handles CRLF', () => {
    expect(splitFrontmatter('---\r\nfokus-id: x\r\n---\r\nBody.').body).toBe('Body.');
  });

  /** A horizontal rule mid-document is not frontmatter. */
  it('does not treat a later --- as frontmatter', () => {
    const src = 'Intro\n\n---\n\nAfter.';
    expect(splitFrontmatter(src)).toMatchObject({
      hasFrontmatter: false,
      body: src,
    });
  });

  it('leaves a note with no frontmatter untouched', () => {
    expect(splitFrontmatter('# Title').body).toBe('# Title');
  });

  it('round-trips through reassemble', () => {
    const src = '---\nfokus-id: abc\n---\n\n# Title';
    const { frontmatter, body } = splitFrontmatter(src);

    expect(splitFrontmatter(reassemble(frontmatter, body)).frontmatter).toBe(frontmatter);
  });

  it('reassembles to just the body when there is no frontmatter', () => {
    expect(reassemble('', '# Title')).toBe('# Title');
  });
});

describe('readScalar', () => {
  it.each([
    ['plain', 'fokus-id: abc123', 'abc123'],
    ['double quoted', 'fokus-id: "abc123"', 'abc123'],
    ['single quoted', "fokus-id: 'abc123'", 'abc123'],
    ['extra spacing', 'fokus-id:    abc123   ', 'abc123'],
    ['among other keys', 'tags: [a]\nfokus-id: abc123\ntitle: x', 'abc123'],
  ])('reads a %s value', (_label, yaml, expected) => {
    expect(readScalar(yaml, 'fokus-id')).toBe(expected);
  });

  it.each([
    ['missing', 'title: x'],
    ['empty', 'fokus-id:'],
    ['a block scalar it should not guess at', 'fokus-id: |'],
  ])('returns undefined when the value is %s', (_label, yaml) => {
    expect(readScalar(yaml, 'fokus-id')).toBeUndefined();
  });

  /** A key that merely ends with the name is a different key. */
  it('does not match a suffix of another key', () => {
    expect(readScalar('not-fokus-id: abc', 'fokus-id')).toBeUndefined();
  });
});

describe('canonicalBody', () => {
  /**
   * The churn loop this exists to break: the server's canonical markdown keeps
   * whitespace-only lines, editors strip them, and an unstripped comparison
   * would see the file differ from canonical forever.
   */
  it('makes the server form and the editor form compare equal', () => {
    const fromServer = '- [ ] parent\n  \n  - [ ] child';
    const fromEditor = '- [ ] parent\n\n  - [ ] child';

    expect(canonicalBody(fromServer)).toBe(canonicalBody(fromEditor));
  });

  it.each([
    ['CRLF', 'a\r\nb', 'a\nb'],
    ['trailing spaces on a line', 'a   \nb', 'a\nb'],
    ['trailing tabs', 'a\t\nb', 'a\nb'],
    ['leading blank lines', '\n\n# Title', '# Title'],
    ['trailing blank lines', '# Title\n\n\n', '# Title'],
  ])('normalizes %s', (_label, input, expected) => {
    expect(canonicalBody(input)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = canonicalBody('a  \r\n\n  b   \n\n');
    expect(canonicalBody(once)).toBe(once);
  });

  it('keeps indentation that carries meaning', () => {
    expect(canonicalBody('- a\n  - b')).toBe('- a\n  - b');
  });

  it.each([[''], [undefined as unknown as string]])('survives %p', (input) => {
    expect(canonicalBody(input)).toBe('');
  });
});

describe('sha256', () => {
  it('is stable and distinguishes content', async () => {
    const a = await sha256('hello');
    expect(await sha256('hello')).toBe(a);
    expect(await sha256('hello ')).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('frontmatter with a byte-order mark', () => {
  /**
   * A BOM once shifted the block out of match range, so `fokus-id` read as
   * absent and the file was adopted a second time — a duplicate note, and the
   * old frontmatter demoted into the note body.
   */
  it('still finds the block and the id', () => {
    const { frontmatter, hasFrontmatter } = splitFrontmatter('﻿---\nfokus-id: abc\n---\n\n# T');

    expect(hasFrontmatter).toBe(true);
    expect(readScalar(frontmatter, 'fokus-id')).toBe('abc');
  });
});
