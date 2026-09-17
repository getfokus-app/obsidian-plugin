import { App, TFile } from 'obsidian';

import { VaultPort } from './ports';

/**
 * The real vault.
 *
 * Writes go through `vault.process` and `fileManager.processFrontMatter` rather
 * than `vault.modify`, so each write is serialised against Obsidian's own, and
 * `processFrontMatter` round-trips the YAML properly instead of regex-editing
 * someone's document.
 *
 * What that does NOT give you is freshness: `process` hands the callback the
 * current contents so you can merge, and this one returns a string computed
 * earlier. The pull side does not merge either — it writes the remote body
 * whole — so an edit landing between the read and the write is still lost. The
 * window is one round trip, and the edit-lock plus the conflict copy are what
 * keep the consequences recoverable rather than silent.
 */
export class ObsidianVaultPort implements VaultPort {
  constructor(private app: App) {}

  async listMarkdown(): Promise<string[]> {
    return this.app.vault.getMarkdownFiles().map((file) => file.path);
  }

  async read(path: string): Promise<string> {
    return await this.app.vault.read(this.requireFile(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getFileByPath(path) !== null;
  }

  async write(path: string, contents: string): Promise<void> {
    await this.app.vault.process(this.requireFile(path), () => contents);
  }

  /** `process` can only modify; a new file needs `create`. */
  async create(path: string, contents: string): Promise<void> {
    await this.app.vault.create(path, contents);
  }

  async setFrontmatterKey(path: string, key: string, value: string): Promise<void> {
    await this.app.fileManager.processFrontMatter(this.requireFile(path), (frontmatter) => {
      frontmatter[key] = value;
    });
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return await this.app.vault.readBinary(this.requireFile(path));
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    // Obsidian keeps this on the cached TFile, so it costs no file read.
    const file = this.app.vault.getFileByPath(path);
    return file ? { size: file.stat.size, mtime: file.stat.mtime } : null;
  }

  /**
   * Obsidian's own resolution, not a path join: the same `![[a.png]]` resolves
   * to different files depending on the note it sits in, and the attachment
   * folder is a vault setting we should not be second-guessing.
   */
  resolveLink(target: string, fromPath: string): string | null {
    return this.app.metadataCache.getFirstLinkpathDest(target, fromPath)?.path ?? null;
  }

  basename(path: string): string {
    return path.split('/').pop()!.replace(/\.md$/i, '');
  }

  private requireFile(path: string): TFile {
    const file = this.app.vault.getFileByPath(path);
    if (!file) throw new Error(`File is no longer in the vault: ${path}`);
    return file;
  }
}
