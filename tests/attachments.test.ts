import { describe, expect, it } from 'vitest';

import { findEmbeds, fromWire, mimeFor, toWire } from '@/markdown/attachments';
import { buildMultipart } from '@/api/multipart';
import { splitFrontmatter } from '@/markdown/frontmatter';
import { FokusApiError } from '@/api/errors';
import { RateLimiter } from '@/sync/rate-limiter';
import { SyncEngine } from '@/sync/engine';
import { PluginData, withDefaults } from '@/sync/state';

import { FakeFokus, FakeNotify, FakeVault } from './fakes';

const anywhere = () => false;

describe('findEmbeds', () => {
  it.each([
    ['a wiki embed', '![[diagram.png]]', 'diagram.png'],
    ['a wiki embed in a folder', '![[assets/diagram.png]]', 'assets/diagram.png'],
    ['a wiki embed with a size', '![[diagram.png|300]]', 'diagram.png'],
    ['a markdown embed', '![alt](img/a.png)', 'img/a.png'],
    ['an encoded path', '![alt](img/a%20b.png)', 'img/a b.png'],
    ['an angled path', '![alt](<img/a b.png>)', 'img/a b.png'],
    ['a pdf', '![[report.pdf]]', 'report.pdf'],
  ])('finds %s', (_label, body, target) => {
    expect(findEmbeds(body, anywhere).map((e) => e.target)).toEqual([target]);
  });

  it.each([
    ['a plain link, not an embed', '[[note]]'],
    ['a markdown link, not an embed', '[text](note.md)'],
    ['an embed of a note', '![[other note]]'],
    ['a remote image', '![alt](https://example.com/a.png)'],
    ['a protocol-ish path', '![alt](data:image/png;base64,AAA)'],
  ])('ignores %s', (_label, body) => {
    expect(findEmbeds(body, anywhere)).toEqual([]);
  });

  /** An embed inside a fence is an example of the syntax, not an attachment. */
  it('ignores an embed inside code', () => {
    const body = '```\n![[example.png]]\n```';
    const codeStart = body.indexOf('![[');

    expect(findEmbeds(body, (i) => i >= codeStart && i < codeStart + 16)).toEqual([]);
  });

  it('finds several, keeping duplicates out of the way of the caller', () => {
    const found = findEmbeds('![[a.png]] and ![[b.png]] and ![[a.png]]', anywhere);

    expect(found.map((e) => e.target)).toEqual(['a.png', 'b.png', 'a.png']);
  });
});

describe('toWire / fromWire', () => {
  const urls = new Map([['![[diagram.png]]', '/v1/uploads/content/abc?s=sig']]);

  it('sends a URL Fokus can render', () => {
    expect(toWire('See ![[diagram.png]] here.', urls)).toBe(
      'See ![diagram.png](/v1/uploads/content/abc?s=sig) here.',
    );
  });

  /**
   * The point of the reverse map: the file on disk keeps the syntax the user
   * wrote. Rewriting it to a signed URL would be a permanent, visible edit to
   * their note in exchange for something only Fokus needs.
   */
  it('puts the vault syntax back on the way down', () => {
    const wire = toWire('See ![[diagram.png]] here.', urls);

    expect(fromWire(wire, urls)).toBe('See ![[diagram.png]] here.');
  });

  it('round-trips unchanged', () => {
    const body = 'A ![[diagram.png]] B';

    expect(fromWire(toWire(body, urls), urls)).toBe(body);
  });

  it('keeps a wiki alt text', () => {
    const withAlt = new Map([['![[diagram.png|Chart]]', '/u/1']]);

    expect(toWire('![[diagram.png|Chart]]', withAlt)).toBe('![Chart](/u/1)');
    expect(fromWire('![Chart](/u/1)', withAlt)).toBe('![[diagram.png|Chart]]');
  });

  /** The server may re-render the alt text; the URL is the stable key. */
  it('restores the embed even when the alt text came back different', () => {
    expect(fromWire('![something else](/v1/uploads/content/abc?s=sig)', urls)).toBe(
      '![[diagram.png]]',
    );
  });

  /** An image added in Fokus has no vault file, so it stays a URL. */
  it('leaves an unknown URL alone', () => {
    expect(fromWire('![x](/v1/uploads/content/other?s=z)', urls)).toBe(
      '![x](/v1/uploads/content/other?s=z)',
    );
  });

  /** An upload that has not happened degrades to text, not a broken image. */
  it('leaves an embed with no URL as written', () => {
    expect(toWire('![[nope.png]]', new Map())).toBe('![[nope.png]]');
  });
});

