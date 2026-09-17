import { beforeEach, describe, expect, it } from 'vitest';

import { splitFrontmatter } from '@/markdown/frontmatter';
import { CURSOR_OVERLAP_MS, SyncEngine } from '@/sync/engine';
import { conflictPathFor } from '@/sync/conflicts';
import { PluginData, withDefaults } from '@/sync/state';

import { FakeFokus, FakeNotify, FakeVault } from './fakes';

describe('conflictPathFor', () => {
  const when = new Date('2026-09-17T10:00:00.000Z');

  it('names the copy beside the original', async () => {
    expect((await conflictPathFor('Notes/Plan.md', when, async () => false)).path).toBe(
      'Notes/Plan (conflict 2026-09-17).md',
    );
  });

  it('keeps a note at the vault root at the root', async () => {
    expect((await conflictPathFor('Plan.md', when, async () => false)).path).toBe(
      'Plan (conflict 2026-09-17).md',
    );
  });

  /** A second conflict on the same day must not overwrite the first. */
  it('numbers subsequent conflicts on the same day', async () => {
    const taken = new Set(['Plan (conflict 2026-09-17).md']);

    expect((await conflictPathFor('Plan.md', when, async (c) => taken.has(c))).path).toBe(
      'Plan (conflict 2026-09-17 2).md',
    );
  });

  it('never returns a name that is already taken', async () => {
    const result = await conflictPathFor('Plan.md', when, async () => true);

    expect(result.path).toContain('conflict 2026-09-17');
    expect(result.path.endsWith('.md')).toBe(true);
  });
});

/**
 * One test per row of the sync state machine, which is the whole of Wave 4's
 * correctness: nothing is destroyed on either side, and nothing churns.
 */
