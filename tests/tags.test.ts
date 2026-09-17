import { describe, expect, it } from 'vitest';

import { collectTags, extractFrontmatterTags, extractInlineTags } from '@/markdown/tags';

describe('extractInlineTags', () => {
  it.each([
    ['at the start of a line', '#project\n\nBody.', ['project']],
    ['mid-sentence', 'Filed under #work today.', ['work']],
    ['nested', 'See #area/projects/alpha.', ['area/projects/alpha']],
    ['with dashes and underscores', '#in-progress and #to_read', ['in-progress', 'to_read']],
    ['accented', '#café', ['café']],
    ['several', '#a #b #a', ['a', 'b']],
  ])('finds a tag %s', (_label, body, expected) => {
    expect(extractInlineTags(body)).toEqual(expected);
  });

  /**
   * Code is not something the user tagged. A `# heading` in a fenced block, a
   * hex colour, or a `#define` would otherwise create junk tags in Fokus.
   */
  it.each([
    ['a fenced block', '```md\n# heading\n#nottag\n```'],
    ['a tilde-fenced block', '~~~\n#nottag\n~~~'],
    ['an indented fence with a language', '  ```css\n  color: #1570EF;\n  ```'],
    ['inline code', 'Use `#include <stdio.h>` here.'],
    ['an Obsidian comment', '%% #hidden %%'],
  ])('ignores tags inside %s', (_label, body) => {
    expect(extractInlineTags(body)).toEqual([]);
  });

  it.each([
    ['a markdown heading', '# Heading\n\nBody.'],
    ['an all-digit anchor', 'See #1234 for detail.'],
    ['a tag mid-word', 'The language C# is fine. a#b too.'],
    ['a bare hash', 'Alone # here.'],
  ])('does not treat %s as a tag', (_label, body) => {
    expect(extractInlineTags(body)).toEqual([]);
  });

  /** Code is blanked, not deleted, so nothing on either side is joined. */
  it('does not fuse text across a removed code span', () => {
    expect(extractInlineTags('a`x`#tag')).toEqual([]);
    expect(extractInlineTags('a `x` #tag')).toEqual(['tag']);
  });

  it('tidies a trailing or doubled slash', () => {
    expect(extractInlineTags('#area/ and #a//b')).toEqual(['a/b', 'area']);
  });

  it('still finds tags after a fenced block', () => {
    expect(extractInlineTags('```\n#no\n```\n\n#yes')).toEqual(['yes']);
  });
});

describe('extractFrontmatterTags', () => {
  it.each([
    ['an inline array', 'tags: [work, urgent]', ['urgent', 'work']],
    ['a comma list', 'tags: work, urgent', ['urgent', 'work']],
    ['a YAML list', 'tags:\n  - work\n  - urgent', ['urgent', 'work']],
    ['quoted values', 'tags: ["work", \'urgent\']', ['urgent', 'work']],
    ['values written with a hash', 'tags: [#work]', ['work']],
  ])('reads %s', (_label, frontmatter, expected) => {
    expect(extractFrontmatterTags(frontmatter)).toEqual(expected);
  });

  it.each([
    ['no tags key', 'title: x'],
    ['an empty value', 'tags:'],
    ['an empty array', 'tags: []'],
  ])('returns nothing for %s', (_label, frontmatter) => {
    expect(extractFrontmatterTags(frontmatter)).toEqual([]);
  });

  it('does not swallow the next key as a tag', () => {
    expect(extractFrontmatterTags('tags: [a]\nfokus-id: abc')).toEqual(['a']);
  });
});

describe('collectTags', () => {
  it('merges both sources without duplicates', () => {
    expect(collectTags('tags: [work]', 'Filed under #work and #urgent.')).toEqual([
      'urgent',
      'work',
    ]);
  });
});

