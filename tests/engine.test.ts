import { beforeEach, describe, expect, it } from 'vitest';

import { readScalar, splitFrontmatter } from '@/markdown/frontmatter';
import { NOTE_ID_KEY } from '@/settings/scope';
import { SyncEngine } from '@/sync/engine';
import { PluginData, withDefaults } from '@/sync/state';

import { FakeFokus, FakeNotify, FakeVault } from './fakes';

describe('SyncEngine — push', () => {
  let vault: FakeVault;
  let fokus: FakeFokus;
  let data: PluginData;
  let ids: number;
  let routing: Record<string, string>;

  const build = () =>
    new SyncEngine({
      vault,
      fokus,
      notify: new FakeNotify(),
      data,
      scope: () => ({ folders: ['Work'] }),
      routing: () => routing,
      syncTags: () => true,
      now: () => new Date('2026-09-16T12:00:00.000Z'),
      newId: () => `uid-${++ids}`,
    });

  beforeEach(() => {
    vault = new FakeVault({ 'Work/note.md': '# Title\n\nBody.' });
    fokus = new FakeFokus();
    data = withDefaults(null);
    ids = 0;
    routing = {};
  });

  describe('adoption', () => {
    it('creates the note and stamps the id into frontmatter', async () => {
      const result = await build().pushFile('Work/note.md');

      expect(result.outcome).toBe('adopted');
      expect(fokus.creates).toBe(1);
      expect(
        readScalar(splitFrontmatter(vault.files['Work/note.md']!).frontmatter, NOTE_ID_KEY),
      ).toBe('uid-1');
    });

    /**
     * The id is written before the create so a crash in between is recoverable:
     * the next run finds the note by that id instead of making a second one.
     */
    it('recovers without duplicating when the note already exists for that id', async () => {
      await fokus.create({
        title: 'note',
        markdown: '# Title\n\nBody.',
        sourceOriginalId: 'uid-1',
      });

      const result = await build().pushFile('Work/note.md');

      expect(result.outcome).toBe('adopted');
      expect(fokus.notes.size).toBe(1);
    });

    it('is a no-op the second time', async () => {
      const engine = build();
      await engine.pushFile('Work/note.md');
      const writesAfterAdopt = vault.writes;

      const again = await engine.pushFile('Work/note.md');

      expect(again.outcome).toBe('unchanged');
      expect(fokus.creates).toBe(1);
      expect(vault.writes).toBe(writesAfterAdopt);
    });

    /** The server's canonical form wins, and the file is rewritten once to match. */
    it('normalises the file to the server form when they differ', async () => {
      vault.files['Work/note.md'] = '* one\n* two';
      fokus.normalise = (m) => m.replace(/^\* /gm, '- ');

      const result = await build().pushFile('Work/note.md');

      expect(result.outcome).toBe('adopted');
      expect(splitFrontmatter(vault.files['Work/note.md']!).body.trim()).toBe('- one\n- two');
    });

    /**
     * A file that never settles would be rewritten on every sync, forever.
     * Refusing it has to mean the body is left exactly as written — an earlier
     * version rewrote the file three times and then recorded a status nothing
     * read, so the "refused" file was mutated and adopted normally next sync.
     */
    it('refuses a file that will not reach a fixed point, leaving the body untouched', async () => {
      const original = vault.files['Work/note.md']!;
      let flip = 0;
      fokus.normalise = (m) => `${m}\n<!-- ${++flip} -->`;
      const engine = build();

      const result = await engine.pushFile('Work/note.md');

      expect(result.outcome).toBe('unstable');
      expect(data.entries['uid-1']!.status).toBe('unstable');
      // the body the user wrote survives; only the id was added
      expect(splitFrontmatter(vault.files['Work/note.md']!).body.trim()).toBe(original.trim());
    });

    /** The refusal has to survive: it is the content that will not settle. */
    it('keeps refusing on later syncs rather than quietly adopting', async () => {
      let flip = 0;
      fokus.normalise = (m) => `${m}\n<!-- ${++flip} -->`;
      const engine = build();
      await engine.pushFile('Work/note.md');
      const updatesAfterRefusal = fokus.updates;

      const again = await engine.pushFile('Work/note.md');

      expect(again.outcome).toBe('unstable');
      expect(fokus.updates).toBe(updatesAfterRefusal);
    });

    /** Editing the file is what lifts a refusal — the content changed. */
    it('re-attempts once the user edits the file', async () => {
      let flip = 0;
      fokus.normalise = (m) => `${m}\n<!-- ${++flip} -->`;
      const engine = build();
      await engine.pushFile('Work/note.md');

      fokus.normalise = (m) => m;
      const { frontmatter } = splitFrontmatter(vault.files['Work/note.md']!);
      vault.files['Work/note.md'] = `---\n${frontmatter}\n---\n\n# Title\n\nRewritten.`;
      const again = await engine.pushFile('Work/note.md');

      expect(again.outcome).toBe('pushed');
    });
  });

  describe('scope', () => {
    it.each([
      ['a note outside the synced folders', 'Personal/note.md', 'skipped-out-of-scope'],
      ['a non-markdown file', 'Work/image.png', 'skipped-out-of-scope'],
    ])('skips %s', async (_label, path, outcome) => {
      vault.files[path] = 'x';
      expect((await build().pushFile(path)).outcome).toBe(outcome);
    });

    it('skips a note that opted out, without touching it', async () => {
      vault.files['Work/note.md'] = '---\nfokus-sync: false\n---\n\n# Title';

      const result = await build().pushFile('Work/note.md');

      expect(result.outcome).toBe('skipped-opted-out');
      expect(fokus.creates).toBe(0);
      expect(vault.writes).toBe(0);
    });
  });

  describe('subsequent edits', () => {
    it('pushes when the body changes', async () => {
      const engine = build();
      await engine.pushFile('Work/note.md');

      const { frontmatter } = splitFrontmatter(vault.files['Work/note.md']!);
      vault.files['Work/note.md'] = `---\n${frontmatter}\n---\n\n# Title\n\nEdited.`;
      const result = await engine.pushFile('Work/note.md');

      expect(result.outcome).toBe('pushed');
      expect(fokus.notes.get(result.noteId!)!.markdown).toContain('Edited.');
    });

    /**
     * The exact churn loop the canonical form exists to break: a formatter
     * stripping the whitespace-only line the server emits must not read as an
     * edit.
     */
    it('does not push when only trailing whitespace changed', async () => {
      const engine = build();
      await engine.pushFile('Work/note.md');
      const updatesAfterAdopt = fokus.updates;

      const raw = vault.files['Work/note.md']!;
      vault.files['Work/note.md'] = raw.replace('# Title', '# Title   ');
      const result = await engine.pushFile('Work/note.md');

      expect(result.outcome).toBe('unchanged');
      expect(fokus.updates).toBe(updatesAfterAdopt);
    });

    /**
     * The hash recorded must be of the body that was SENT. Re-reading the file
     * after the network call recorded whatever the user typed meanwhile as
     * "already agreed", so their next save compared equal and never went up.
     */
    it('does not swallow an edit that lands mid-push', async () => {
      const engine = build();
      await engine.pushFile('Work/note.md');

      const { frontmatter } = splitFrontmatter(vault.files['Work/note.md']!);
      vault.files['Work/note.md'] = `---\n${frontmatter}\n---\n\n# Title\n\nv2`;

      // the user saves v3 while the v2 request is in flight
      const originalUpdate = fokus.update.bind(fokus);
      fokus.update = async (id, input) => {
        vault.files['Work/note.md'] = `---\n${frontmatter}\n---\n\n# Title\n\nv3`;
        return originalUpdate(id, input);
      };
      await engine.pushFile('Work/note.md');
      fokus.update = originalUpdate;

      const result = await engine.pushFile('Work/note.md');

      expect(result.outcome).toBe('pushed');
      expect(fokus.notes.get(result.noteId!)!.markdown).toContain('v3');
    });

    /** Identity lives in frontmatter, so a move inside the vault is free. */
    it('follows a renamed file without creating a second note', async () => {
      const engine = build();
      const first = await engine.pushFile('Work/note.md');

      vault.files['Work/renamed.md'] = vault.files['Work/note.md']!;
      delete vault.files['Work/note.md'];
      const result = await engine.pushFile('Work/renamed.md');

      expect(result.noteId).toBe(first.noteId);
      expect(fokus.creates).toBe(1);
      expect(fokus.notes.get(result.noteId!)!.title).toBe('renamed');
    });

    /** data.json is a cache; the id in the file is what actually matters. */
    it('relinks from frontmatter alone after the mirror is lost', async () => {
      const engine = build();
      const first = await engine.pushFile('Work/note.md');
      data.entries = {};

      const result = await build().pushFile('Work/note.md');

      expect(result.outcome).toBe('relinked');
      expect(result.noteId).toBe(first.noteId);
      expect(fokus.creates).toBe(1);
    });

    /** An id with no note behind it — e.g. deleted in Fokus — re-creates against it. */
    it('re-creates a note for an id that no longer exists remotely', async () => {
      const engine = build();
      await engine.pushFile('Work/note.md');
      fokus.notes.clear();
      data.entries = {};

      const result = await build().pushFile('Work/note.md');

      expect(result.outcome).toBe('adopted');
      expect(fokus.notes.size).toBe(1);
    });
  });

  describe('tags and bucket routing', () => {
    it('sends the note with its tags resolved to ids', async () => {
      vault.files['Work/note.md'] = '---\ntags: [work]\n---\n\n# Title\n\nFiled under #urgent.';

      const result = await build().pushFile('Work/note.md');

      expect(fokus.notes.get(result.noteId!)!.tagIds).toHaveLength(2);
      expect([...fokus.tagIds.keys()].sort()).toEqual(['urgent', 'work']);
    });

    it('does not create a tag twice across notes', async () => {
      vault.files['Work/a.md'] = '#shared';
      vault.files['Work/b.md'] = '#shared';

      await build().pushAll();

      expect(fokus.tagCreations).toBe(1);
    });

    /** Code is not a tag; sending it would create junk tags in Fokus. */
    it('ignores tags inside code', async () => {
      vault.files['Work/note.md'] = '```\n#nottag\n```\n\n#real';

      const result = await build().pushFile('Work/note.md');

      expect([...fokus.tagIds.keys()]).toEqual(['real']);
      expect(fokus.notes.get(result.noteId!)!.tagIds).toHaveLength(1);
    });

    it('files the note into the bucket mapped for its folder', async () => {
      routing = { Work: 'bucket-work' };

      const result = await build().pushFile('Work/note.md');

      expect(fokus.notes.get(result.noteId!)!.bucketId).toBe('bucket-work');
    });

    /** The most specific mapping wins, not whichever key came first. */
    it('prefers the longest matching folder', async () => {
      routing = { Work: 'bucket-work', 'Work/Clients': 'bucket-clients' };
      vault.files['Work/Clients/acme.md'] = '# Acme';

      const result = await build().pushFile('Work/Clients/acme.md');

      expect(fokus.notes.get(result.noteId!)!.bucketId).toBe('bucket-clients');
    });

    it('leaves the bucket unset when no folder is mapped', async () => {
      const result = await build().pushFile('Work/note.md');

      expect(fokus.notes.get(result.noteId!)!.bucketId).toBeUndefined();
    });

    /**
     * Editing frontmatter tags changes nothing in the body, so a body-only hash
     * would report "unchanged" and the tag would never reach Fokus.
     */
    it('pushes when only the tags changed', async () => {
      const engine = build();
      await engine.pushFile('Work/note.md');

      const { frontmatter } = splitFrontmatter(vault.files['Work/note.md']!);
      vault.files['Work/note.md'] = `---\n${frontmatter}\ntags: [added]\n---\n\n# Title\n\nBody.`;
      const result = await engine.pushFile('Work/note.md');

      expect(result.outcome).toBe('pushed');
      expect(fokus.notes.get(result.noteId!)!.tagIds).toHaveLength(1);
    });

    it('pushes when only the bucket mapping changed', async () => {
      const engine = build();
      await engine.pushFile('Work/note.md');

      routing = { Work: 'bucket-new' };
      const result = await engine.pushFile('Work/note.md');

      expect(result.outcome).toBe('pushed');
      expect(fokus.notes.get(result.noteId!)!.bucketId).toBe('bucket-new');
    });
  });

  describe('failures', () => {
    /**
     * The engine returns failures rather than throwing so one bad file does not
     * abandon the vault — which makes the result the only channel a failure
     * has. Dropping it left the UI reporting "synced" while nothing synced.
     */
    it('carries the error on the result', async () => {
      const boom = new Error('422 unrepresentable');
      fokus.update = async () => {
        throw boom;
      };
      const engine = build();
      await engine.pushFile('Work/note.md');
      const { frontmatter } = splitFrontmatter(vault.files['Work/note.md']!);
      vault.files['Work/note.md'] = `---\n${frontmatter}\n---\n\n# Title\n\nEdited.`;

      const result = await engine.pushFile('Work/note.md');

      expect(result.outcome).toBe('error');
      expect(result.error).toBe(boom);
    });
  });

  describe('pushAll', () => {
    it('walks the vault and reports one outcome per file', async () => {
      vault.files['Work/a.md'] = '# A';
      vault.files['Personal/b.md'] = '# B';

      const results = await build().pushAll();

      expect(results).toHaveLength(3);
      expect(results.filter((r) => r.outcome === 'adopted')).toHaveLength(2);
      expect(results.filter((r) => r.outcome === 'skipped-out-of-scope')).toHaveLength(1);
    });

    it('keeps going when one file fails', async () => {
      vault.files['Work/broken.md'] = '# Broken';
      const engine = build();
      const original = vault.read.bind(vault);
      vault.read = async (p: string) => {
        if (p === 'Work/broken.md') throw new Error('unreadable');
        return original(p);
      };

      const results = await engine.pushAll();

      expect(results.find((r) => r.path === 'Work/broken.md')!.outcome).toBe('error');
      expect(results.find((r) => r.path === 'Work/note.md')!.outcome).toBe('adopted');
    });
  });
});