describe('SyncEngine — pull', () => {
  let vault: FakeVault;
  let fokus: FakeFokus;
  let data: PluginData;
  let engine: SyncEngine;

  const build = () => {
    let ids = 0;
    return new SyncEngine({
      vault,
      fokus,
      notify: new FakeNotify(),
      data,
      scope: () => ({ folders: ['Work'] }),
      routing: () => ({}),
      syncTags: () => true,
      now: () => new Date('2026-09-17T10:00:00.000Z'),
      newId: () => `uid-${++ids}`,
    });
  };

  const bodyOf = (path: string) => splitFrontmatter(vault.files[path]!).body.trim();

  const editRemote = async (noteId: string, markdown: string) => {
    await fokus.update(noteId, { markdown });
  };

  const editLocal = (path: string, body: string) => {
    const { frontmatter } = splitFrontmatter(vault.files[path]!);
    vault.files[path] = `---\n${frontmatter}\n---\n\n${body}`;
  };

  beforeEach(async () => {
    vault = new FakeVault({ 'Work/note.md': '# Title\n\nOriginal.' });
    fokus = new FakeFokus();
    data = withDefaults(null);
    engine = build();
    await engine.pushFile('Work/note.md');
    data.pullCursor = new Date(0).toISOString();
  });

  it('row 1 — neither side changed: nothing happens', async () => {
    const before = vault.files['Work/note.md'];

    const results = await engine.pull();

    expect(results.map((r) => r.outcome)).toEqual(['unchanged']);
    expect(vault.files['Work/note.md']).toBe(before);
  });

  it('row 2 — local only: the pull leaves it alone for the push to handle', async () => {
    editLocal('Work/note.md', '# Title\n\nLocal edit.');

    const results = await engine.pull();

    expect(results.map((r) => r.outcome)).toEqual(['unchanged']);
    expect(bodyOf('Work/note.md')).toBe('# Title\n\nLocal edit.');
  });

  it('row 3 — remote only: the file is updated', async () => {
    const noteId = Object.values(data.entries)[0]!.noteId;
    await editRemote(noteId, '# Title\n\nChanged in Fokus.');

    const results = await engine.pull();

    expect(results.map((r) => r.outcome)).toEqual(['pulled']);
    expect(bodyOf('Work/note.md')).toBe('# Title\n\nChanged in Fokus.');
  });

  /** The row that must never lose anything. */
  it('row 4 — both sides changed: a conflict copy, and neither version lost', async () => {
    const noteId = Object.values(data.entries)[0]!.noteId;
    editLocal('Work/note.md', '# Title\n\nMine.');
    await editRemote(noteId, '# Title\n\nTheirs.');

    const results = await engine.pull();

    expect(results[0]!.outcome).toBe('conflict');
    // the file keeps what the user has in front of them
    expect(bodyOf('Work/note.md')).toBe('# Title\n\nMine.');
    // and the Fokus version is sitting beside it
    expect(vault.files[results[0]!.conflictPath!]).toContain('Theirs.');
  });

  /** A conflict copy must never itself be adopted as a note. */
  it('writes the conflict copy without a fokus-id', async () => {
    const noteId = Object.values(data.entries)[0]!.noteId;
    editLocal('Work/note.md', '# Title\n\nMine.');
    await editRemote(noteId, '# Title\n\nTheirs.');

    const [result] = await engine.pull();

    // asserted first: without it, a run that produced no conflict would leave
    // conflictPath undefined and the frontmatter check would pass on nothing
    expect(result!.outcome).toBe('conflict');
    expect(result!.conflictPath).toBeTruthy();
    const copy = vault.files[result!.conflictPath!];
    expect(copy).toBeTruthy();
    expect(splitFrontmatter(copy!).frontmatter).not.toContain('fokus-id');
  });

  /** After a conflict the push sends the local version, so both sides converge. */
  it('converges on the local version after a conflict', async () => {
    const noteId = Object.values(data.entries)[0]!.noteId;
    editLocal('Work/note.md', '# Title\n\nMine.');
    await editRemote(noteId, '# Title\n\nTheirs.');
    await engine.pull();

    await engine.pushFile('Work/note.md');

    expect(fokus.notes.get(noteId)!.markdown).toContain('Mine.');
  });

  /** Raising the same conflict on every pull would be unusable. */
  it('does not raise the same conflict twice', async () => {
    const noteId = Object.values(data.entries)[0]!.noteId;
    editLocal('Work/note.md', '# Title\n\nMine.');
    await editRemote(noteId, '# Title\n\nTheirs.');
    await engine.pull();

    const copyPath = Object.keys(vault.files).find((f) => f.includes('conflict'))!;
    const copyBefore = vault.files[copyPath];

    const again = await engine.pull();

    // asserted exactly, not `every(... !== 'conflict')` — that was satisfied by
    // an empty array, by 'unchanged', and by 'error', so a run where the copy
    // could not even be written passed it
    expect(again.map((r) => r.outcome)).toEqual(['unchanged']);
    expect(vault.files[copyPath]).toBe(copyBefore);
  });

  /** A second conflict on the same day must not overwrite the first. */
  it('keeps both copies when a note conflicts twice in one day', async () => {
    const noteId = Object.values(data.entries)[0]!.noteId;

    editLocal('Work/note.md', '# Title\n\nMine one.');
    await editRemote(noteId, '# Title\n\nTheirs one.');
    const first = await engine.pull();
    await engine.pushFile('Work/note.md');

    editLocal('Work/note.md', '# Title\n\nMine two.');
    await editRemote(noteId, '# Title\n\nTheirs two.');
    const second = await engine.pull();

    expect(first[0]!.outcome).toBe('conflict');
    expect(second[0]!.outcome).toBe('conflict');
    expect(second[0]!.conflictPath).not.toBe(first[0]!.conflictPath);
    expect(vault.files[first[0]!.conflictPath!]).toContain('Theirs one.');
    expect(vault.files[second[0]!.conflictPath!]).toContain('Theirs two.');
  });

  /**
   * The copy sits in a synced folder with no id, which is exactly the shape of
   * a file waiting to be adopted — so every conflict used to create a junk
   * Fokus note and rewrite the copy.
   */
  it('never adopts the conflict copy as a note of its own', async () => {
    const noteId = Object.values(data.entries)[0]!.noteId;
    editLocal('Work/note.md', '# Title\n\nMine.');
    await editRemote(noteId, '# Title\n\nTheirs.');
    const [conflict] = await engine.pull();
    const copyBefore = vault.files[conflict!.conflictPath!];

    const results = await engine.pushAll();

    const copyResult = results.find((r) => r.path === conflict!.conflictPath);
    expect(copyResult!.outcome).toBe('skipped-opted-out');
    expect(fokus.notes.size).toBe(1);
    expect(vault.files[conflict!.conflictPath!]).toBe(copyBefore);
  });

  /**
   * A Fokus edit that only changes TipTap attributes renders to identical
   * markdown. Treating `updatedAt` alone as "changed" would rewrite the file
   * and, with a local edit pending, invent a conflict out of nothing.
   */
  it('ignores a remote change that renders to the same markdown', async () => {
    const noteId = Object.values(data.entries)[0]!.noteId;
    const before = vault.files['Work/note.md'];
    await editRemote(noteId, '# Title\n\nOriginal.');

    const results = await engine.pull();

    expect(results.map((r) => r.outcome)).toEqual(['unchanged']);
    expect(vault.files['Work/note.md']).toBe(before);
  });

  /** Fokus-native notes stay in Fokus — this sync does not invent files. */
  it('skips a note this vault has never pushed', async () => {
    await fokus.create({
      title: 'Written in Fokus',
      markdown: '# Elsewhere',
      sourceOriginalId: 'not-from-this-vault',
    });

    const results = await engine.pull();

    expect(results.some((r) => r.outcome === 'skipped-local-only')).toBe(true);
    expect(Object.keys(vault.files)).toHaveLength(1);
  });

  it('advances its cursor so the next pull is cheap', async () => {
    await engine.pull();

    expect(data.pullCursor).not.toBe(new Date(0).toISOString());
  });

  /** A shared millisecond or a skewed clock must not lose a note for good. */
  it('rewinds the cursor rather than resuming exactly where it stopped', async () => {
    const noteId = Object.values(data.entries)[0]!.noteId;
    await editRemote(noteId, '# Title\n\nChanged.');
    await engine.pull();

    const newest = fokus.notes.get(noteId)!.updatedAt;
    expect(new Date(data.pullCursor!).getTime()).toBeLessThan(new Date(newest).getTime());
  });
});

