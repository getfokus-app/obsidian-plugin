import {
  FokusPort,
  NoteMissingError,
  NotifyPort,
  PULL_PAGE_SIZE,
  RemoteNote,
  VaultPort,
} from '@/sync/ports';

/** An in-memory vault. Frontmatter writes go through the same split used live. */
export class FakeVault implements VaultPort {
  writes = 0;

  constructor(public files: Record<string, string> = {}) {}

  async listMarkdown(): Promise<string[]> {
    return Object.keys(this.files).filter((p) => p.endsWith('.md'));
  }

  async read(path: string): Promise<string> {
    if (!(path in this.files)) throw new Error(`no such file: ${path}`);
    return this.files[path]!;
  }

  async exists(path: string): Promise<boolean> {
    return path in this.files;
  }

  /**
   * Overwrite only, exactly like Obsidian's `vault.process`.
   *
   * Creating on demand here is what let a conflict copy — which is always a new
   * file — look writable in tests while throwing in the real plugin.
   */
  async write(path: string, contents: string): Promise<void> {
    if (!(path in this.files)) throw new Error(`File is no longer in the vault: ${path}`);
    this.writes++;
    this.files[path] = contents;
  }

  async create(path: string, contents: string): Promise<void> {
    if (path in this.files) throw new Error(`File already exists: ${path}`);
    this.writes++;
    this.files[path] = contents;
  }

  async setFrontmatterKey(path: string, key: string, value: string): Promise<void> {
    this.writes++;
    const raw = this.files[path] ?? '';
    const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/.exec(raw);
    if (!match) {
      this.files[path] = `---\n${key}: ${value}\n---\n\n${raw}`;
      return;
    }
    const existing = match[1] ?? '';
    const line = new RegExp(`^${key}\\s*:.*$`, 'm');
    const next = line.test(existing)
      ? existing.replace(line, `${key}: ${value}`)
      : `${existing}\n${key}: ${value}`.trim();
    this.files[path] = `---\n${next}\n---\n${raw.slice(match[0].length)}`;
  }

  /** Binary contents, keyed separately from the markdown files. */
  binaries: Record<string, ArrayBuffer> = {};

  /** Bumped by `replaceBinary`, so a test can change bytes without a rename. */
  binaryMtimes: Record<string, number> = {};

  /** Overwrite an attachment's bytes the way re-exporting a diagram would. */
  replaceBinary(path: string, data: ArrayBuffer): void {
    this.binaries[path] = data;
    this.binaryMtimes[path] = (this.binaryMtimes[path] ?? 0) + 1000;
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    const data = this.binaries[path];
    if (data) return { size: data.byteLength, mtime: this.binaryMtimes[path] ?? 0 };
    const text = this.files[path];
    return text === undefined ? null : { size: text.length, mtime: 0 };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.binaries[path];
    if (!data) throw new Error(`no such attachment: ${path}`);
    return data;
  }

  resolveLink(target: string, fromPath: string): string | null {
    const folder = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1) : '';
    for (const candidate of [`${folder}${target}`, target]) {
      if (candidate in this.binaries || candidate in this.files) return candidate;
    }
    return null;
  }

  basename(path: string): string {
    return path.split('/').pop()!.replace(/\.md$/i, '');
  }
}

/**
 * A stand-in Fokus.
 *
 * `normalise` models the one server behaviour the engine actually depends on:
 * the server returns ITS canonical markdown, which may differ from what was
 * sent. Tests set it to reproduce a file that will not settle.
 */
export class FakeFokus implements FokusPort {
  notes = new Map<
    string,
    RemoteNote & {
      sourceOriginalId: string;
      tagIds?: string[];
      bucketId?: string | null;
    }
  >();
  creates = 0;
  updates = 0;
  /** Drops exactly one update, to reach the upload-succeeded-then-died row. */
  failNextUpdate = false;
  normalise: (markdown: string) => string = (m) => m;

  private seq = 0;

  /** name -> id, so tests can assert which tags a note ended up carrying. */
  tagIds = new Map<string, string>();
  tagCreations = 0;