describe('buildMultipart', () => {
  const decode = (buffer: ArrayBuffer) => new TextDecoder().decode(buffer);
  const data = new TextEncoder().encode('PNGDATA').buffer;

  it('frames the fields and the file', () => {
    const { contentType, body } = buildMultipart(
      { entityType: 'note', entityId: 'n1' },
      { field: 'file', filename: 'a.png', contentType: 'image/png', data },
      'BOUND',
    );
    const text = decode(body);

    expect(contentType).toBe('multipart/form-data; boundary=BOUND');
    expect(text).toContain(
      '--BOUND\r\nContent-Disposition: form-data; name="entityType"\r\n\r\nnote\r\n',
    );
    expect(text).toContain('name="file"; filename="a.png"');
    expect(text).toContain('Content-Type: image/png');
    expect(text.endsWith('\r\n--BOUND--\r\n')).toBe(true);
  });

  it('preserves the bytes exactly', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const { body } = buildMultipart(
      {},
      {
        field: 'file',
        filename: 'a.bin',
        contentType: 'application/octet-stream',
        data: bytes.buffer,
      },
      'B',
    );

    const out = new Uint8Array(body);
    const start = out.length - bytes.length - '\r\n--B--\r\n'.length;
    expect([...out.slice(start, start + bytes.length)]).toEqual([...bytes]);
  });

  /** A quote or newline in a filename would end the header and let the rest be read as one. */
  it.each([
    ['a quote', 'a"; name="evil.png', "a'; name='evil.png"],
    ['a newline', 'a\r\nX-Evil: 1.png', 'a  X-Evil: 1.png'],
  ])('neutralises %s in the filename', (_label, filename, expected) => {
    const { body } = buildMultipart(
      {},
      {
        field: 'file',
        filename,
        contentType: 'image/png',
        data,
      },
      'B',
    );

    expect(decode(body)).toContain(`filename="${expected}"`);
  });

  it('uses a different boundary each time', () => {
    const one = buildMultipart({}, { field: 'f', filename: 'a', contentType: 't', data });
    const two = buildMultipart({}, { field: 'f', filename: 'a', contentType: 't', data });

    expect(one.contentType).not.toBe(two.contentType);
  });
});

