import { canonicalBody } from '@/markdown/canonical';
import { readScalar, reassemble, splitFrontmatter } from '@/markdown/frontmatter';
import { sha256 } from '@/markdown/hash';
import { findEmbeds, fromWire, mimeFor, toWire } from '@/markdown/attachments';
import { collectTags, isInsideCode } from '@/markdown/tags';
import {
  NOTE_ID_KEY,
  OPT_OUT_KEY,
  ScopeSettings,
  bucketForPath,
  isOptedOut,
  isPathInScope,
} from '@/settings/scope';

import { FokusApiError } from '@/api/errors';

import { FokusPort, NoteMissingError, NotifyPort, RemoteNote, VaultPort } from './ports';
import { conflictPathFor } from './conflicts';
import { MirrorEntry, PluginData } from './state';

/**
 * How many times adoption will ask the server whether the content has settled.
 *
 * Three, because escaped markdown genuinely takes three passes to stop
 * changing — the loop previously ran two and declared such a file unstable.
 */
export const MAX_ADOPTION_PASSES = 3;

/**
 * How far the pull cursor is rewound each run.
 *
 * Clocks differ and two notes can share a millisecond; re-examining a few
 * already-seen notes is free, missing one is permanent.
 */
export const CURSOR_OVERLAP_MS = 60_000;

/** A ceiling on one pull, so a clock problem cannot spin forever. */
export const MAX_PULL_PAGES = 50;

export type PullOutcome =
  | 'unchanged'
  | 'pulled'
  | 'conflict'
  | 'skipped-unknown'
  | 'skipped-local-only'
  | 'skipped-out-of-scope'
  | 'skipped-opted-out'
  | 'skipped-missing'
  | 'error';

export interface PullResult {
  noteId: string;
  path?: string;
  outcome: PullOutcome;
  /** Where the Fokus version was written, when it was a conflict. */
  conflictPath?: string;
  detail?: string;
  error?: unknown;
}

export type FileOutcome =
  | 'skipped-out-of-scope'
  | 'skipped-opted-out'
  | 'unchanged'
  | 'adopted'
  | 'pushed'
  | 'relinked'
  | 'unstable'
  | 'error';

export interface PushResult {
  path: string;
  outcome: FileOutcome;
  noteId?: string;
  detail?: string;
  /**
   * The failure, when there was one. The engine does not throw — one bad file
   * must not abandon the rest of the vault — but swallowing the error entirely
   * left the UI reporting "synced" while nothing had synced. Callers read this.
   */
  error?: unknown;
}

export interface EngineDeps {
  vault: VaultPort;
  fokus: FokusPort;
  notify: NotifyPort;
  data: PluginData;
  /**
   * Read fresh on every file, never captured. Holding the array meant editing
   * "Folders to sync" did nothing until Obsidian restarted — and worse, the
   * plugin kept syncing a folder the user had just removed.
   */
  scope: () => ScopeSettings;
  /** Vault folder → Fokus bucket, read fresh for the same reason as scope. */
  routing: () => Record<string, string>;
  /** False stops tags being collected at all — the setting lives in Fokus. */
  syncTags: () => boolean;
  /** Injected so tests need no clock control and no uuid stubbing. */
  now: () => Date;
  newId: () => string;
  /**
   * Awaited before every attachment upload. Uploads ARE throttled server-side
   * (10/min), unlike note writes, so a note holding 50 images is the one case
   * that reliably earns a 429 — and a 429 mid-note leaves the embeds it already
   * uploaded orphaned. Defaults to no wait so tests need no clock.
   */
  throttleUpload?: () => Promise<void>;
}

/** What a note carries, beyond its body. */
interface Attributes {
  tagIds: string[];
  /** null when no folder maps, so an update actually clears it. */
  bucketId: string | null;
}

/** Vault embed → uploaded URL, for one note. */
/** Renew a held lock this often while a long upload run is in flight. */
const LOCK_RENEW_MS = 60_000;

type AttachmentMap = Record<string, string>;
/** Embed → `size:mtime` of the file at the time it was uploaded. */
type AttachmentStamps = Record<string, string>;