describe('SyncEngine — duplicated files', () => {
  /**
   * Duplicating a note copies its frontmatter, so two files claim one id. Left
   * alone they overwrite each other's note forever.
   */
  it('gives a copied note its own id rather than letting the two fight', async () => {
    const vault = new FakeVault({ 'Work/note.md': '# Title\n\nBody.' });
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    let ids = 0;
    const engine = new SyncEngine({
      vault,
      fokus,
      notify: new FakeNotify(),
      data,
      scope: () => ({ folders: ['Work'] }),
      routing: () => ({}),
      syncTags: () => true,
      now: () => new Date('2026-09-16T12:00:00.000Z'),
      newId: () => `uid-${++ids}`,
    });
    const original = await engine.pushFile('Work/note.md');

    // the user duplicates the file, frontmatter and all
    vault.files['Work/note copy.md'] = vault.files['Work/note.md']!;
    const copy = await engine.pushFile('Work/note copy.md');

    expect(copy.outcome).toBe('adopted');
    expect(copy.noteId).not.toBe(original.noteId);
    expect(fokus.notes.size).toBe(2);
    // and the original keeps its own id and note
    expect(await engine.pushFile('Work/note.md')).toMatchObject({
      outcome: 'unchanged',
      noteId: original.noteId,
    });
  });

  /** A move is not a copy: nothing is left behind, so the id travels. */
  it('treats a move as the same note', async () => {
    const vault = new FakeVault({ 'Work/note.md': '# Title\n\nBody.' });
    const fokus = new FakeFokus();
    let ids = 0;
    const engine = new SyncEngine({
      vault,
      fokus,
      notify: new FakeNotify(),
      data: withDefaults(null),
      scope: () => ({ folders: ['Work'] }),
      routing: () => ({}),
      syncTags: () => true,
      now: () => new Date('2026-09-16T12:00:00.000Z'),
      newId: () => `uid-${++ids}`,
    });
    const original = await engine.pushFile('Work/note.md');

    vault.files['Work/moved.md'] = vault.files['Work/note.md']!;
    delete vault.files['Work/note.md'];
    const moved = await engine.pushFile('Work/moved.md');

    expect(moved.noteId).toBe(original.noteId);
    expect(fokus.notes.size).toBe(1);
  });
});

