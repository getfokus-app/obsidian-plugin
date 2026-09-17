import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FokusClient } from '@/api/client';
import { eq } from '@/api/filter-builder';
import { NotesApi } from '@/api/notes';
import { TagsApi } from '@/api/taxonomy';
import { UploadsApi } from '@/api/uploads';
import { ObsidianSourceApi, WorkspacesApi } from '@/api/obsidian-source';
import { readScalar, splitFrontmatter } from '@/markdown/frontmatter';
import { NOTE_ID_KEY } from '@/settings/scope';
import { SyncEngine } from '@/sync/engine';
import { ApiFokusPort } from '@/sync/fokus-port';
import { PluginData, withDefaults } from '@/sync/state';
import { ApiFokusPort as _Port } from '@/sync/fokus-port';

import { NodeVaultPort, nodeTransport } from './node-vault';

/**
 * The shipped engine and client, against a real backend and a real filesystem.
 *
 * Only two things are swapped: the vault is a temp directory instead of
 * Obsidian's, and the transport is Node fetch instead of `requestUrl`.
 * Everything else — the engine, the convergence loop, the wire format, the
 * server's normalisation — is exactly what runs in production.
 *
 * Needs the local backend (`cd backend && docker compose up -d`). Never point
 * FOKUS_API_URL at production: this creates and rewrites notes.
 */
const API = process.env.FOKUS_API_URL ?? 'http://localhost:3000';
const CLIENT_ID = '5f2c1a90-3b4d-4e6f-8a7b-9c0d1e2f3a4b';
const OTHER_CLIENT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

let vaultRoot: string;
let engine: SyncEngine;
let data: PluginData;
let uploadRequests = 0;
let notes: NotesApi;
let sourceId: string;
let enginePort: _Port;
let fokusSideNotes!: NotesApi;
let engineData!: PluginData;
const notices: string[] = [];

beforeAll(async () => {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API)) {
    throw new Error(`Refusing to run against ${API} — this suite writes notes.`);
  }

  // Fail loudly rather than half-initialise: the old version set a `reachable`
  // flag nothing read, so a stopped backend surfaced as
  // "Cannot read properties of undefined (reading 'pushFile')".
  const health = await fetch(`${API}/api/v1/health`, {
    headers: { 'x-client-id': CLIENT_ID },
  }).catch(() => null);
  if (!health?.ok) {
    throw new Error(
      `Fokus backend is not answering at ${API} — run: cd backend && docker compose up -d`,
    );
  }

  const anon = new FokusClient({ apiUrl: API, token: '', clientId: CLIENT_ID }, nodeTransport);
  const email = `obsidian-e2e-${Date.now()}@example.com`;
  // `POST /auth/register` allows 5 per 10 minutes PER IP, so running this suite
  // a few times in a row fails here with a bare "HTTP 429" that looks like a
  // product bug. Say what it actually is.
  const registered = await anon.request<{
    access: { token: string };
    user: { _id: string };
  }>('/auth/register', {
    method: 'POST',
    workspace: false,
    body: {
      firstName: 'Obsidian',
      lastName: 'E2E',
      email,
      password: 'ObsidianE2E!1',
      timezone: 'Europe/Berlin',
    },
  });

  const client: FokusClient = new FokusClient(
    { apiUrl: API, token: registered.access.token, clientId: CLIENT_ID },
    nodeTransport,
  );
  const workspaces = await new WorkspacesApi(client).list();
  const workspaceId = (workspaces.find((w) => w.isPersonal) ?? workspaces[0])!._id;
  client.update({ workspaceId });

  const status = await new ObsidianSourceApi(client).connect({
    vaultId: `vault-${Date.now()}`,
    name: 'E2E Vault',
    platform: 'macos',
    pluginVersion: '0.1.0',
  });

  sourceId = status.sourceId!;
  vaultRoot = await mkdtemp(join(tmpdir(), 'fokus-vault-'));
  await mkdir(join(vaultRoot, 'Work'), { recursive: true });

  notes = new NotesApi(client);
  const tags = new TagsApi(client);
  const uploads = new UploadsApi(
    () => ({
      apiUrl: API,
      token: registered.access.token,
      clientId: CLIENT_ID,
      workspaceId,
    }),
    // Counted at the transport, which is the only place that knows an upload
    // really left the machine. Counting URLs in the stored note instead reads
    // the same "3" whether nothing was re-uploaded or everything was.
    //
    // The retry is test infrastructure, not a second implementation of the
    // plugin's limiter: `POST /v1/uploads` allows 10 a minute PER IP, so two
    // runs of this suite inside one minute exhaust it no matter which user they
    // register as. Production handles the same 429 by backing off the whole
    // queue; here we only need the suite to be re-runnable.
    async (request) => {
      uploadRequests++;
      for (let attempt = 0; ; attempt++) {
        const response = await nodeTransport(request);
        if (response.status !== 429 || attempt === 4) return response;
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
    },
  );
  enginePort = new ApiFokusPort(notes, sourceId, tags, uploads, 'E2E Vault');

  // A second client id stands in for somebody editing the same note in the
  // Fokus web app — the backend keys its edit lock on exactly that header.
  const otherClient = new FokusClient(
    {
      apiUrl: API,
      token: registered.access.token,
      clientId: OTHER_CLIENT_ID,
      workspaceId,
    },
    nodeTransport,
  );
  fokusSideNotes = new NotesApi(otherClient);
  data = withDefaults(null);
  engineData = data;
  let seq = 0;
  engine = new SyncEngine({
    vault: new NodeVaultPort(vaultRoot),
    fokus: enginePort,
    notify: { info: () => {}, warn: (m) => notices.push(m) },
    data,
    scope: () => ({ folders: ['Work'] }),
    routing: () => ({}),
    syncTags: () => true,
    now: () => new Date(),
    newId: () => `e2e-${Date.now()}-${++seq}`,
  });
}, 60_000);

