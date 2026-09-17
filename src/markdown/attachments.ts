/**
 * Embedded files, in both directions.
 *
 * The vault keeps its own link syntax and Fokus gets a URL it can render, and
 * neither side is asked to understand the other's. That means the file on disk
 * is left exactly as the user wrote it — rewriting `![[diagram.png]]` into a
 * signed URL would be a visible, permanent edit to their note in exchange for
 * something only Fokus needs.
 */

/**
 * Anything worth uploading. Kept in step with the server's ALLOWED_MIME_TYPES
 * (`backend/src/app.uploader.ts`) — `bmp` was listed here and is NOT accepted
 * there, so every sync re-attempted it, earned a 422, and spent an upload slot
 * doing it.
 */
const UPLOADABLE = /\.(png|jpe?g|gif|webp|svg|pdf)$/i;

export interface Embed {
  /** The whole match, e.g. `![[diagram.png]]` or `![alt](img/a.png)`. */
  raw: string;
  /** The file it points at, as written. */
  target: string;
  alt?: string;
}

/** `![[file.png]]`, optionally `|alt` or `|300`. */
const WIKI_EMBED = /!\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g;
/**
 * `![alt](path.png)`, in both forms.
 *
 * The angled variant is split out rather than made optional: angle brackets
 * exist so a path CAN contain spaces, and a pattern that excluded whitespace
 * from both forms silently skipped every attachment with a space in its name.
 */
const MD_EMBED = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))\s*\)/g;

/**
 * Every embed in the body that points at a file we could upload.
 *
 * Code is not scanned: an `![[x.png]]` inside a fenced block is an example of
 * the syntax, not a picture the user attached.
 */
export function findEmbeds(body: string, isCode: (index: number) => boolean): Embed[] {
  const found: Embed[] = [];

  for (const match of (body ?? '').matchAll(WIKI_EMBED)) {
    if (isCode(match.index!)) continue;
    const target = match[1]!.trim();
    if (UPLOADABLE.test(target)) found.push({ raw: match[0], target, alt: match[2]?.trim() });
  }

  for (const match of (body ?? '').matchAll(MD_EMBED)) {
    if (isCode(match.index!)) continue;
    const target = decodeTarget((match[2] ?? match[3] ?? '').trim());
    // Already a URL — it is somebody else's image, not a vault file.
    if (!target || /^[a-z]+:\/\//i.test(target) || /^data:/i.test(target)) continue;
    if (UPLOADABLE.test(target)) found.push({ raw: match[0], target, alt: match[1]?.trim() });
  }

  return found;
}

/**
 * Swap vault embeds for the URLs Fokus stores, on the way up.
 *
 * Anything without a URL is left exactly as written, so an upload that has not
 * happened yet degrades to the literal text rather than to a broken image.
 */
export function toWire(
  body: string,
  urls: Map<string, string>,
  /**
   * Defaults to "nothing is code" so existing callers keep working, but the
   * engine passes the real predicate: `findEmbeds` skips fenced blocks, and a
   * `toWire` that did not skip them rewrote the contents of a note explaining
   * the `![[...]]` syntax into signed URLs on the Fokus side.
   */
  isCode: (index: number) => boolean = () => false,
): string {
  const source = body ?? '';
  if (urls.size === 0) return source;

  const spans: { start: number; end: number; text: string }[] = [];
  for (const pattern of [WIKI_EMBED, MD_EMBED]) {
    for (const match of source.matchAll(pattern)) {
      const url = urls.get(match[0]);
      if (!url || isCode(match.index!)) continue;
      spans.push({
        start: match.index!,
        end: match.index! + match[0].length,
        text: renderImage(altOf(match[0]), url),
      });
    }
  }
  if (spans.length === 0) return source;
  spans.sort((a, b) => a.start - b.start);

  let out = '';
  let at = 0;
  for (const span of spans) {
    if (span.start < at) continue;
    out += source.slice(at, span.start) + span.text;
    at = span.end;
  }

  return out + source.slice(at);
}

/**
 * Swap them back on the way down, so the file keeps its own syntax.
 *
 * Keyed on the URL, which is what the server actually sends back; a URL we have
 * no record of is left alone, because it is an image added in Fokus and the
 * vault has no local file for it.
 */
export function fromWire(body: string, urls: Map<string, string>): string {
  let out = body ?? '';

  for (const [raw, url] of urls) {
    out = out.split(renderImage(altOf(raw), url)).join(raw);
    // The server may re-render the alt text; match on the URL alone as well.
    // A function, not a string: `$&` and `$1` in a filename are replacement
    // patterns, and `a$&b.png` spliced the whole match back into the name.
    out = out.replace(new RegExp(`!\\[[^\\]\\n]*\\]\\(${escapeRegex(url)}\\)`, 'g'), () => raw);
  }

  return out;
}

function renderImage(alt: string, url: string): string {
  return `![${alt}](${url})`;
}

/** The alt text a wiki embed carries, or the bare filename as a fallback. */
function altOf(raw: string): string {
  const wiki = /^!\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]$/.exec(raw);
  if (wiki) return (wiki[2] ?? wiki[1]!.split('/').pop() ?? '').trim();

  const md = /^!\[([^\]\n]*)\]/.exec(raw);
  return md?.[1]?.trim() ?? '';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Content type from a filename, for the upload. */
export function mimeFor(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    pdf: 'application/pdf',
  };
  return known[ext] ?? 'application/octet-stream';
}

/**
 * `decodeURI` throws on a lone `%`, which a filename is perfectly entitled to
 * contain — and the throw escaped `findEmbeds`, so one image called `50%.png`
 * stopped the entire note from syncing, not just that image.
 */
function decodeTarget(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}