describe('SyncEngine — deletes and locking', () => {
  let vault: FakeVault;
  let fokus: FakeFokus;
  let data: PluginData;
  let engine: SyncEngine;

  beforeEach(async () => {
    vault = new FakeVault({ 'Work/note.md': '# Title\n\nBody.' });
    fokus = new FakeFokus();
    data = withDefaults(null);
    let ids = 0;
    engine = new SyncEngine({
      vault,
      fokus,
      notify: new FakeNotify(),
      data,
      scope: () => ({ folders: ['Work'] }),
      routing: () => ({}),
      syncTags: () => true,
      now: () => new Date('2026-09-17T10:00:00.000Z'),
      newId: () => `uid-${++ids}`,
    });
    await engine.pushFile('Work/note.md');
  });

  /**
   * A file can vanish for reasons that are not a decision to delete anything:
   * a move out of a synced folder, a vault-sync hiccup, a stray keystroke.
   */
  it('stops syncing a deleted file without touching its note', async () => {
    const noteId = Object.values(data.entries)[0]!.noteId;

    expect(await engine.forgetPath('Work/note.md')).toBe('unlinked');

    expect(Object.keys(data.entries)).toHaveLength(0);
    expect(fokus.notes.get(noteId)).toBeTruthy();
  });

  it('says so when asked to forget a file it never linked', async () => {
    expect(await engine.forgetPath('Work/never-synced.md')).toBe('not-linked');
  });

  /** Re-creating the file with the same id must re-link, not duplicate. */
  it('re-links a file that comes back with its id intact', async () => {
    const contents = vault.files['Work/note.md']!;
    const noteId = Object.values(data.entries)[0]!.noteId;
    await engine.forgetPath('Work/note.md');

    vault.files['Work/note.md'] = contents;
    const result = await engine.pushFile('Work/note.md');

    expect(result.outcome).toBe('relinked');
    expect(result.noteId).toBe(noteId);
    expect(fokus.notes.size).toBe(1);
  });

  it('takes the lock for a file that is being edited, and gives it back', async () => {
    const noteId = Object.values(data.entries)[0]!.noteId;

    await engine.holdLock('Work/note.md');
    expect(fokus.locked.has(noteId)).toBe(true);

    await engine.releaseLock('Work/note.md');
    expect(fokus.locked.has(noteId)).toBe(false);
  });

  it('ignores a lock request for a file with no note yet', async () => {
    await expect(engine.holdLock('Work/unknown.md')).resolves.toBeUndefined();
    expect(fokus.locked.size).toBe(0);
  });

  /**
   * The vault is the side that works offline. A lock that cannot be taken must
   * never stop a local edit reaching Fokus.
   */
  it('does not let a failed lock block the edit', async () => {
    fokus.lock = async () => {
      throw new Error('locked by someone else');
    };

    await expect(engine.holdLock('Work/note.md')).resolves.toBeUndefined();
  });

  it('releases the lock when a file stops syncing', async () => {
    const noteId = Object.values(data.entries)[0]!.noteId;
    await engine.holdLock('Work/note.md');

    await engine.forgetPath('Work/note.md');

    expect(fokus.locked.has(noteId)).toBe(false);
  });
});