afterAll(async () => {
  if (vaultRoot) await rm(vaultRoot, { recursive: true, force: true });
});

describe.runIf(process.env.FOKUS_E2E === '1')('Obsidian sync against a real backend', () => {
  it('adopts a file, stamps the id, and the note lands in a workspace', async () => {
    await writeFile(join(vaultRoot, 'Work/plan.md'), '# Plan\n\n- [ ] parent\n  - [ ] child\n');

    const result = await engine.pushFile('Work/plan.md');
    expect(result.outcome).toBe('adopted');

    const onDisk = await readFile(join(vaultRoot, 'Work/plan.md'), 'utf8');
    const externalId = readScalar(splitFrontmatter(onDisk).frontmatter, NOTE_ID_KEY);
    expect(externalId).toBeTruthy();

    // The silent-orphan check: a note created without a workspace header returns
    // 201 and is then invisible in every Fokus client, with nothing to notice.
    const stored = await notes.get(result.noteId!);
    expect(stored._id).toBe(result.noteId);

    // the Wave 0 divergence must not have come back
    expect(stored.content).not.toContain('```');
    expect(stored.content).toContain('- [ ] parent');
  }, 30_000);

  it('is a no-op on the second pass, and writes the file only once', async () => {
    const before = await readFile(join(vaultRoot, 'Work/plan.md'), 'utf8');

    const again = await engine.pushFile('Work/plan.md');

    expect(again.outcome).toBe('unchanged');
    expect(await readFile(join(vaultRoot, 'Work/plan.md'), 'utf8')).toBe(before);
  }, 30_000);

  it('pushes a real edit', async () => {
    const current = await readFile(join(vaultRoot, 'Work/plan.md'), 'utf8');
    await writeFile(join(vaultRoot, 'Work/plan.md'), `${current}\n\nAdded a line.\n`);

    const result = await engine.pushFile('Work/plan.md');

    expect(result.outcome).toBe('pushed');
    expect((await notes.get(result.noteId!)).content).toContain('Added a line.');
  }, 30_000);

  /** data.json is a cache; the id in the file is what the mapping actually rests on. */
  it('recovers the mapping from frontmatter alone after losing its state', async () => {
    const first = await engine.pushFile('Work/plan.md');
    data.entries = {};

    const result = await engine.pushFile('Work/plan.md');

    expect(result.outcome).toBe('relinked');
    expect(result.noteId).toBe(first.noteId);
  }, 30_000);

  /**
   * Counted on the SERVER, not in the plugin's own cache. The cache is keyed by
   * the frontmatter id and only ever overwritten in place, so comparing it to
   * itself would pass even if every sync created a fresh note.
   */
  it('does not duplicate when the whole vault is re-synced', async () => {
    await writeFile(join(vaultRoot, 'Work/second.md'), '# Second\n');
    await engine.pushAll();
    const afterFirst = await notes.list({
      filter: { source: eq(sourceId) },
      limit: 100,
    });

    await engine.pushAll();
    const afterSecond = await notes.list({
      filter: { source: eq(sourceId) },
      limit: 100,
    });

    expect(afterSecond.length).toBe(afterFirst.length);
    expect(afterSecond.map((n) => n._id).sort()).toEqual(afterFirst.map((n) => n._id).sort());
  }, 60_000);

  /** One note per file, not one per sync — asked of the server directly. */
  it('has exactly one note per synced file', async () => {
    const onServer = await notes.list({
      filter: { source: eq(sourceId) },
      limit: 100,
    });
    const externalIds = onServer.map((n) => n.sourceOriginalId);

    expect(new Set(externalIds).size).toBe(onServer.length);
    expect(onServer.length).toBe(2);
  }, 30_000);
});