describe('mimeFor', () => {
  it.each([
    ['a.png', 'image/png'],
    ['a.JPG', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.svg', 'image/svg+xml'],
    ['a.pdf', 'application/pdf'],
    ['a.unknown', 'application/octet-stream'],
  ])('maps %s', (path, expected) => {
    expect(mimeFor(path)).toBe(expected);
  });
});

describe('SyncEngine — attachments', () => {
  const build = (vault: FakeVault, fokus: FakeFokus, data: PluginData) => {
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

  const withImages = () => {
    const vault = new FakeVault({
      'Work/note.md': '# Title\n\n![[a.png]]\n\n![[img/b.png]]\n\n![alt](c.png)',
    });
    vault.binaries['Work/a.png'] = new Uint8Array([1]).buffer;
    vault.binaries['Work/img/b.png'] = new Uint8Array([2]).buffer;
    vault.binaries['Work/c.png'] = new Uint8Array([3]).buffer;
    return vault;
  };

  it('uploads each embed and sends Fokus a URL', async () => {
    const vault = withImages();
    const fokus = new FakeFokus();
    const data = withDefaults(null);

    const result = await build(vault, fokus, data).pushFile('Work/note.md');

    expect(fokus.uploads).toHaveLength(3);
    const markdown = fokus.notes.get(result.noteId!)!.markdown;
    expect(markdown).toContain('/v1/uploads/content/');
    expect(markdown).not.toContain('![[a.png]]');
  });

  /**
   * The whole point of the reverse map. Rewriting the user's links into signed
   * URLs would be a permanent, visible edit to their note for Fokus's benefit.
   */
  it('leaves the vault file exactly as written', async () => {
    const vault = withImages();
    const before = vault.files['Work/note.md'];

    await build(vault, new FakeFokus(), withDefaults(null)).pushFile('Work/note.md');

    expect(splitFrontmatter(vault.files['Work/note.md']!).body.trim()).toBe(before!.trim());
  });

  /** Uploads are the expensive part; a re-sync must not pay for them again. */
  it('uploads nothing on a second sync', async () => {
    const vault = withImages();
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    const engine = build(vault, fokus, data);
    await engine.pushFile('Work/note.md');

    await engine.pushFile('Work/note.md');

    expect(fokus.uploads).toHaveLength(3);
  });

  it('uploads only the newly added image when one is inserted', async () => {
    const vault = withImages();
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    const engine = build(vault, fokus, data);
    await engine.pushFile('Work/note.md');

    vault.binaries['Work/d.png'] = new Uint8Array([4]).buffer;
    const { frontmatter, body } = splitFrontmatter(vault.files['Work/note.md']!);
    vault.files['Work/note.md'] = `---\n${frontmatter}\n---\n\n${body}\n\n![[d.png]]`;
    await engine.pushFile('Work/note.md');

    expect(fokus.uploads).toHaveLength(4);
    expect(fokus.uploads[3]!.filename).toBe('d.png');
  });

  /** A note must not fail to sync because one image could not be uploaded. */
  it('still syncs the note when an upload fails, leaving the embed as text', async () => {
    const vault = withImages();
    const fokus = new FakeFokus();
    fokus.uploadAttachment = async () => {
      throw new Error('upload rejected');
    };

    const result = await build(vault, fokus, withDefaults(null)).pushFile('Work/note.md');

    expect(result.outcome).toBe('adopted');
    expect(fokus.notes.get(result.noteId!)!.markdown).toContain('![[a.png]]');
  });

  it('retries a failed upload on the next sync', async () => {
    const vault = withImages();
    const fokus = new FakeFokus();
    const original = fokus.uploadAttachment.bind(fokus);
    fokus.uploadAttachment = async () => {
      throw new Error('upload rejected');
    };
    const engine = build(vault, fokus, withDefaults(null));
    await engine.pushFile('Work/note.md');

    fokus.uploadAttachment = original;
    const { frontmatter, body } = splitFrontmatter(vault.files['Work/note.md']!);
    vault.files['Work/note.md'] = `---\n${frontmatter}\n---\n\n${body}\n\nEdited.`;
    const result = await engine.pushFile('Work/note.md');

    expect(fokus.uploads).toHaveLength(3);
    expect(fokus.notes.get(result.noteId!)!.markdown).toContain('/v1/uploads/content/');
  });

  it('skips an embed whose file is missing from the vault', async () => {
    const vault = new FakeVault({ 'Work/note.md': '# Title\n\n![[gone.png]]' });
    const fokus = new FakeFokus();

    const result = await build(vault, fokus, withDefaults(null)).pushFile('Work/note.md');

    expect(fokus.uploads).toHaveLength(0);
    expect(fokus.notes.get(result.noteId!)!.markdown).toContain('![[gone.png]]');
  });

  /** A pull must never replace the user's link with a signed URL. */
  it('restores vault syntax when a pull brings the note back', async () => {
    const vault = withImages();
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    const engine = build(vault, fokus, data);
    const pushed = await engine.pushFile('Work/note.md');
    data.pullCursor = new Date(0).toISOString();

    // Fokus edits the note, keeping the uploaded URLs it holds
    const current = fokus.notes.get(pushed.noteId!)!.markdown;
    await fokus.update(pushed.noteId!, {
      markdown: `${current}\n\nFrom Fokus.`,
    });
    const results = await engine.pull();

    expect(results[0]!.outcome).toBe('pulled');
    const body = splitFrontmatter(vault.files['Work/note.md']!).body;
    expect(body).toContain('![[a.png]]');
    expect(body).toContain('From Fokus.');
    expect(body).not.toContain('/v1/uploads/content/');
  });
});

/**
 * The gate for this wave: 50 images must stay inside the server's 10/min upload
 * cap without discovering it by being refused. A 429 part-way through a note is
 * the worst case — the embeds already uploaded are orphaned and the note is
 * written with half its images as plain text.
 */
describe('upload throttling', () => {
  const RealLimiter = RateLimiter;

  it('keeps 50 uploads under the server cap in every 60-second window', () => {
    let clock = 0;
    const limiter = new RealLimiter(6, 60_000, () => clock, 2);
    const at: number[] = [];

    for (let i = 0; i < 50; i++) {
      const wait = limiter.reserve();
      clock += wait;
      at.push(clock);
    }

    // Rolling window over the actual issue times, not a count per fixed minute:
    // a fixed-bucket check passes while 10 uploads straddle a boundary.
    // Closed window (`<=`), not half-open: an upload landing exactly on the
    // boundary is still inside the server's minute as far as we can prove, and
    // the half-open version hid an 11th upload sitting right on it.
    const worst = Math.max(...at.map((t) => at.filter((u) => u >= t && u <= t + 60_000).length));
    expect(worst).toBeLessThanOrEqual(10);
    // ...and it must not be so conservative that 50 images take all day. Eight
    // minutes is the cost of holding to 6/min so the web app keeps its share;
    // the server floor for 50 uploads at its own 10/min is five.
    expect(at[at.length - 1]).toBeLessThanOrEqual(8 * 60_000);
  });

  /**
   * The gate's last row: the network dies after the bytes are up but before the
   * note is relinked. The attachment map is only persisted alongside a
   * successful relink, so the next sync re-uploads and relinks — wasteful by a
   * few kilobytes, but it converges instead of leaving the note pointing at
   * embeds Fokus cannot render.
   */
  it('recovers on the next sync when the relink dies after the upload', async () => {
    const vault = new FakeVault({ 'Work/note.md': '# T\n\n![[a.png]]' });
    vault.binaries['Work/a.png'] = new Uint8Array([1]).buffer;
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
      now: () => new Date('2026-09-17T10:00:00.000Z'),
      newId: () => `uid-${++ids}`,
    });

    fokus.failNextUpdate = true;
    const first = await engine.pushFile('Work/note.md');
    expect(first.outcome).toBe('error');

    const second = await engine.pushFile('Work/note.md');

    expect(second.outcome).not.toBe('error');
    const note = [...fokus.notes.values()].at(-1)!;
    expect(note.markdown).toContain('/v1/uploads/content/');
    expect(fokus.notes.size).toBe(1);
  });

  it('waits once per uploaded embed, and not at all for a cached one', async () => {
    const vault = new FakeVault({
      'Work/note.md': '# T\n\n![[a.png]]\n\n![[b.png]]',
    });
    vault.binaries['Work/a.png'] = new Uint8Array([1]).buffer;
    vault.binaries['Work/b.png'] = new Uint8Array([2]).buffer;
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    let waits = 0;
    let ids = 0;
    const engine = new SyncEngine({
      vault,
      fokus,
      notify: new FakeNotify(),
      data,
      scope: () => ({ folders: ['Work'] }),
      routing: () => ({}),
      syncTags: () => true,
      now: () => new Date('2026-09-17T10:00:00.000Z'),
      newId: () => `uid-${++ids}`,
      throttleUpload: async () => {
        waits++;
      },
    });

    await engine.pushFile('Work/note.md');
    expect(waits).toBe(2);

    await engine.pushFile('Work/note.md');
    expect(waits).toBe(2);
  });
});