/**
 * The push half of the sync.
 *
 * Everything is keyed on the `fokus-id` in frontmatter, so a rename or a move
 * inside the vault costs nothing — the id travels with the file. Change
 * detection compares canonical forms, never raw bytes, because the server and
 * the editor format the same content differently and neither is wrong.
 */
export class SyncEngine {
  constructor(private deps: EngineDeps) {}

  async pushAll(
    options: { beforeEach?: (path: string) => Promise<void> } = {},
  ): Promise<PushResult[]> {
    const paths = await this.deps.vault.listMarkdown();

    // Settle duplicated ids before anything is pushed. Done per-file instead,
    // the outcome depended on walk order — and Obsidian names a duplicate
    // `note copy.md`, which sorts BEFORE `note.md`, so the copy routinely won
    // and the original was handed a brand-new empty note.
    await this.resolveDuplicateIds(paths);

    const results: PushResult[] = [];
    for (const path of paths) {
      // A first full sync is exactly the traffic the rate limit exists for, and
      // this ran completely unthrottled.
      await options.beforeEach?.(path);
      results.push(await this.pushFile(path));
    }
    return results;
  }

  /**
   * Give every file its own id.
   *
   * The keeper is the path the mirror already knows; failing that, the shortest
   * path, because a duplicate is named by adding to the original's name
   * (`note.md` → `note copy.md`). Losers have their id cleared and are adopted
   * fresh on the pass that follows.
   */
  private async resolveDuplicateIds(paths: string[]): Promise<void> {
    const claims = new Map<string, string[]>();

    for (const path of paths) {
      if (!isPathInScope(path, this.deps.scope())) continue;
      let id: string | undefined;
      try {
        id = readScalar(
          splitFrontmatter(await this.deps.vault.read(path)).frontmatter,
          NOTE_ID_KEY,
        );
      } catch {
        continue;
      }
      if (id) claims.set(id, [...(claims.get(id) ?? []), path]);
    }

    for (const [externalId, claimants] of claims) {
      if (claimants.length < 2) continue;

      const known = this.deps.data.entries[externalId]?.path;
      const keeper =
        known && claimants.includes(known)
          ? known
          : [...claimants].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;

      for (const path of claimants) {
        if (path === keeper) continue;
        const minted = this.deps.newId();
        await this.deps.vault.setFrontmatterKey(path, NOTE_ID_KEY, minted);
        this.deps.notify.warn(
          `${this.deps.vault.basename(path)} shared a Fokus link with another note; it now has its own.`,
        );
      }
    }
  }

  /**
   * A file left the vault.
   *
   * The Fokus note is kept and simply stops syncing. A file can disappear for
   * reasons that are not a decision to delete anything — a move out of a synced
   * folder, a vault-sync hiccup, a mistaken keystroke — and deleting somebody's
   * note on that evidence is not recoverable. Re-creating the file with the
   * same `fokus-id` re-links it.
   */
  async forgetPath(path: string): Promise<'unlinked' | 'not-linked'> {
    const externalId = Object.keys(this.deps.data.entries).find(
      (id) => this.deps.data.entries[id]!.path === path,
    );
    if (!externalId) return 'not-linked';

    const entry = this.deps.data.entries[externalId]!;
    delete this.deps.data.entries[externalId];
    await this.deps.fokus.unlock(entry.noteId).catch(() => undefined);

    return 'unlinked';
  }

  /**
   * Upload any embed that has not been uploaded yet, and return the full map.
   *
   * Runs AFTER the note exists, because the server keys an upload to an entity
   * id. Already-known embeds are skipped, so the same image is not re-uploaded
   * on every sync — that cache is the difference between a re-sync costing
   * nothing and costing the whole vault's images again.
   *
   * An upload that fails does not fail the note: the embed stays as literal
   * text in Fokus and is retried next time, which is a better outcome than the
   * note not syncing at all.
   */
  /**
   * Whether the note still holds an embed we have no URL for and could upload.
   *
   * Without this the body hash alone decided, and the body does not change when
   * an upload fails — so a single failed image left the note reporting
   * "unchanged" for good and the notice promising a retry was a lie. Only
   * embeds whose file actually exists count, or a link to a deleted image would
   * make the note push on every sync forever.
   */
  private async hasPendingUploads(
    path: string,
    body: string,
    known: AttachmentMap,
    stamps: AttachmentStamps,
  ): Promise<boolean> {
    for (const embed of findEmbeds(body, isInsideCode(body))) {
      const resolved = this.deps.vault.resolveLink(embed.target, path);
      if (!resolved) continue;
      if (!known[embed.raw]) return true;
      if (stamps[embed.raw] !== (await this.stampFor(resolved))) return true;
    }
    return false;
  }

