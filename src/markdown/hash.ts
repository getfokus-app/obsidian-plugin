/**
 * Content hashing for change detection.
 *
 * `crypto.subtle` rather than Node's `crypto`: it exists in both the Obsidian
 * renderer and on mobile, so the plugin does not become desktop-only for the
 * sake of a hash.
 */
export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
