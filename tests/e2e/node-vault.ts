import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { VaultPort } from '@/sync/ports';

/**
 * A real vault on a real filesystem.
 *
 * Deliberately the only thing swapped out for the harness: the engine, the
 * client and the wire format are all the code that ships. Frontmatter writes
 * are line-based here rather than going through Obsidian's YAML round-trip,
 * which is the one behaviour the headless suite cannot claim to cover.
 */
export class NodeVaultPort implements VaultPort {
  constructor(private root: string) {}

  async listMarkdown(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.md')) out.push(relative(this.root, full));
      }
    };
    await walk(this.root);
    return out;
  }

  async read(path: string): Promise<string> {
    return await readFile(join(this.root, path), 'utf8');
  }

  async exists(path: string): Promise<boolean> {
    return await readFile(join(this.root, path), 'utf8').then(
      () => true,
      () => false,
    );
  }

  /** Overwrite only, matching Obsidian's `vault.process`. */
  async write(path: string, contents: string): Promise<void> {
    if (!(await this.exists(path))) throw new Error(`File is no longer in the vault: ${path}`);
    await writeFile(join(this.root, path), contents, 'utf8');
  }

  async create(path: string, contents: string): Promise<void> {
    if (await this.exists(path)) throw new Error(`File already exists: ${path}`);
    const full = join(this.root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, 'utf8');
  }

  async setFrontmatterKey(path: string, key: string, value: string): Promise<void> {
    const raw = await this.read(path).catch(() => '');
    const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/.exec(raw);

    if (!match) {
      await this.write(path, `---\n${key}: ${value}\n---\n\n${raw}`);
      return;
    }

    const existing = match[1] ?? '';
    const line = new RegExp(`^${key}\\s*:.*$`, 'm');
    const next = line.test(existing)
      ? existing.replace(line, `${key}: ${value}`)
      : `${existing}\n${key}: ${value}`.trim();
    await this.write(path, `---\n${next}\n---\n${raw.slice(match[0].length)}`);
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    try {
      const info = await stat(join(this.root, path));
      return { size: info.size, mtime: info.mtimeMs };
    } catch {
      return null;
    }
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(join(this.root, path));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  /**
   * A simplified stand-in for Obsidian's resolution: relative to the note, then
   * vault-root. Obsidian also honours the configured attachment folder, which
   * only the real adapter can know — one of the things the headless harness
   * cannot claim to cover.
   */
  resolveLink(target: string, fromPath: string): string | null {
    const folder = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1) : '';
    for (const candidate of [`${folder}${target}`, target]) {
      if (existsSync(join(this.root, candidate))) return candidate;
    }
    return null;
  }

  basename(path: string): string {
    return path.split('/').pop()!.replace(/\.md$/i, '');
  }
}

/** Node's fetch as the client transport — the harness's other swap. */
export const nodeTransport = async (request: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
}) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body as BodyInit | undefined,
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
};