describe('SyncEngine — recovery and routing edges', () => {
  const build = (
    vault: FakeVault,
    fokus: FakeFokus,
    data: PluginData,
    routing: Record<string, string> = {},
  ) => {
    let ids = 0;
    return new SyncEngine({
      vault,
      fokus,
      notify: new FakeNotify(),
      data,
      scope: () => ({ folders: ['Work'] }),
      routing: () => routing,
      syncTags: () => true,
      now: () => new Date('2026-09-16T12:00:00.000Z'),
      newId: () => `uid-${++ids}`,
    });
  };

  /**
   * A note deleted in Fokus left the mirror pointing at nothing, and the file
   * then errored on every sync from then on — permanently, with no way back.
   */
  it('re-creates the note when it has been deleted in Fokus', async () => {
    const vault = new FakeVault({ 'Work/note.md': '# Title' });
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    const engine = build(vault, fokus, data);
    const first = await engine.pushFile('Work/note.md');

    fokus.notes.clear();
    const { frontmatter } = splitFrontmatter(vault.files['Work/note.md']!);
    vault.files['Work/note.md'] = `---\n${frontmatter}\n---\n\n# Title\n\nEdited.`;
    const result = await engine.pushFile('Work/note.md');

    expect(result.outcome).toBe('adopted');
    expect(result.noteId).not.toBe(first.noteId);
    expect(fokus.notes.size).toBe(1);
  });

  /**
   * Removing a folder mapping used to report "pushed" and change nothing: an
   * undefined bucket was dropped from the payload instead of clearing it.
   */
  it('clears the bucket when its folder mapping is removed', async () => {
    const vault = new FakeVault({ 'Work/note.md': '# Title' });
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    let routing: Record<string, string> = { Work: 'bucket-a' };
    let ids = 0;
    const engine = new SyncEngine({
      vault,
      fokus,
      notify: new FakeNotify(),
      data,
      scope: () => ({ folders: ['Work'] }),
      routing: () => routing,
      syncTags: () => true,
      now: () => new Date('2026-09-16T12:00:00.000Z'),
      newId: () => `uid-${++ids}`,
    });
    const first = await engine.pushFile('Work/note.md');
    expect(fokus.notes.get(first.noteId!)!.bucketId).toBe('bucket-a');

    routing = {};
    await engine.pushFile('Work/note.md');

    expect(fokus.notes.get(first.noteId!)!.bucketId).toBeUndefined();
  });

  /**
   * Obsidian names a duplicate `note copy.md`, and a space sorts before a dot —
   * so resolving this per-file, in walk order, handed the copy the original's
   * note and gave the original a brand-new empty one.
   */
  it('keeps the original when a copy sorts first and the mirror is gone', async () => {
    const vault = new FakeVault({ 'Work/note.md': '# Title\n\nBody.' });
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    const original = await build(vault, fokus, data).pushFile('Work/note.md');

    // duplicate the file, then lose the mirror entirely
    vault.files['Work/note copy.md'] = vault.files['Work/note.md']!;
    data.entries = {};

    const results = await build(vault, fokus, data).pushAll();
    const byPath = Object.fromEntries(results.map((r) => [r.path, r]));

    // the original keeps its note; the copy gets one of its own
    expect(byPath['Work/note.md']!.noteId).toBe(original.noteId);
    expect(byPath['Work/note copy.md']!.noteId).not.toBe(original.noteId);
    expect(fokus.notes.size).toBe(2);
  });

  it('prefers the path the mirror already knows over the shorter one', async () => {
    const vault = new FakeVault({ 'Work/a-very-long-name.md': '# Title' });
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    const original = await build(vault, fokus, data).pushFile('Work/a-very-long-name.md');

    vault.files['Work/b.md'] = vault.files['Work/a-very-long-name.md']!;

    const results = await build(vault, fokus, data).pushAll();
    const byPath = Object.fromEntries(results.map((r) => [r.path, r]));

    expect(byPath['Work/a-very-long-name.md']!.noteId).toBe(original.noteId);
    expect(byPath['Work/b.md']!.noteId).not.toBe(original.noteId);
  });
});