  private async uploadEmbeds(
    path: string,
    body: string,
    noteId: string,
    known: AttachmentMap,
    knownStamps: AttachmentStamps = {},
  ): Promise<{ map: AttachmentMap; stamps: AttachmentStamps }> {
    const embeds = findEmbeds(body, isInsideCode(body));
    if (!embeds.length) return { map: known, stamps: knownStamps };

    const map: AttachmentMap = { ...known };
    const stamps: AttachmentStamps = { ...knownStamps };
    let lockHeldAt = this.deps.now().getTime();

    for (const embed of embeds) {
      const resolved = this.deps.vault.resolveLink(embed.target, path);
      if (!resolved) continue;

      const stamp = await this.stampFor(resolved);
      // Re-upload when the bytes behind an unchanged name have changed.
      if (map[embed.raw] && stamps[embed.raw] === stamp) continue;

      try {
        await this.deps.throttleUpload?.();
        // The server's lock lasts three minutes; throttled to stay inside the
        // upload cap, a note full of images takes longer than that to push. Left
        // un-renewed the lock expired halfway through and Fokus became writable
        // while we were still uploading — precisely the window the lock exists
        // to close. `lock` renews as well as acquires.
        const at = this.deps.now().getTime();
        if (at - lockHeldAt >= LOCK_RENEW_MS) {
          lockHeldAt = at;
          await this.deps.fokus.lock(noteId).catch(() => undefined);
        }
        const data = await this.deps.vault.readBinary(resolved);
        map[embed.raw] = await this.deps.fokus.uploadAttachment({
          noteId,
          filename: resolved.split('/').pop() ?? embed.target,
          contentType: mimeFor(resolved),
          data,
        });
        stamps[embed.raw] = stamp;
      } catch (error) {
        // Being rate-limited or offline is about the connection, not this file:
        // carrying on uploads the rest of the note into the same refusal and
        // then records it "synced" holding one image in three. Rethrowing stops
        // the loop, marks the push an error, and is what `flush()` reads to back
        // off — absorbing it here made the backoff unreachable.
        if (
          error instanceof FokusApiError &&
          (error.kind === 'rate-limited' || error.kind === 'offline')
        ) {
          throw error;
        }
        // Anything else is specific to this file. It degrades to literal text in
        // Fokus and is retried on the next sync (see `hasPendingUploads`).
        // Reported rather than swallowed — silently dropping an attachment means
        // the user only finds out by noticing a missing image later, if at all.
        if (!this.warnedUploads.has(`${path}\u0000${embed.raw}`)) {
          this.warnedUploads.add(`${path}\u0000${embed.raw}`);
          this.deps.notify.warn(
            `Could not upload ${embed.target}: ${describe(error)}. It will be retried.`,
          );
        }
        continue;
      }
    }

    return { map, stamps };
  }

  /** `size:mtime`, or `?` when the file is gone — cheap, and no file read. */
  private async stampFor(path: string): Promise<string> {
    const info = await this.deps.vault.stat(path);
    return info ? `${info.size}:${info.mtime}` : '?';
  }

  /**
   * Take the edit lock for a file that is about to be edited, so Fokus goes
   * read-only instead of racing us into a conflict.
   *
   * Held from the first keystroke until the push lands, not just across the
   * request — the window that matters is the one where the user is typing.
   * Best-effort: a lock that cannot be taken must never stop a local edit
   * syncing, because the vault is the side that works offline.
   */
  async holdLock(path: string): Promise<void> {
    const entry = this.entryForPath(path);
    if (!entry) return;
    await this.deps.fokus.lock(entry.noteId).catch(() => undefined);
  }

