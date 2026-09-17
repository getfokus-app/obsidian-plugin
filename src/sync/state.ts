/**
 * What the plugin remembers between runs.
 *
 * The durable half of the mapping is NOT here — it is the `fokus-id` in each
 * file's frontmatter, which survives this file being deleted, the plugin being
 * reinstalled, and the vault being opened on another machine. This is a cache
 * that makes change detection cheap; losing it costs a re-scan, not the links.
 */
/**
 * 'conflict' means both sides had moved and the Fokus version was written
 * beside the file. The entry stays usable — the next push sends the local
 * version up — but the status records that a copy is sitting there unmerged.
 */
export type SyncStatus = 'synced' | 'error' | 'unstable' | 'conflict';

export interface MirrorEntry {
  /** The Fokus note id. */
  noteId: string;
  /** Where the file was last seen, so a rename can be recognised. */
  path: string;
  /** sha256 of the canonical body at the last agreement. */
  localHash: string;
  /**
   * Hash of the server's markdown at the last agreement.
   *
   * `updatedAt` alone is not enough to say the remote changed: any Fokus edit
   * bumps it, and an edit that alters only TipTap attributes leaves the
   * markdown identical. Comparing the rendered form is what stops those turning
   * into pointless pulls, and — with a lock held — pointless conflicts.
   */
  remoteHash: string;
  lastSyncedAt: string;
  /**
   * Vault embed → the URL it was uploaded as.
   *
   * This is what lets the file keep `![[diagram.png]]` while Fokus holds a URL,
   * and what stops the same image being uploaded again on every sync.
   */
  attachments?: Record<string, string>;
  /**
   * Embed → `size:mtime` of the file when it was uploaded, so replacing an
   * image's bytes without renaming it is noticed. Absent on entries written by
   * earlier versions, which simply means the first sync after upgrading
   * re-uploads once and records a stamp.
   */
  attachmentStamps?: Record<string, string>;
  status: SyncStatus;
  /** Why a file was refused, when status is not 'synced'. */
  note?: string;
}

/**
 * Where Fokus lives unless the plugin is pointed somewhere else.
 *
 * `.com`, NOT `.app` — `api.getfokus.app` does not resolve at all, so a build
 * shipping it would fail to connect for every user with no clue why. Several
 * test fixtures elsewhere in the workspace use the `.app` form; they are
 * arbitrary strings, and this is not.
 */
export const DEFAULT_API_URL = 'https://api.getfokus.com';

export interface PluginData {
  schemaVersion: 1;
  /** Minted once per vault; identifies this vault to the backend. */
  vaultId?: string;
  /** Minted once per install; must differ from every other Fokus client. */
  clientId?: string;
  /**
   * The workspace the mirror below was built against.
   *
   * Kept so a change of account can be noticed. Every entry holds a Fokus note
   * id, and those ids belong to one account — point the plugin at a different
   * one and every push targets a note the new token may not touch, which the
   * server answers with a 403 the user has no way to interpret.
   */
  workspaceId?: string;
  /**
   * The keychain id the access token is stored under, never the token itself.
   *
   * Obsidian's secret storage holds the value; `data.json` holds only this, so
   * a vault synced through iCloud, Dropbox or git no longer carries a
   * credential.
   */
  secretId?: string;
  settings: {
    apiUrl: string;
    folders: string[];
    /**
     * Reveals the server field. Off for everyone: Fokus is not self-hosted, so
     * the only reason to change it is pointing a development or staging build
     * somewhere other than the live API. A URL box on the main screen is the
     * kind of thing people change once, forget, and then report as "sync
     * stopped working".
     */
    customServer?: boolean;
  };
  /**
   * Vault folder → Fokus bucket, as configured on the connection. Mirrored here
   * so routing survives a restart without waiting for a status round trip.
   */
  folderMappings?: Record<string, string>;
  /** Mirrors the connection's setting; false stops tags being sent at all. */
  syncTags?: boolean;
  /** Where the incremental pull last got to. */
  pullCursor?: string;
  /** Keyed by `fokus-id`, never by path — paths change, ids do not. */
  entries: Record<string, MirrorEntry>;
  /**
   * Paths still waiting to be pushed, persisted so a quit or a crash mid-sync
   * resumes where it stopped instead of silently dropping the remainder.
   */
  pending?: string[];
}

export const DEFAULT_DATA: PluginData = {
  schemaVersion: 1,
  settings: { apiUrl: DEFAULT_API_URL, folders: [] },
  folderMappings: {},
  syncTags: true,
  pending: [],
  entries: {},
};

export function withDefaults(stored: Partial<PluginData> | null | undefined): PluginData {
  // `token` is stored in the same file but deliberately kept OUT of this object:
  // it is handed to the engine and the settings tab, and anything that ever
  // stringifies it would carry the token with it.
  const { token: _token, ...rest } = (stored ?? {}) as Partial<PluginData> & {
    token?: string;
  };

  return {
    ...DEFAULT_DATA,
    ...rest,
    settings: { ...DEFAULT_DATA.settings, ...(rest.settings ?? {}) },
    entries: rest.entries ?? {},
    pending: rest.pending ?? [],
  };
}

/**
 * Whether the server field should be on screen.
 *
 * The stored flag is not the only input on purpose: a URL that is not the
 * default is ALWAYS shown, whatever the flag says. Otherwise a vault pointed at
 * a local or staging server could sit behind a toggle that reads "off", and the
 * settings screen would be actively denying where the notes are going.
 */
export function showsCustomServer(settings: { apiUrl: string; customServer?: boolean }): boolean {
  return settings.customServer === true || settings.apiUrl !== DEFAULT_API_URL;
}

/**
 * Whether the mirror belongs to a different account than the one just resolved.
 *
 * Only true when there IS a previous workspace and it differs — a first connect
 * has nothing to discard, and re-connecting to the same account must keep the
 * mirror or every note would be re-adopted.
 */
export function mirrorBelongsElsewhere(stored: string | undefined, resolved: string): boolean {
  return !!stored && stored !== resolved;
}
