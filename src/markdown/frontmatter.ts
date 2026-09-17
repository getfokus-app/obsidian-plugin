/**
 * YAML frontmatter handling.
 *
 * Splitting is not cosmetic. `marked` has no frontmatter rule, so frontmatter
 * left in place converts to a horizontal rule plus an `h2` — which would
 * destroy the `fokus-id` the whole file/note mapping depends on. Nothing is
 * ever sent to the server with frontmatter still attached.
 *
 * A leading byte-order mark is tolerated: without that the block went unseen,
 * the `fokus-id` read as absent, and the file was adopted a second time — a
 * duplicate note plus the old frontmatter demoted into the note body.
 *
 * Reading a single scalar is done line-wise rather than by parsing YAML: we
 * need exactly one key, and a partial parse cannot corrupt what it does not
 * understand. WRITING goes through Obsidian's `processFrontMatter` at the
 * adapter layer, which round-trips the rest of the document properly.
 */
export interface SplitNote {
  /** The YAML between the fences, without the fences. Empty when there is none. */
  frontmatter: string;
  /** Everything after the closing fence. */
  body: string;
  /** Whether a frontmatter block was present at all. */
  hasFrontmatter: boolean;
}

/** Matches a leading `---` block, including the empty `---\n---` case. */
const FRONTMATTER = /^\uFEFF?---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/;

export function splitFrontmatter(source: string): SplitNote {
  const match = FRONTMATTER.exec(source ?? '');
  if (!match) return { frontmatter: '', body: source ?? '', hasFrontmatter: false };

  return {
    frontmatter: match[1] ?? '',
    body: (source ?? '').slice(match[0].length),
    hasFrontmatter: true,
  };
}

export function reassemble(frontmatter: string, body: string): string {
  if (!frontmatter.trim()) return body;
  return `---\n${frontmatter.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/**
 * Read one top-level scalar key. Deliberately ignores nested and multi-line
 * values: the only keys this plugin reads are flat, and quietly returning
 * nothing is safer than guessing at YAML we did not parse.
 */
export function readScalar(frontmatter: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^${escaped}\\s*:\\s*(.*)$`, 'm').exec(frontmatter ?? '');
  if (!line) return undefined;

  const raw = line[1]!.trim();
  if (!raw || raw === '|' || raw === '>') return undefined;

  // strip a single layer of matching quotes
  const unquoted = /^(['"])([\s\S]*)\1$/.exec(raw);
  return (unquoted ? unquoted[2]! : raw).trim() || undefined;
}