/**
 * The regression test for the worst bug this wave produced.
 *
 * The mirror recorded the note's remote hash over the WIRE body — the one
 * carrying `![](/v1/uploads/...)` — while the pull compared against the VAULT
 * body carrying `![[img.png]]`. For a note with any embed those two strings
 * differ by construction, so "nothing changed in Fokus" was unreachable: every
 * 60-second poll decided the note had changed remotely and either rewrote the
 * user's file or, once they had edited it, wrote a conflict copy of a conflict
 * that never happened.
 */
describe('a note with attachments and no edits anywhere', () => {
  const build = (vault: FakeVault, fokus: FakeFokus, data: PluginData) => {
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

  const vaultWithImage = () => {
    const vault = new FakeVault({
      'Work/note.md': '# T\n\n![[a.png]]\n\ntail',
    });
    vault.binaries['Work/a.png'] = new Uint8Array([1]).buffer;
    return vault;
  };

  it('reports the pull as unchanged and does not touch the file', async () => {
    const vault = vaultWithImage();
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    const engine = build(vault, fokus, data);
    await engine.pushFile('Work/note.md');

    const after = vault.files['Work/note.md'];
    const writesBefore = vault.writes;

    const results = await engine.pull();

    expect(results.map((r) => r.outcome)).toEqual(['unchanged']);
    expect(vault.writes).toBe(writesBefore);
    expect(vault.files['Work/note.md']).toBe(after);
  });

  it('does not manufacture a conflict copy after the user edits the note', async () => {
    const vault = vaultWithImage();
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    const engine = build(vault, fokus, data);
    await engine.pushFile('Work/note.md');

    // A local edit and nothing at all on the Fokus side.
    const raw = vault.files['Work/note.md']!;
    vault.files['Work/note.md'] = `${raw}\n\nA sentence the user typed.`;

    await engine.pull();

    const conflicts = Object.keys(vault.files).filter((f) => f.includes('conflict'));
    expect(conflicts).toEqual([]);
  });
});

/** Everything the Wave 5 review found, kept as tests so it cannot come back. */
describe('attachment failure and staleness', () => {
  const build = (
    vault: FakeVault,
    fokus: FakeFokus,
    data: PluginData,
    notify = new FakeNotify(),
  ) => {
    let ids = 0;
    return new SyncEngine({
      vault,
      fokus,
      notify,
      data,
      scope: () => ({ folders: ['Work'] }),
      routing: () => ({}),
      syncTags: () => true,
      now: () => new Date('2026-09-17T10:00:00.000Z'),
      newId: () => `uid-${++ids}`,
    });
  };

  const oneImage = () => {
    const vault = new FakeVault({ 'Work/note.md': '# T\n\n![[a.png]]' });
    vault.binaries['Work/a.png'] = new Uint8Array([1]).buffer;
    return vault;
  };

  /**
   * Re-exporting a diagram over the old file is routine. Keyed on the embed text
   * alone, the cache served the first version for ever and the only way to
   * refresh it was to rename the file.
   */
  it('re-uploads an image whose bytes changed under the same name', async () => {
    const vault = oneImage();
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    const engine = build(vault, fokus, data);
    await engine.pushFile('Work/note.md');
    expect(fokus.uploads).toHaveLength(1);

    vault.replaceBinary('Work/a.png', new Uint8Array([9, 9, 9]).buffer);

    await engine.pushFile('Work/note.md');

    expect(fokus.uploads).toHaveLength(2);
  });

  /**
   * The other half of the same guard, and the half the old tests only appeared
   * to cover: with the body edited the short-circuit cannot hide a missing
   * cache, so deleting the cache check shows up here.
   */
  it('does not re-upload an unchanged image when the note text changes', async () => {
    const vault = oneImage();
    const fokus = new FakeFokus();
    const data = withDefaults(null);
    const engine = build(vault, fokus, data);
    await engine.pushFile('Work/note.md');

    vault.files['Work/note.md'] = `${vault.files['Work/note.md']}\n\nA new sentence.`;
    await engine.pushFile('Work/note.md');

    expect(fokus.uploads).toHaveLength(1);
  });

  /**
   * A failed upload used to be retried only if the user happened to edit the
   * note again — while the notice promised a retry that could never come.
   */
  it('retries a failed upload on the next sync with no edit in between', async () => {
    const vault = oneImage();
    const fokus = new FakeFokus();
    fokus.uploadFailures = [new Error('transient')];
    const data = withDefaults(null);
    const engine = build(vault, fokus, data);

    await engine.pushFile('Work/note.md');
    expect(fokus.uploads).toHaveLength(1);

    const result = await engine.pushFile('Work/note.md');

    expect(result.outcome).not.toBe('unchanged');
    expect(fokus.uploads).toHaveLength(2);
    const note = [...fokus.notes.values()].at(-1)!;
    expect(note.markdown).toContain('/v1/uploads/content/');
  });

  /**
   * Being refused for rate is about the connection, not the file. Carrying on
   * pushed the rest of the note into the same refusal and then recorded it
   * "synced" holding a fraction of its images — permanently, since the body
   * never changed again.
   */
  it('stops at a 429 instead of uploading the rest of the note into it', async () => {
    const vault = new FakeVault({
      'Work/note.md': '# T\n\n![[a.png]]\n\n![[b.png]]\n\n![[c.png]]',
    });
    for (const name of ['a', 'b', 'c']) {
      vault.binaries[`Work/${name}.png`] = new Uint8Array([1]).buffer;
    }
    const fokus = new FakeFokus();
    fokus.uploadFailures = [undefined, new FokusApiError('rate-limited', 429, 'Too many')];
    const data = withDefaults(null);

    const result = await build(vault, fokus, data).pushFile('Work/note.md');

    expect(result.outcome).toBe('error');
    expect(result.error).toBeInstanceOf(FokusApiError);
    // a.png and b.png were attempted; c.png was not.
    expect(fokus.uploads.map((u) => u.filename)).toEqual(['a.png', 'b.png']);
  });

  /** The engine must not keep announcing the same failure every 60 seconds. */
  it('reports a failing upload once, not on every sync', async () => {
    const vault = oneImage();
    const fokus = new FakeFokus();
    fokus.uploadFailures = [new Error('nope'), new Error('nope'), new Error('nope')];
    const notify = new FakeNotify();
    const engine = build(vault, fokus, withDefaults(null), notify);

    await engine.pushFile('Work/note.md');
    await engine.pushFile('Work/note.md');
    await engine.pushFile('Work/note.md');

    expect(notify.messages.filter((w) => w.includes('Could not upload'))).toHaveLength(1);
  });

  /** `50%.png` threw a URIError that escaped and stopped the note syncing. */
  it('syncs a note holding an image with a percent sign in its name', async () => {
    const vault = new FakeVault({ 'Work/note.md': '# T\n\n![shot](50%.png)' });
    vault.binaries['Work/50%.png'] = new Uint8Array([1]).buffer;
    const fokus = new FakeFokus();

    const result = await build(vault, fokus, withDefaults(null)).pushFile('Work/note.md');

    expect(result.outcome).not.toBe('error');
  });
});

describe('embed edge cases the review found', () => {
  /** The server rejects bmp, so advertising it burned an upload slot per sync. */
  it('does not treat a bmp as uploadable', () => {
    expect(findEmbeds('![[a.bmp]]', () => false)).toEqual([]);
    expect(findEmbeds('![[a.png]]', () => false)).toHaveLength(1);
  });

  /**
   * `findEmbeds` deliberately ignores fenced blocks, but `toWire` rewrote every
   * occurrence — so a note documenting the `![[...]]` syntax had its example
   * replaced by a signed URL on the Fokus side.
   */
  it('leaves an embed inside a fence alone on the way up', () => {
    const body = '![[a.png]]\n\n```\n![[a.png]]\n```';
    const isCode = (index: number) => index > body.indexOf('```');

    const wire = toWire(body, new Map([['![[a.png]]', '/u/1']]), isCode);

    expect(wire.split('/u/1')).toHaveLength(2);
    expect(wire).toContain('```\n![[a.png]]\n```');
  });

  it('still rewrites every embed when no code predicate is given', () => {
    expect(toWire('![[a.png]] ![[a.png]]', new Map([['![[a.png]]', '/u/1']]))).toBe(
      '![a.png](/u/1) ![a.png](/u/1)',
    );
  });

  /** `$&` in a filename is a replacement pattern, and spliced the match back in. */
  it('restores a filename containing a dollar pattern', () => {
    const raw = '![[a$&b.png]]';
    const urls = new Map([[raw, '/u/1']]);

    // the server re-rendered the alt text, so only the URL-keyed path matches
    expect(fromWire('![something else](/u/1)', urls)).toBe(raw);
  });
});

/**
 * Throttled to 6 uploads a minute, a note with many images takes longer to push
 * than the server's three-minute lock lasts. Without a renewal the lock expired
 * mid-run and Fokus went writable while the plugin was still uploading.
 */
describe('holding the lock across a long upload run', () => {
  it('renews the lock while it works through the images', async () => {
    const body = ['# T', ...Array.from({ length: 6 }, (_, i) => `![[i${i}.png]]`)].join('\n\n');
    const vault = new FakeVault({ 'Work/note.md': body });
    for (let i = 0; i < 6; i++) vault.binaries[`Work/i${i}.png`] = new Uint8Array([i]).buffer;
    const fokus = new FakeFokus();
    let minute = 0;
    let ids = 0;

    const engine = new SyncEngine({
      vault,
      fokus,
      notify: new FakeNotify(),
      data: withDefaults(null),
      scope: () => ({ folders: ['Work'] }),
      routing: () => ({}),
      syncTags: () => true,
      // one simulated minute per upload, as the real limiter would pace it
      now: () => new Date(Date.UTC(2026, 8, 17, 10, minute)),
      newId: () => `uid-${++ids}`,
      throttleUpload: async () => {
        minute++;
      },
    });

    await engine.pushFile('Work/note.md');

    expect(fokus.uploads).toHaveLength(6);
    expect(fokus.lockCalls).toBeGreaterThanOrEqual(5);
  });

  it('does not renew when the run is quick', async () => {
    const vault = new FakeVault({
      'Work/note.md': '# T\n\n![[a.png]]\n\n![[b.png]]',
    });
    vault.binaries['Work/a.png'] = new Uint8Array([1]).buffer;
    vault.binaries['Work/b.png'] = new Uint8Array([2]).buffer;
    const fokus = new FakeFokus();
    let ids = 0;

    await new SyncEngine({
      vault,
      fokus,
      notify: new FakeNotify(),
      data: withDefaults(null),
      scope: () => ({ folders: ['Work'] }),
      routing: () => ({}),
      syncTags: () => true,
      now: () => new Date('2026-09-17T10:00:00.000Z'),
      newId: () => `uid-${++ids}`,
    }).pushFile('Work/note.md');

    expect(fokus.lockCalls).toBe(0);
  });
});
