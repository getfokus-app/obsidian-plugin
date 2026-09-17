/**
 * Tag extraction.
 *
 * Whatever comes out of here becomes a tag document in someone's Fokus account,
 * so the bias is against guessing: a missed tag is an inconvenience, an invented
 * one is litter the user has to clean up by hand.
 *
 * A tag is `#` followed by letters, digits, `_`, `-`, `/` or emoji, in any
 * script — Obsidian accepts `#中文` and `#مهم`, and restricting to Latin would
 * silently drop them. It cannot be all digits (that is an issue number or a
 * heading anchor), it must contain something namelike, and it has to start a
 * word, so `C#` and `a#b` are not tags.
 */

/**
 * `#tag`, preceded by start-of-line or whitespace.
 *
 * `\p{L}\p{N}\p{M}` covers every script; `\p{Extended_Pictographic}` covers
 * emoji, which Obsidian allows and which are common in tag names.
 */
const TAG = /(^|\s)#([\p{L}\p{N}\p{M}\p{Extended_Pictographic}_/-]+)/gu;

/** At least one letter, digit or emoji — `#-` and `#_` are not names. */
const NAMELIKE = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/**
 * Blank out fenced code, line by line.
 *
 * A scan rather than a regex because the cases that matter are awkward to
 * express: a fence of four or more markers (the standard way to embed a
 * three-backtick block), a closing fence that must be at least as long as its
 * opener and of the same character, and a fence that is never closed at all —
 * which is what a note looks like while it is being written. A regex `$` under
 * the `m` flag means end-of-line, so the unclosed case silently stopped after
 * one line and leaked the rest as tags.
 */
function blankFences(body: string): string {
  let open: string | undefined;

  return body
    .split('\n')
    .map((line) => {
      const marker = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];

      if (open === undefined) {
        const opener = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
        if (opener) open = opener;
        return opener ? blankLine(line) : line;
      }

      // closes only on the same character, at least as long
      if (marker && marker[0] === open[0] && marker.length >= open.length) open = undefined;
      return blankLine(line);
    })
    .join('\n');
}

function blankLine(line: string): string {
  return line.replace(/[^\n]/g, '.');
}

/**
 * Inline code. Newlines are allowed inside a span — CommonMark permits it and
 * people wrap long commands — and the closing run must match the opening one.
 */
const INLINE_CODE = /(`+)[\s\S]*?\1/g;

/** Obsidian comments and HTML comments are both invisible in the rendered note. */
const OBSIDIAN_COMMENT = /%%[\s\S]*?%%/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * An indented code block: a run of lines indented four or more spaces that
 * begins after a blank line.
 *
 * Deliberately narrow. Indented lines are far more often list continuations
 * than code, and blanking those would lose real tags — requiring the preceding
 * blank line is what keeps list bodies out of it.
 */
const INDENTED_CODE = /(?<=\n[ \t]*\n)(?: {4,}|\t)[^\n]*(?:\n(?:(?: {4,}|\t)[^\n]*|[ \t]*))*/g;

/**
 * Blank code out, preserving length and line structure.
 *
 * The filler is `.` rather than a space on purpose. Spaces would manufacture
 * the very whitespace a tag needs in front of it, so `` a`x`#tag `` — where
 * `#tag` follows a backtick and is therefore not a tag — would start matching
 * once the span was blanked.
 */
function withoutCode(body: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, '.');

  return blankFences(`\n${body ?? ''}`)
    .replace(OBSIDIAN_COMMENT, blank)
    .replace(HTML_COMMENT, blank)
    .replace(INDENTED_CODE, blank)
    .replace(INLINE_CODE, blank)
    .slice(1);
}

function normalizeTag(raw: string): string | undefined {
  const tag = raw.replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  if (!tag || /^\d+$/.test(tag) || !NAMELIKE.test(tag)) return undefined;
  return tag;
}

/**
 * Whether a given offset falls inside code.
 *
 * Shares the blanking the tag scanner uses, so "inside a fence" means the same
 * thing for an embed as it does for a tag rather than being decided twice.
 */
export function isInsideCode(body: string): (index: number) => boolean {
  const blanked = withoutCode(body ?? '');
  return (index) => blanked[index] === '.' && (body ?? '')[index] !== '.';
}

export function extractInlineTags(body: string): string[] {
  const found = new Set<string>();

  for (const match of withoutCode(body).matchAll(TAG)) {
    const tag = normalizeTag(match[2]!);
    if (tag) found.add(tag);
  }

  return [...found].sort();
}

/**
 * Frontmatter `tags:`, in the shapes Obsidian and hand-written YAML produce:
 * `tags: [a, b]`, `tags: a, b`, and a `- ` list whether or not it is indented.
 */
export function extractFrontmatterTags(frontmatter: string): string[] {
  // [ \t]* not \s*: \s matches newlines, so a list's first item was being
  // swallowed as if it were an inline value.
  const block = /^tags[ \t]*:[ \t]*([^\n]*)((?:\n[ \t]*-[ \t]*[^\n]*)*)/m.exec(frontmatter ?? '');
  if (!block) return [];

  const listed = (block[2] ?? '').split('\n').map((line) => line.replace(/^[ \t]*-[ \t]*/, ''));

  return [...new Set([...splitInlineValue(block[1] ?? ''), ...listed])]
    .map(cleanValue)
    .filter((tag): tag is string => tag !== undefined)
    .sort();
}

/**
 * The inline half of `tags:`, which may be `[a, b]`, `a, b`, or nothing.
 *
 * A trailing `# comment` is stripped, but only outside a bracketed list and
 * outside quotes — otherwise `tags: [a, b] # note` turned the whole tail into a
 * tag named `b] # note`, and that got created on the server.
 */
function splitInlineValue(value: string): string[] {
  const bracketed = /^\[([^\]]*)\]/.exec(value.trim());
  const inner = bracketed ? bracketed[1]! : value.replace(/(^|\s)#.*$/, '');
  return inner.split(',');
}

function cleanValue(raw: string): string | undefined {
  const value = raw
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^#/, '')
    .trim();

  // YAML nulls and structures are not tag names, and `null` as a literal tag is
  // almost certainly `tags:` left empty.
  if (!value || value === 'null' || value === '~' || /^[[{]/.test(value)) return undefined;
  return normalizeTag(value);
}

/**
 * Everything the note is tagged with, from either source.
 *
 * De-duplicated case-insensitively: Obsidian treats `#Work` and `#work` as one
 * tag, and so does Fokus, so sending both meant looking one up (a
 * case-sensitive miss), creating it, and being refused by a case-insensitive
 * uniqueness rule — the note then failed on every sync, for good.
 */
export function collectTags(frontmatter: string, body: string): string[] {
  const seen = new Map<string, string>();

  for (const tag of [...extractFrontmatterTags(frontmatter), ...extractInlineTags(body)]) {
    const key = tag.toLowerCase();
    if (!seen.has(key)) seen.set(key, tag);
  }

  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
