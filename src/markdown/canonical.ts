/**
 * The form a note body is compared in.
 *
 * Comparison happens here, not on raw bytes, because the two sides format the
 * same content differently and neither is wrong.
 *
 * **Per-line trailing whitespace is stripped, and that is load-bearing.** The
 * server's canonical markdown contains whitespace-only lines — a nested list
 * round-trips as `- [ ] parent\n  \n  - [ ] child` — while Obsidian and every
 * formatter strip them on save. Comparing without stripping would see the file
 * differ from canonical forever: push, get canonical back, differ again, push.
 * A churn loop.
 *
 * The only casualty is a markdown hard break (two trailing spaces), and the
 * converter already discards those, so there is nothing left to preserve.
 *
 * Note this is the OPPOSITE of `canonical()` in the backend's corpus harness,
 * which deliberately keeps trailing whitespace — that one measures conversion
 * loss and must not hide it. Same name, opposite job.
 */
export function canonicalBody(source: string): string {
  return (source ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}