  async releaseLock(path: string): Promise<void> {
    const entry = this.entryForPath(path);
    if (!entry) return;
    await this.deps.fokus.unlock(entry.noteId).catch(() => undefined);
  }

  private entryForPath(path: string): MirrorEntry | undefined {
    return Object.values(this.deps.data.entries).find((entry) => entry.path === path);
  }

  /**
   * Bring down what changed in Fokus since the last pull.
   *
   * Only notes this vault owns come back — the query is scoped to this
   * connection's source — so a note written natively in Fokus is excluded by
   * construction rather than by a filter that could drift.
   *
   * The cursor is rewound slightly on each run. Re-examining a handful of notes
   * costs nothing (an unchanged one compares equal and is dropped), whereas a
   * note updated in the same millisecond the cursor was taken would otherwise
   * be missed for good.
   */
  async pull(): Promise<PullResult[]> {
    const cursor = this.deps.data.pullCursor ?? new Date(0).toISOString();
    const results: PullResult[] = [];
    let at = cursor;
    let furthestClean = cursor;

    // Paged ascending, and driven by progress rather than by a page size the
    // engine cannot actually see — the port chooses that, and comparing against
    // a constant here stopped after one page whenever the two disagreed.
    //
    // The filter is `$gte`, so each page re-includes the note the cursor sits
    // on; `seen` is what turns that overlap into termination instead of a loop.
    const seen = new Set<string>();

    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const batch = await this.deps.fokus.listChangedSince(at);
      const fresh = batch.filter((note) => !seen.has(note.id));
      if (!fresh.length) break;

      for (const remote of fresh) {
        seen.add(remote.id);
        const result = await this.pullOne(remote);
        results.push(result);
        // The cursor only moves past notes that were actually dealt with; a
        // note that errored must come round again rather than be skipped once
        // the overlap lapses.
        if (result.outcome !== 'error' && remote.updatedAt > furthestClean) {
          furthestClean = remote.updatedAt;
        }
        if (remote.updatedAt > at) at = remote.updatedAt;
      }
    }

    this.deps.data.pullCursor = rewind(furthestClean, CURSOR_OVERLAP_MS);