describe('extractInlineTags — code that is not a tag', () => {
  /**
   * Each of these was verified creating a real tag document in a Fokus account.
   * A missed tag is an inconvenience; an invented one is litter the user has to
   * clean up by hand.
   */
  it.each([
    ['an unclosed fence (a note mid-write)', '```\n#define X\n#include <y>\n\n#pragma once'],
    ['a four-backtick fence', '````\n#x\n````'],
    ['a four-backtick fence wrapping a three-backtick one', '````\n```\n#x\n```\n````'],
    ['a tilde fence closed by a longer one', '~~~\n#x\n~~~~'],
    ['an indented code block', 'Intro.\n\n    #indentedcode\n    more\n\nAfter.'],
    ['a tab-indented code block', 'Intro.\n\n\t#tabbed\n\nAfter.'],
    ['a code span across a line break', 'text `foo\n#bar` baz'],
    // The case that actually proves the span is blanked: the `#` here follows a
    // SPACE inside the span, so it matches the tag pattern on its own and is
    // excluded only because the span was removed. Every other inline-code case
    // passed because the `#` happened to follow a backtick.
    ['a tag mid-span, preceded by a space', 'run `git commit #tag here` now'],
    ['a tag in a multi-backtick span', 'see ``a #tag b`` here'],
    ['an HTML comment', '<!-- #hidden -->'],
    ['a multi-line HTML comment', '<!--\n#hidden\n-->'],
  ])('ignores tags inside %s', (_label, body) => {
    expect(extractInlineTags(body)).toEqual([]);
  });

  /**
   * The blanking must not over-reach either. An indented list continuation is
   * far more common than indented code, and blanking it would lose real tags.
   */
  it.each([
    ['a nested list item', '- parent\n    - child #real'],
    ['text after a closed fence', '```\n#no\n```\n\n#real'],
    ['text after an inline span', 'a `x` #real'],
    ['an indented line with no blank line before it', 'Intro.\n    #real'],
  ])('still finds a tag in %s', (_label, body) => {
    expect(extractInlineTags(body)).toEqual(['real']);
  });
});

describe('extractInlineTags — scripts and emoji', () => {
  /** Obsidian accepts these, and the product ships in ar/de/fr. */
  it.each([
    ['Japanese', '#タグ', 'タグ'],
    ['Chinese', '#中文', '中文'],
    ['Cyrillic', '#Привет', 'Привет'],
    ['Arabic', '#مهم', 'مهم'],
    ['Greek', '#Ελλάδα', 'Ελλάδα'],
    ['German', '#Übung', 'Übung'],
    ['emoji', '#🔥', '🔥'],
  ])('keeps a %s tag', (_label, body, expected) => {
    expect(extractInlineTags(body)).toEqual([expected]);
  });

  it.each([['#-'], ['#_'], ['#--']])('rejects %p as not a name', (body) => {
    expect(extractInlineTags(body)).toEqual([]);
  });
});

describe('extractFrontmatterTags — YAML shapes', () => {
  it.each([
    ['a zero-indent list', 'tags:\n- a\n- b', ['a', 'b']],
    ['a trailing YAML comment after a list', 'tags: [a, b] # yaml comment', ['a', 'b']],
    ['a trailing YAML comment after a plain value', 'tags: a, b # note', ['a', 'b']],
  ])('reads %s', (_label, frontmatter, expected) => {
    expect(extractFrontmatterTags(frontmatter)).toEqual(expected);
  });

  it.each([
    ['null', 'tags: null'],
    ['a tilde null', 'tags: ~'],
    ['a mapping', 'tags: {a: 1}'],
  ])('returns nothing for %s', (_label, frontmatter) => {
    expect(extractFrontmatterTags(frontmatter)).toEqual([]);
  });
});

describe('collectTags — case', () => {
  /**
   * Obsidian and Fokus both treat tags case-insensitively. Sending both forms
   * meant a case-sensitive lookup missed, the create was refused by a
   * case-insensitive uniqueness rule, and the note then failed on every sync.
   */
  it('treats tags differing only in case as one', () => {
    expect(collectTags('tags: [Work]', 'Filed under #work.')).toEqual(['Work']);
  });

  it('keeps genuinely different tags', () => {
    expect(collectTags('tags: [Work]', '#working')).toEqual(['Work', 'working']);
  });
});