  async resolveTags(names: string[]): Promise<string[]> {
    return names.map((name) => {
      const existing = this.tagIds.get(name);
      if (existing) return existing;
      this.tagCreations++;
      const id = `tag-${this.tagIds.size + 1}`;
      this.tagIds.set(name, id);
      return id;
    });
  }

  async create(input: {
    title: string;
    markdown: string;
    sourceOriginalId: string;
    tagIds?: string[];
    bucketId?: string;
  }): Promise<RemoteNote> {
    // Same contract as ApiFokusPort: an id that is already taken returns the
    // note that owns it. The real duplicate/409 handling lives in the port and
    // is tested against it directly.
    for (const note of this.notes.values()) {
      if (note.sourceOriginalId === input.sourceOriginalId) return { ...note };
    }
    this.creates++;
    const note = {
      id: `note-${++this.seq}`,
      markdown: this.normalise(input.markdown),
      title: input.title,
      updatedAt: new Date(2026, 0, this.seq).toISOString(),
      sourceOriginalId: input.sourceOriginalId,
      tagIds: input.tagIds ?? [],
      bucketId: input.bucketId,
    };
    this.notes.set(note.id, note);
    return { ...note };
  }

  async update(
    id: string,
    input: {
      title?: string;
      markdown?: string;
      tagIds?: string[];
      bucketId?: string | null;
    },
  ): Promise<RemoteNote> {
    const note = this.notes.get(id);
    // Same signal the real port raises on a 404, so recovery is reachable here.
    if (!note) throw new NoteMissingError(id);
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('network died');
    }
    this.updates++;
    if (input.markdown !== undefined) note.markdown = this.normalise(input.markdown);
    if (input.title !== undefined) note.title = input.title;
    if (input.tagIds !== undefined) note.tagIds = input.tagIds;
    if (input.bucketId !== undefined) note.bucketId = input.bucketId ?? undefined;
    note.updatedAt = new Date(2026, 1, ++this.seq).toISOString();
    return { ...note };
  }

  /** Ids currently locked, so tests can assert the lock is taken and released. */
  locked = new Set<string>();

  /**
   * Modelled on the real query: scoped, sorted ASCENDING, and capped.
   *
   * The earlier version returned everything unsorted, which made a whole class
   * of bug unreachable — with a newest-first page and a cap, the cursor parked
   * behind the same page forever and older notes were never seen again.
   */
  pageSize = PULL_PAGE_SIZE;

  async listChangedSince(cursor: string): Promise<RemoteNote[]> {
    return [...this.notes.values()]
      .filter((note) => note.updatedAt >= cursor)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, this.pageSize)
      .map((note) => ({ ...note }));
  }

  uploads: Array<{ noteId: string; filename: string }> = [];

  /** Errors to raise from the next uploads, in order. Empty means success. */
  uploadFailures: unknown[] = [];

  async uploadAttachment(input: {
    noteId: string;
    filename: string;
    contentType: string;
    data: ArrayBuffer;
  }): Promise<string> {
    this.uploads.push({ noteId: input.noteId, filename: input.filename });
    const fail = this.uploadFailures.shift();
    if (fail) throw fail;
    return `/v1/uploads/content/${encodeURIComponent(input.filename)}?s=sig${this.uploads.length}`;
  }

  /** How many times a lock was acquired or renewed, to prove a long run renews. */
  lockCalls = 0;

  async lock(id: string): Promise<void> {
    this.lockCalls++;
    this.locked.add(id);
  }

  async unlock(id: string): Promise<void> {
    this.locked.delete(id);
  }

  async findBySourceOriginalId(sourceOriginalId: string): Promise<RemoteNote | null> {
    for (const note of this.notes.values()) {
      if (note.sourceOriginalId === sourceOriginalId) return { ...note };
    }
    return null;
  }
}

export class FakeNotify implements NotifyPort {
  messages: string[] = [];
  info(message: string) {
    this.messages.push(`info: ${message}`);
  }
  warn(message: string) {
    this.messages.push(`warn: ${message}`);
  }
}