    return results;
  }

  private async pullOne(remote: RemoteNote): Promise<PullResult> {
    const externalId = remote.sourceOriginalId;
    if (!externalId) return { noteId: remote.id, outcome: 'skipped-unknown' };

    const entry = this.deps.data.entries[externalId];
    // A note we have never pushed. Bringing it down would mean inventing a
    // filename and a folder for it, which is the "pull everything into the
    // vault" behaviour this sync deliberately does not have.
    if (!entry) return { noteId: remote.id, outcome: 'skipped-local-only' };

    // The same two gates the push applies. Without them, un-ticking a folder
    // stopped pushing but left Fokus able to overwrite those files, and
    // `fokus-sync: false` — which the README calls keeping a note out of sync —
    // did not stop the note being overwritten from Fokus either.
    if (!isPathInScope(entry.path, this.deps.scope())) {
      return {
        noteId: remote.id,
        path: entry.path,
        outcome: 'skipped-out-of-scope',
      };
    }

    try {
      if (!(await this.deps.vault.exists(entry.path))) {
        // The file went away while we were not watching. Reading it threw and
        // was swallowed as an error on every pull from then on.
        delete this.deps.data.entries[externalId];
        return {
          noteId: remote.id,
          path: entry.path,
          outcome: 'skipped-missing',
        };
      }
      // Back into the vault's syntax before anything is compared or written,
      // so a pull can never replace `![[diagram.png]]` with a signed URL.
      const remoteBody = canonicalBody(fromWire(remote.markdown, toMap(entry.attachments ?? {})));
      const remoteHash = await sha256(remoteBody);
      if (remoteHash === entry.remoteHash) {
        return { noteId: remote.id, path: entry.path, outcome: 'unchanged' };
      }

      const raw = await this.deps.vault.read(entry.path);
      const { frontmatter, body } = splitFrontmatter(raw);
      if (isOptedOut(readScalar(frontmatter, OPT_OUT_KEY))) {
        return {
          noteId: remote.id,
          path: entry.path,
          outcome: 'skipped-opted-out',
        };
      }
      const localBody = canonicalBody(body);
      const localChanged =
        (await this.signatureFor(entry.path, frontmatter, localBody)) !== entry.localHash;

      if (localChanged) return await this.writeConflict(entry, externalId, remote, remoteBody);

      await this.deps.vault.write(entry.path, reassemble(frontmatter, remoteBody));
      this.record(externalId, {
        ...entry,
        localHash: await this.signatureFor(entry.path, frontmatter, remoteBody),
        remoteHash,
        lastSyncedAt: this.deps.now().toISOString(),
        status: 'synced',
      });
      return { noteId: remote.id, path: entry.path, outcome: 'pulled' };
    } catch (error) {
      return {
        noteId: remote.id,
        path: entry.path,
        outcome: 'error',
        detail: describe(error),
        error,
      };
    }
  }

  /**
   * Both sides moved. Neither version is discarded: the file keeps what the
   * user has in front of them, and the Fokus version lands beside it as its own
   * note-less file, carrying no `fokus-id` so it is never itself synced.
   */
  private async writeConflict(
    entry: MirrorEntry,
    externalId: string,
    remote: RemoteNote,
    remoteBody: string,
  ): Promise<PullResult> {
    // A real existence check, not `() => false`: two conflicts on the same day
    // resolved to the same name, and the second silently overwrote the first.
    const naming = await conflictPathFor(entry.path, this.deps.now(), (candidate) =>
      this.deps.vault.exists(candidate),
    );

    // `create`, not `write`: the copy is a new file, and the vault adapter can
    // only overwrite. This threw in the real plugin, was swallowed as an error,
    // and the Fokus version was then lost to the next push.
    //
    // `fokus-sync: false` is what actually keeps the copy inert. Saying it
    // "carries no fokus-id so it is never synced" was wrong: a file in a synced
    // folder with no id is precisely the shape of one waiting to be adopted, so
    // every conflict created a junk Fokus note and rewrote the copy the user
    // had been told was untouched.
    await this.deps.vault.create(naming.path, `---\n${OPT_OUT_KEY}: false\n---\n\n${remoteBody}\n`);

    // The mirror now agrees with the REMOTE, so the next push sends the local
    // version up and both sides end on what the user has. Leaving it disagreeing
    // would raise the same conflict again on the next pull.
    this.record(externalId, {
      ...entry,
      remoteHash: await sha256(remoteBody),
      lastSyncedAt: this.deps.now().toISOString(),
      status: 'conflict',
      note: `The Fokus version was saved as ${naming.basename}.`,
    });

    this.deps.notify.warn(
      `${this.deps.vault.basename(entry.path)} changed in both places. The Fokus version is saved as ${naming.basename}.`,
    );

    return {
      noteId: remote.id,
      path: entry.path,
      outcome: 'conflict',
      conflictPath: naming.path,
    };
  }

  /** The same signature `pushFile` computes, so the two halves agree. */
  private async signatureFor(path: string, frontmatter: string, body: string): Promise<string> {
    const tagNames = this.deps.syncTags() ? collectTags(frontmatter, body) : [];
    return await this.signature(body, tagNames, {
      tagIds: [],
      bucketId: bucketForPath(path, this.deps.routing()) ?? null,
    });
  }

  async pushFile(path: string): Promise<PushResult> {
    if (!isPathInScope(path, this.deps.scope())) {
      return { path, outcome: 'skipped-out-of-scope' };
    }

    try {
      const raw = await this.deps.vault.read(path);
      const { frontmatter, body } = splitFrontmatter(raw);

      if (isOptedOut(readScalar(frontmatter, OPT_OUT_KEY))) {
        return { path, outcome: 'skipped-opted-out' };
      }

      const tagNames = this.deps.syncTags() ? collectTags(frontmatter, body) : [];
      const attributes: Attributes = {
        tagIds: await this.deps.fokus.resolveTags(tagNames),
        bucketId: bucketForPath(path, this.deps.routing()) ?? null,
      };

      const externalId = readScalar(frontmatter, NOTE_ID_KEY);
      return externalId
        ? await this.pushLinked(path, externalId, body, tagNames, attributes)
        : await this.adopt(path, body, tagNames, attributes);
    } catch (error) {
      return { path, outcome: 'error', detail: describe(error), error };
    }
  }

  /**
   * First contact for a file: mint an id, write it into frontmatter BEFORE the
   * create, then converge.
   *
   * The id goes in first on purpose. If the create succeeds but the plugin dies
   * before recording anything, the file still carries the id, and the next run
   * finds the existing note by it instead of creating a second one.
   */
  private async adopt(
    path: string,
    body: string,
    tagNames: string[],
    attributes: Attributes,
  ): Promise<PushResult> {
    const externalId = this.deps.newId();
    await this.deps.vault.setFrontmatterKey(path, NOTE_ID_KEY, externalId);

    const sent = canonicalBody(body);
    const created = await this.deps.fokus.create({
      title: this.deps.vault.basename(path),
      markdown: sent,
      sourceOriginalId: externalId,
      tagIds: attributes.tagIds,
      ...(attributes.bucketId ? { bucketId: attributes.bucketId } : {}),
    });

    // The note has to exist before its images can be attached to it, so the
    // first create carries the embeds as text and a second write replaces them
    // with URLs. A crash in between leaves literal text in Fokus, which the
    // next sync fixes — the note is never left half-written.
    const { map: attachments, stamps: attachmentStamps } = await this.uploadEmbeds(
      path,
      sent,
      created.id,
      {},
    );
    const remote = Object.keys(attachments).length
      ? await this.deps.fokus.update(created.id, {
          markdown: toWire(sent, toMap(attachments), isInsideCode(sent)),
        })
      : created;

    const settled = await this.settledForm(remote);

    // Refusing means leaving the body exactly as the user wrote it. The earlier
    // version rewrote the file on every probe and then recorded a status nobody
    // read, so a "refused" file was mutated three times and adopted normally on
    // the next sync. Only the frontmatter id stays, so the refusal is
    // remembered and the note is not created a second time.
    if (settled === null) {
      this.record(externalId, {
        noteId: remote.id,
        path,
        localHash: await this.signature(sent, tagNames, attributes),
        remoteHash: await sha256(canonicalBody(remote.markdown)),
        lastSyncedAt: this.deps.now().toISOString(),
        status: 'unstable',
        note: 'Markdown for this note does not settle, so syncing it would rewrite it endlessly.',
      });
      return {
        path,
        outcome: 'unstable',
        noteId: remote.id,
        detail: 'never reached a fixed point',
      };
    }

    // Back into the vault's own syntax first. Writing the settled form straight
    // to disk replaced every `![[diagram.png]]` with a signed URL — a permanent,
    // visible edit to the user's note for Fokus's benefit.
    //
    // It is also what the hash must be taken over: derived from the SETTLED
    // body rather than the one that was sent, because recording the
    // pre-normalisation state described something that never existed and made
    // the next sync push again.
    const settledBody = canonicalBody(fromWire(settled.markdown, toMap(attachments)));

    // One write, only when the settled form actually differs.
    if (settledBody !== sent) {
      const { frontmatter } = splitFrontmatter(await this.deps.vault.read(path));
      await this.deps.vault.write(path, reassemble(frontmatter, settledBody));
    }

    const settledHash = await this.signature(
      settledBody,
      collectTags(splitFrontmatter(await this.deps.vault.read(path)).frontmatter, settledBody),
      attributes,
    );
    this.record(externalId, {
      ...(await this.entryFor(path, settled, settledHash, attachments)),
      attachments,
      attachmentStamps,
    });
    return { path, outcome: 'adopted', noteId: settled.id };
  }

  /**
   * Ask the server whether this content settles, without touching the file.
   *
   * Re-sending the server's own output is not a no-op: escaped markdown takes
   * three passes to stop changing, so one round trip proves nothing. Probing on
   * the server rather than through the vault means a file that never settles is
   * never rewritten at all.
   *
   * Returns the settled note, or null if it was still moving after the limit.
   */
  private async settledForm(created: RemoteNote): Promise<RemoteNote | null> {
    let current = created;

    for (let pass = 0; pass < MAX_ADOPTION_PASSES; pass++) {
      const echoed = await this.deps.fokus.update(current.id, {
        markdown: canonicalBody(current.markdown),
      });
      if (canonicalBody(echoed.markdown) === canonicalBody(current.markdown)) return echoed;
      current = echoed;
    }

    return null;
  }

  /** A file that already carries an id: push only when the body actually changed. */
  private async pushLinked(
    path: string,
    externalId: string,
    body: string,
    tagNames: string[],
    attributes: Attributes,
  ): Promise<PushResult> {
    const entry = this.deps.data.entries[externalId];
    const sent = canonicalBody(body);
    // Covers the tags and bucket too: editing frontmatter tags changes nothing
    // in the body, and hashing the body alone would call that "unchanged".
    const localHash = await this.signature(sent, tagNames, attributes);

    // A refusal has to survive. It only lifts when the user changes the file —
    // the content that would not settle is the content we must not push.
    if (entry?.status === 'unstable' && entry.localHash === localHash) {
      return {
        path,
        outcome: 'unstable',
        noteId: entry.noteId,
        detail: entry.note,
      };
    }

    // No mirror entry: a first run after losing data.json, or the file arrived
    // from another machine. The id is authoritative, so look the note up rather
    // than creating a second one.
    if (!entry) {
      const existing = await this.deps.fokus.findBySourceOriginalId(externalId);
      if (!existing) return await this.adoptExisting(path, externalId, sent, localHash, attributes);

      // Recovered from the ids in the files alone, so nothing is known about
      // this note's attachments: re-upload rather than leave every embed as
      // dead text in Fokus. The server does NOT de-duplicate — it names every
      // object afresh — so this orphans the previous copies in storage. That is
      // the deliberate trade: a few stranded objects against a note full of
      // broken images, and it happens only when the local cache is lost.
      const { map: relinked, stamps: relinkedStamps } = await this.uploadEmbeds(
        path,
        sent,
        existing.id,
        {},
      );
      const updated = await this.deps.fokus.update(existing.id, {
        markdown: toWire(sent, toMap(relinked), isInsideCode(sent)),
        title: this.deps.vault.basename(path),
        ...attributes,
      });
      this.record(externalId, {
        ...(await this.entryFor(path, updated, localHash, relinked)),
        attachments: relinked,
        attachmentStamps: relinkedStamps,
      });
      return { path, outcome: 'relinked', noteId: updated.id };
    }

    // Duplicating a note is one keystroke, and the copy carries the same
    // fokus-id. Left alone the two files would fight over one note, each
    // overwriting the other forever. The file at the recorded path keeps the
    // id; the newcomer is re-minted and becomes a note of its own.
    if (entry.path !== path && (await this.deps.vault.exists(entry.path))) {
      const holderId = readScalar(
        splitFrontmatter(await this.deps.vault.read(entry.path)).frontmatter,
        NOTE_ID_KEY,
      );
      if (holderId === externalId) {
        return await this.adopt(path, body, tagNames, attributes);
      }
    }

    if (
      entry.localHash === localHash &&
      entry.path === path &&
      !(await this.hasPendingUploads(
        path,
        sent,
        entry.attachments ?? {},
        entry.attachmentStamps ?? {},
      ))
    ) {
      return { path, outcome: 'unchanged', noteId: entry.noteId };
    }

    const { map: attachments, stamps: attachmentStamps } = await this.uploadEmbeds(
      path,
      sent,
      entry.noteId,
      entry.attachments ?? {},
      entry.attachmentStamps ?? {},
    );

    let updated: RemoteNote;
    try {
      updated = await this.deps.fokus.update(entry.noteId, {
        markdown: toWire(sent, toMap(attachments), isInsideCode(sent)),
        title: this.deps.vault.basename(path),
        ...attributes,
      });
    } catch (error) {
      // The note was deleted in Fokus while the mirror still pointed at it.
      // Without this the file errored on every sync from then on, for good.
      if (!(error instanceof NoteMissingError)) throw error;
      delete this.deps.data.entries[externalId];
      return await this.adoptExisting(path, externalId, sent, localHash, attributes);
    }

    this.record(externalId, {
      ...(await this.entryFor(path, updated, localHash, attachments)),
      attachments,
      attachmentStamps,
    });
    return { path, outcome: 'pushed', noteId: updated.id };
  }

  /** The id exists in the file but nowhere in Fokus — create against that same id. */
  private async adoptExisting(
    path: string,
    externalId: string,
    sent: string,
    localHash: string,
    attributes: Attributes,
  ): Promise<PushResult> {
    // No catch here beyond what the port already does: ApiFokusPort turns a
    // duplicate into the existing note, so the race this used to die on — the
    // note existing but being invisible to a workspace-scoped lookup — resolves
    // into an adoption instead of a permanent, silent failure.
    const created = await this.deps.fokus.create({
      title: this.deps.vault.basename(path),
      markdown: sent,
      sourceOriginalId: externalId,
      tagIds: attributes.tagIds,
      ...(attributes.bucketId ? { bucketId: attributes.bucketId } : {}),
    });

    // Same two-step as adopt: the note must exist before its images can be
    // attached to it.
    const { map: attachments, stamps: attachmentStamps } = await this.uploadEmbeds(
      path,
      sent,
      created.id,
      {},
    );
    const remote = Object.keys(attachments).length
      ? await this.deps.fokus.update(created.id, {
          markdown: toWire(sent, toMap(attachments), isInsideCode(sent)),
        })
      : created;

    this.record(externalId, {
      ...(await this.entryFor(path, remote, localHash, attachments)),
      attachments,
      attachmentStamps,
    });
    return { path, outcome: 'adopted', noteId: remote.id };
  }

  /**
   * Records the hash of the body that was SENT, never a fresh read of the file.
   *
   * Re-reading after the network call recorded whatever the user had typed
   * meanwhile as "already agreed", so their next save compared equal and was
   * never pushed — a silently lost edit.
   */
  /** Path+embed pairs already reported this session, so a retry loop stays quiet. */
  private readonly warnedUploads = new Set<string>();

  private async entryFor(
    path: string,
    remote: RemoteNote,
    sentHash: string,
    attachments: AttachmentMap,
  ): Promise<MirrorEntry> {
    return {
      noteId: remote.id,
      path,
      localHash: sentHash,
      // Hashed in the VAULT's syntax, which is the form `pullOne` compares
      // against. Hashing `remote.markdown` directly stored the WIRE form, with
      // `![](/v1/uploads/...)` where the file says `![[img.png]]` — so for any
      // note holding an embed the two could never be equal, the "nothing
      // changed" short-circuit was dead, and every 60-second poll either
      // rewrote the user's file or, once the user had touched it, manufactured
      // a conflict copy out of nothing.
      remoteHash: await sha256(canonicalBody(fromWire(remote.markdown, toMap(attachments)))),
      lastSyncedAt: this.deps.now().toISOString(),
      status: 'synced',
    };
  }

  /**
   * One hash over everything that would need pushing if it changed.
   *
   * The separators are control characters so no tag name can impersonate a
   * field boundary and two different notes collide on the same signature.
   */
  private async signature(
    canonical: string,
    tagNames: string[],
    attributes: Attributes,
  ): Promise<string> {
    return await sha256(
      `${canonical}\u0000tags:${[...tagNames].sort().join(',')}\u0000bucket:${attributes.bucketId ?? ''}`,
    );
  }

  private record(externalId: string, entry: MirrorEntry): void {
    this.deps.data.entries[externalId] = entry;
  }
}

/** The stored record is a plain object so it survives JSON; the rewriters want a Map. */
function toMap(attachments: AttachmentMap): Map<string, string> {
  return new Map(Object.entries(attachments));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rewind(timestamp: string, ms: number): string {
  const at = new Date(timestamp).getTime();
  return new Date(Number.isNaN(at) ? Date.now() - ms : at - ms).toISOString();
}