describe.runIf(process.env.FOKUS_E2E === '1')('a large folder', () => {
  const COUNT = 200;
  let bulkRoot: string;
  let bulkData: PluginData;

  /** Builds an engine over `bulkRoot`, so a "restart" is just a new one. */
  const engineFor = (data: PluginData) => {
    let seq = 0;
    return new SyncEngine({
      vault: new NodeVaultPort(bulkRoot),
      fokus: enginePort,
      notify: { info: () => {}, warn: () => {} },
      data,
      scope: () => ({ folders: ['Bulk'] }),
      routing: () => ({}),
      syncTags: () => true,
      now: () => new Date(),
      newId: () => `bulk-${Date.now()}-${++seq}`,
    });
  };

  beforeAll(async () => {
    bulkRoot = await mkdtemp(join(tmpdir(), 'fokus-bulk-'));
    await mkdir(join(bulkRoot, 'Bulk'), { recursive: true });
    for (let i = 0; i < COUNT; i++) {
      await writeFile(join(bulkRoot, `Bulk/note-${i}.md`), `# Note ${i}\n\nBody ${i}.\n`);
    }
    bulkData = withDefaults(null);
  }, 60_000);

  afterAll(async () => {
    if (bulkRoot) await rm(bulkRoot, { recursive: true, force: true });
  });

  /**
   * The restart is the point: state is rebuilt from what was persisted plus the
   * ids already in the files, so the second half must finish the job rather
   * than start it over.
   */
  it('syncs 200 notes across a restart that loses its cache, with no duplicates', async () => {
    const paths = await new NodeVaultPort(bulkRoot).listMarkdown();
    const half = Math.floor(paths.length / 2);

    const before = engineFor(bulkData);
    for (const path of paths.slice(0, half)) await before.pushFile(path);

    // A real restart, not a decorative one: the mirror is GONE. Carrying the
    // entries across left nothing missing, so the second engine never had to
    // recover anything and the test would have passed with one engine.
    // Recovery now has to come from the ids in the files themselves.
    bulkData = withDefaults({ ...bulkData, entries: {} });
    const after = engineFor(bulkData);
    const revisited = await after.pushFile(paths[0]!);
    expect(revisited.outcome).toBe('relinked');

    for (const path of paths.slice(half)) await after.pushFile(path);

    const onServer = await notes.list({
      filter: { source: eq(sourceId) },
      limit: 500,
    });
    const bulk = onServer.filter((n) => n.sourceOriginalId?.startsWith('bulk-'));
    expect(bulk).toHaveLength(COUNT);
    expect(new Set(bulk.map((n) => n.sourceOriginalId)).size).toBe(COUNT);
  }, 600_000);

  /** Re-running must cost nothing: every file already agrees with its note. */
  it('is a no-op when run again', async () => {
    const paths = await new NodeVaultPort(bulkRoot).listMarkdown();
    const engine = engineFor(bulkData);
    // one pass to settle the mirror for the half synced by the "restarted" engine
    for (const path of paths) await engine.pushFile(path);

    const results = [];
    for (const path of paths) results.push(await engine.pushFile(path));

    expect(results.every((r) => r.outcome === 'unchanged')).toBe(true);
    const onServer = await notes.list({
      filter: { source: eq(sourceId) },
      limit: 500,
    });
    expect(onServer.filter((n) => n.sourceOriginalId?.startsWith('bulk-'))).toHaveLength(COUNT);
  }, 600_000);
});

