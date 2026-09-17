/** The frontmatter key a note sets to stay out of sync. */
export const OPT_OUT_KEY = 'fokus-sync';

/** The frontmatter key carrying the Fokus note id. */
export const NOTE_ID_KEY = 'fokus-id';

export interface ScopeSettings {
  /** Vault-relative folder paths whose notes sync. Empty means nothing syncs. */
  folders: string[];
}

/**
 * Whether a file is in scope.
 *
 * Folder matching is on path segments, not string prefixes: `Work` must not
 * also capture `Workshop`. An empty folder list syncs nothing — the safe
 * default for a plugin that has just been installed and not yet configured.
 */
export function isPathInScope(path: string, settings: ScopeSettings): boolean {
  if (!path.toLowerCase().endsWith('.md')) return false;

  return (settings.folders ?? []).some((folder) => {
    const normalized = folder.replace(/^\/+|\/+$/g, '');
    if (!normalized) return false;
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

/**
 * Whether a note has opted out.
 *
 * Only an explicit `false` opts out. Anything else — absent, empty, a typo —
 * leaves the note syncing, because silently excluding a note the user believes
 * is syncing is the worse failure.
 */
export function isOptedOut(optOutValue: string | undefined): boolean {
  return optOutValue?.trim().toLowerCase() === 'false';
}

/**
 * Which Fokus bucket a file belongs to, given the vault-folder → bucket map
 * configured on the connection.
 *
 * The LONGEST matching folder wins, so a specific mapping beats a general one:
 * with both `Work` and `Work/Clients` mapped, a note under `Work/Clients`
 * lands in the client bucket rather than whichever key happened to be first.
 */
export function bucketForPath(
  path: string,
  folderMappings: Record<string, string>,
): string | undefined {
  let best: { folder: string; bucket: string } | undefined;

  const target = path.toLowerCase();

  for (const [folder, bucket] of Object.entries(folderMappings ?? {})) {
    // These come from the Fokus UI, so they get the same normalisation the
    // user's own folder list gets: trimmed, backslashes squared off, and
    // matched case-insensitively. A stray space or the wrong case used to mean
    // silence rather than a mapping.
    const normalized = folder
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase();
    if (!normalized || !bucket) continue;
    if (target !== normalized && !target.startsWith(`${normalized}/`)) continue;
    if (!best || normalized.length > best.folder.length) best = { folder: normalized, bucket };
  }

  return best?.bucket;
}