describe('SyncEngine — pull edges', () => {
  let vault: FakeVault;
  let fokus: FakeFokus;
  let data: PluginData;
  let folders: string[];

  const build = () => {
    let ids = 0;
    return new SyncEngine({
      vault,
      fokus,
      notify: new FakeNotify(),
      data,
      scope: () => ({ folders }),
      routing: () => ({}),
      syncTags: () => true,
      now: () => new Date('2026-09-17T10:00:00.000Z'),
      newId: () => `uid-${++ids}`,
    });
  };

  beforeEach(async () => {
    vault = new FakeVault({ 'Work/note.md': '# Title\n\nOriginal.' });
    fokus = new FakeFokus();
    data = withDefaults(null);
    folders = ['Work'];
    await build().pushFile('Work/note.md');
    data.pullCursor = new Date(0).toISOString();
  });

  const remoteEdit = async (markdown: string) => {
    const noteId = Object.values(data.entries)[0]!.noteId;
    await fokus.update(noteId, { markdown });
  };

  /**
   * Un-ticking a folder stopped pushing but left Fokus able to overwrite those
   * files — the plugin kept write access to a folder the user had removed.
   */
  it('does not write a file whose folder is no longer synced', async () => {
    await remoteEdit('# Title\n\nFrom Fokus.');
    const before = vault.files['Work/note.md'];
    folders = [];

    const results = await build().pull();

    expect(results[0]!.outcome).toBe('skipped-out-of-scope');
    expect(vault.files['Work/note.md']).toBe(before);
  });

  /** `fokus-sync: false` has to stop the note being overwritten too. */
  it('does not write a file that has opted out', async () => {
    await remoteEdit('# Title\n\nFrom Fokus.');
    const { frontmatter } = splitFrontmatter(vault.files['Work/note.md']!);
    vault.files['Work/note.md'] = `---\n${frontmatter}\nfokus-sync: false\n---\n\n# Title`;
    const before = vault.files['Work/note.md'];

    const results = await build().pull();

    expect(results[0]!.outcome).toBe('skipped-opted-out');
    expect(vault.files['Work/note.md']).toBe(before);
  });

  /** A file deleted while the plugin was closed errored on every pull, forever. */
  it('forgets a file that is no longer in the vault instead of erroring forever', async () => {
    await remoteEdit('# Title\n\nFrom Fokus.');
    delete vault.files['Work/note.md'];

    const results = await build().pull();

    expect(results[0]!.outcome).toBe('skipped-missing');
    expect(Object.keys(data.entries)).toHaveLength(0);
  });

  /**
   * With a capped page, a cursor taken from the page's newest entry parks
   * behind it forever and the older tail is never returned again.
   */
  it('works through more notes than fit in one page', async () => {
    fokus.pageSize = 2;
    // One engine: a fresh one restarts its id counter, so every file would be
    // minted the same fokus-id.
    const engine = build();
    for (let i = 0; i < 5; i++) {
      vault.files[`Work/n${i}.md`] = `# N${i}`;
      await engine.pushFile(`Work/n${i}.md`);
    }
    data.pullCursor = new Date(0).toISOString();
    for (const entry of Object.values(data.entries)) {
      await fokus.update(entry.noteId, { markdown: `${entry.noteId} changed` });
    }

    const results = await engine.pull();

    // every changed note is seen in one pull, not just the newest page
    expect(results.filter((r) => r.outcome === 'pulled').length).toBeGreaterThanOrEqual(5);
  });

  /** A note that failed must come round again, not be skipped once the overlap lapses. */
  it('does not advance the cursor past a note that errored', async () => {
    await remoteEdit('# Title\n\nFrom Fokus.');
    vault.read = async () => {
      throw new Error('disk on fire');
    };

    const results = await build().pull();

    expect(results[0]!.outcome).toBe('error');
    expect(data.pullCursor).toBe(new Date(-CURSOR_OVERLAP_MS).toISOString());
  });
});