describe.runIf(process.env.FOKUS_E2E === '1')('Wave 4 — pull, locking and conflicts', () => {
  const noteIdFor = (path: string) =>
    Object.values(engineData.entries).find((e) => e.path === path)!.noteId;

  beforeAll(async () => {
    await writeFile(join(vaultRoot, 'Work/w4.md'), '# W4\n\nOriginal.\n');
    await engine.pushFile('Work/w4.md');
    engineData.pullCursor = new Date(0).toISOString();
  }, 30_000);

  /**
   * The lock only gates an interactive `PUT`, which is exactly the write the
   * Fokus editor makes — so a second client is genuinely held off.
   */
  it('blocks a Fokus-side edit while the vault holds the lock, and frees it after', async () => {
    const noteId = noteIdFor('Work/w4.md');
    await engine.holdLock('Work/w4.md');

    await expect(
      fokusSideNotes.update(noteId, { content: '# W4\n\nFrom Fokus.' }),
    ).rejects.toMatchObject({ kind: 'conflict' });

    await engine.releaseLock('Work/w4.md');
    await expect(
      fokusSideNotes.update(noteId, { content: '# W4\n\nFrom Fokus.' }),
    ).resolves.toBeTruthy();
  }, 30_000);

  it('pulls a Fokus edit down into the file', async () => {
    const noteId = noteIdFor('Work/w4.md');
    await fokusSideNotes.update(noteId, {
      content: '# W4\n\nEdited in Fokus.',
    });

    const results = await engine.pull();

    expect(results.some((r) => r.outcome === 'pulled')).toBe(true);
    expect(await readFile(join(vaultRoot, 'Work/w4.md'), 'utf8')).toContain('Edited in Fokus.');
  }, 30_000);

  it('is a no-op when nothing changed in Fokus', async () => {
    await engine.pull();

    const results = await engine.pull();

    expect(results.every((r) => r.outcome !== 'pulled' && r.outcome !== 'conflict')).toBe(true);
  }, 30_000);

  /** The row that must never lose anything, against the real converter. */
  it('writes a conflict copy when both sides changed, losing neither', async () => {
    const noteId = noteIdFor('Work/w4.md');
    const current = await readFile(join(vaultRoot, 'Work/w4.md'), 'utf8');
    await writeFile(join(vaultRoot, 'Work/w4.md'), `${current}\n\nMine locally.\n`);
    await fokusSideNotes.update(noteId, {
      content: '# W4\n\nTheirs in Fokus.',
    });

    const results = await engine.pull();
    const conflict = results.find((r) => r.outcome === 'conflict');

    expect(conflict).toBeTruthy();
    // the file keeps what the user has
    expect(await readFile(join(vaultRoot, 'Work/w4.md'), 'utf8')).toContain('Mine locally.');
    // and the Fokus version is beside it, un-synced
    const copy = await readFile(join(vaultRoot, conflict!.conflictPath!), 'utf8');
    expect(copy).toContain('Theirs in Fokus.');
    expect(copy).not.toContain('fokus-id');
  }, 30_000);

  /**
   * data.json is a cache. Losing it must recover from the ids in the files —
   * without duplicating notes, and without inventing conflicts.
   */
  it('recovers from a lost cache with no duplicates and no spurious conflicts', async () => {
    const before = await notes.list({
      filter: { source: eq(sourceId) },
      limit: 500,
    });

    engineData.entries = {};
    engineData.pullCursor = new Date(0).toISOString();
    await engine.pushFile('Work/w4.md');
    const pulled = await engine.pull();

    const after = await notes.list({
      filter: { source: eq(sourceId) },
      limit: 500,
    });
    expect(after.length).toBe(before.length);

    // The pull has to have actually looked at the recovered note, not merely
    // failed to conflict — `every(... !== 'conflict')` was satisfied by an
    // empty array and by an all-'error' run.
    const forW4 = pulled.filter((r) => r.path?.endsWith('w4.md'));
    expect(forW4).toHaveLength(1);
    expect(['unchanged', 'pulled']).toContain(forW4[0]!.outcome);
  }, 60_000);
});

