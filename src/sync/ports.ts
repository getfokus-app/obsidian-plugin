/**
 * The two edges of the sync engine.
 *
 * Everything the engine touches goes through these, so the engine itself has no
 * Obsidian import and no network call. In Obsidian they are backed by the real
 * Vault and the real API; in tests by an in-memory directory and a fake server,
 * which is how the whole push/pull/conflict path can be exercised without
 * launching an editor.
 */
export interface VaultPort {
  /** Vault-relative paths of every markdown file. */
  listMarkdown(): Promise<string[]>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /**
   * Overwrite an existing file. Obsidian's `process` cannot create one, so this
   * throws on a missing path — the fakes match that deliberately, because a
   * fake that silently created files hid a conflict copy being impossible to
   * write, and the Fokus version being destroyed instead.
   */
  write(path: string, contents: string): Promise<void>;
  /** Create a new file. Fails if something is already there. */
  create(path: string, contents: string): Promise<void>;
  /** Raw bytes of an attachment. */
  readBinary(path: string): Promise<ArrayBuffer>;
  /**
   * Size and modification time of a file, or null if it is gone.
   *
   * Used to notice that an attachment's CONTENT changed while its name did not
   * — re-exporting a diagram over the old one is routine, and keying the upload
   * cache on the embed text alone served the first version of that image for
   * ever, with no way to refresh it short of renaming the file.
   */
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  /**
   * Resolve a link as Obsidian would, from the note that contains it — the
   * same `![[a.png]]` means different files in different folders.
   */
  resolveLink(target: string, fromPath: string): string | null;
  /** Set one frontmatter key, leaving the rest of the YAML untouched. */
  setFrontmatterKey(path: string, key: string, value: string): Promise<void>;
  basename(path: string): string;
}

export interface RemoteNote {
  id: string;
  /** The server's normalised markdown. */
  markdown: string;
  title?: string;
  updatedAt: string;
  /** The vault file's id — how a pulled note is matched back to a file. */
  sourceOriginalId?: string;
}

export interface FokusPort {
  /**
   * Ensure a note exists for this external id and return it.
   *
   * An id that is already taken is NOT an error: it means this file is already
   * linked, and the implementation returns that note. Treating it as a failure
   * made a file fail permanently whenever the existing note was real but
   * invisible to a workspace-scoped lookup.
   */
  create(input: {
    title: string;
    markdown: string;
    sourceOriginalId: string;
    tagIds?: string[];
    bucketId?: string;
  }): Promise<RemoteNote>;
  update(
    id: string,
    /** `bucketId: null` clears it — omitting it leaves whatever is there. */
    input: {
      title?: string;
      markdown?: string;
      tagIds?: string[];
      bucketId?: string | null;
    },
  ): Promise<RemoteNote>;

  /** Turn tag names into Fokus tag ids, creating any that do not exist. */
  resolveTags(names: string[]): Promise<string[]>;
  /** Find a note already linked to this external id — how a lost mirror recovers. */
  findBySourceOriginalId(sourceOriginalId: string): Promise<RemoteNote | null>;

  /**
   * Notes this vault owns that changed at or after `cursor`.
   *
   * Scoped to this connection's source, so notes created natively in Fokus are
   * excluded by construction rather than by a filter that could drift.
   */
  listChangedSince(cursor: string): Promise<RemoteNote[]>;

  /**
   * Attach a file to a note and return the URL Fokus will render.
   *
   * The note has to exist first — the server keys an upload to an entity id —
   * which is why an adopted note is created, then uploaded to, then updated
   * with the rewritten body.
   */
  uploadAttachment(input: {
    noteId: string;
    filename: string;
    contentType: string;
    data: ArrayBuffer;
  }): Promise<string>;

  /** Take or renew the edit lock, so Fokus can go read-only while we write. */
  lock(id: string): Promise<void>;
  unlock(id: string): Promise<void>;
}

/**
 * The note this id pointed at no longer exists — deleted in Fokus, or the
 * mirror outlived the account it was built against. Distinct from a transient
 * failure so recovery cannot swallow a 429 or a validation error.
 */
export class NoteMissingError extends Error {
  constructor(readonly noteId: string) {
    super(`Note ${noteId} no longer exists`);
    this.name = 'NoteMissingError';
  }
}

/** How many changed notes one pull page asks for. */
export const PULL_PAGE_SIZE = 100;

/** Non-blocking user feedback. */
export interface NotifyPort {
  info(message: string): void;
  warn(message: string): void;
}