describe.runIf(process.env.FOKUS_E2E === '1')('Wave 5 — attachments', () => {
  /** A real 1x1 PNG, so the server's content-type and size checks see a genuine file. */
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  beforeAll(async () => {
    await mkdir(join(vaultRoot, 'Work/assets'), { recursive: true });
    for (const name of ['one.png', 'two.png', 'three.png']) {
      await writeFile(join(vaultRoot, `Work/assets/${name}`), PNG);
    }
    await writeFile(
      join(vaultRoot, 'Work/gallery.md'),
      '# Gallery\n\n![[assets/one.png]]\n\n![[assets/two.png]]\n\n![alt](assets/three.png)\n',
    );
  }, 30_000);

  it('uploads every image and leaves the vault file exactly as written', async () => {
    const before = await readFile(join(vaultRoot, 'Work/gallery.md'), 'utf8');

    const result = await engine.pushFile('Work/gallery.md');
    expect(result.outcome).toBe('adopted');
    // surfaced rather than swallowed, so a failure here is diagnosable
    expect(notices.filter((n) => n.includes('Could not upload'))).toEqual([]);

    // Fokus holds URLs it can render...
    const stored = await notes.get(result.noteId!);
    expect(stored.content).toContain('/v1/uploads/content/');
    expect(stored.content).not.toContain('![[assets/one.png]]');

    // ...while the file keeps the syntax the user wrote, apart from its new id
    const after = await readFile(join(vaultRoot, 'Work/gallery.md'), 'utf8');
    expect(after).toContain('![[assets/one.png]]');
    expect(after).toContain('![alt](assets/three.png)');
    expect(after.replace(/^---[\s\S]*?---\n\n/, '')).toBe(before);
  }, 120_000);

  /** Uploads are the expensive part of a sync; a re-run must not pay again. */
  it('uploads nothing on a re-sync', async () => {
    const edited = await readFile(join(vaultRoot, 'Work/gallery.md'), 'utf8');
    await writeFile(join(vaultRoot, 'Work/gallery.md'), `${edited}\nA caption.\n`);
    uploadRequests = 0;

    const result = await engine.pushFile('Work/gallery.md');

    const stored = await notes.get(result.noteId!);
    expect(stored.content).toContain('A caption.');
    expect(uploadRequests).toBe(0);
    expect([...stored.content.matchAll(/\/v1\/uploads\/content\//g)]).toHaveLength(3);
  }, 120_000);

  /**
   * The bug this wave's review found against the real backend: the mirror kept
   * the note's remote hash in the WIRE form while the pull compared the VAULT
   * form, so a note with any image was judged changed in Fokus on every poll —
   * silently rewriting the file, and writing a conflict copy once the user had
   * touched it. Nothing has changed on either side here, so the only correct
   * answer is "unchanged".
   */
  it('reports a pull as unchanged when nobody edited anything', async () => {
    const before = await readFile(join(vaultRoot, 'Work/gallery.md'), 'utf8');

    const results = await engine.pull();

    const gallery = results.filter((r) => r.path?.endsWith('gallery.md'));
    expect(gallery.map((r) => r.outcome)).toEqual(['unchanged']);
    expect(await readFile(join(vaultRoot, 'Work/gallery.md'), 'utf8')).toBe(before);
    // scoped to this note: Wave 4 deliberately leaves its own conflict copy here
    const files = await readdir(join(vaultRoot, 'Work'));
    expect(files.filter((f) => f.startsWith('gallery') && f.includes('conflict'))).toEqual([]);
  }, 120_000);

  /** A pull must never replace the user's links with signed URLs. */
  it('keeps vault syntax when the note comes back down', async () => {
    const noteId = Object.values(engineData.entries).find((e) =>
      e.path.endsWith('gallery.md'),
    )!.noteId;
    const stored = await notes.get(noteId);
    await fokusSideNotes.update(noteId, {
      content: `${stored.content}\n\nFrom Fokus.`,
    });

    await engine.pull();

    const after = await readFile(join(vaultRoot, 'Work/gallery.md'), 'utf8');
    expect(after).toContain('From Fokus.');
    expect(after).toContain('![[assets/one.png]]');
    expect(after).not.toContain('/v1/uploads/content/');
  }, 120_000);
});
