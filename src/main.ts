import { Notice, Platform, Plugin, TAbstractFile, TFile, debounce } from 'obsidian';

import { TokenStore, obsidianSecrets } from '@/auth/secrets';
import { FokusClient } from '@/api/client';
import { FokusApiError } from '@/api/errors';
import { isBackoff } from '@/sync/backoff';
import { RateLimiter } from '@/sync/rate-limiter';
import { NotesApi } from '@/api/notes';
import { TagsApi } from '@/api/taxonomy';
import { UploadsApi } from '@/api/uploads';
import { ObsidianSourceApi, WorkspacesApi } from '@/api/obsidian-source';
import { FokusSettingTab } from '@/settings/settings-tab';
import { isPathInScope } from '@/settings/scope';
import { PushResult, SyncEngine } from '@/sync/engine';
import { ApiFokusPort } from '@/sync/fokus-port';
import { PluginData, mirrorBelongsElsewhere, withDefaults } from '@/sync/state';
import { ObsidianVaultPort } from '@/sync/vault-port';
import { ConfirmModal } from '@/ui/confirm-modal';
import { SyncStatusBar } from '@/ui/status-bar';

/** Obsidian's own editor save is roughly 2s; wait past it before reacting. */
const MODIFY_DEBOUNCE_MS = 2500;

export default class FokusSyncPlugin extends Plugin {
  data!: PluginData;
  private tokens!: TokenStore;
  connected = false;

  private engine?: SyncEngine;
  private dirty = new Set<string>();
  private flushTimer?: number;
  private flushing = false;
  private pulling = false;
  /**
   * Self-imposed, not server-imposed. Note writes are not throttled today, but
   * a first sync of a large vault is exactly the traffic that would make them
   * so; pacing it is cheaper than discovering the limit by being refused.
   */
  private readonly limiter = new RateLimiter(100, 60_000);
  /**
   * Uploads, unlike note writes, really are capped at 10/min server-side — and
   * the cap is per-IP, so a Fokus web tab on the same connection spends from the
   * same allowance.
   *
   * The pair is what matters, not either number: a bucket issues its whole burst
   * at once and then refills, so the worst 60 seconds carries `burst + capacity`
   * uploads. 2 + 6 = 8 of the server's 10, leaving two for the web app and a
   * retry. The obvious-looking (8, burst 8) would have sent 15.
   */
  private readonly uploadLimiter = new RateLimiter(6, 60_000, undefined, 2);
  /**
   * `Plugin.saveData` rewrites the whole file, mirror entries and all, so
   * saving once per note made a 200-note sync 200 full writes of a growing
   * object. Coalescing keeps the queue durable without that.
   */
  private readonly persist = debounce(() => void this.saveData(this.data), 1_500, false);
  private unloaded = false;
  private sleepTimers = new Set<number>();
  private statusBar?: SyncStatusBar;
  private sourceId?: string;

  async onload(): Promise<void> {
    // One read: the token lives alongside the rest of the plugin data, so
    // loading twice would just be a second disk hit for the same object.
    const stored = (await this.loadData()) as (Partial<PluginData> & { token?: string }) | null;
    this.data = withDefaults(stored);
    this.tokens = new TokenStore(obsidianSecrets(this.app));

    // Anything left in `data.json` by a build that predates secret storage is
    // moved into the keychain and dropped from the file. The write happens
    // before the delete, so an interrupted migration never loses the token.
    if (this.tokens.migrate(stored?.token)) {
      new Notice('Your Fokus token has been moved out of the vault and into the system keychain.');
    }

    // Identify this install and this vault once, and keep them. The client id
    // must differ from every other Fokus client: a sign-in reusing one would
    // revoke the other client's tokens.
    this.data.clientId ??= crypto.randomUUID();
    this.data.vaultId ??= crypto.randomUUID();
    await this.saveData(this.data);

    // Anything left queued by a quit or a crash resumes rather than vanishing.
    for (const path of this.data.pending ?? []) this.dirty.add(path);

    this.statusBar = new SyncStatusBar(this.addStatusBarItem());

    // Registered once, here. Doing it inside connect() added another interval
    // and another focus handler on every Connect click.
    //
    // Polling rather than a socket: it is resumable, behaves the same offline,
    // and needs no long-lived connection in a plugin left open for weeks.
    this.registerInterval(window.setInterval(() => void this.pull(), PULL_INTERVAL_MS));
    this.registerDomEvent(window, 'focus', () => void this.pull());
    this.addSettingTab(new FokusSettingTab(this.app, this));

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => void this.syncQueued(),
    });

    this.addCommand({
      id: 'pull-now',
      name: 'Check Fokus for changes',
      callback: () => void this.pull(),
    });

    this.addCommand({
      id: 'sync-whole-vault',
      name: 'Sync every note in the selected folders',
      callback: () => this.confirmFullSync(),
    });

    // registerEvent, so listeners are torn down with the plugin rather than
    // outliving it and firing against a disposed engine.
    const onChange = (file: TAbstractFile) => this.markDirty(file);
    this.registerEvent(this.app.vault.on('modify', onChange));
    this.registerEvent(this.app.vault.on('create', onChange));
    this.registerEvent(this.app.vault.on('rename', onChange));

    // A deleted file stops syncing; its Fokus note is left alone. A file can
    // vanish for reasons that are not a decision to delete anything.
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        void this.forget(file);
      }),
    );

    // Cancel a pending flush on unload. registerEvent removes the listener but
    // not a timer already scheduled, and that timer would otherwise write
    // frontmatter into the user's files after the plugin had been disabled.
    this.register(() => this.cancelFlush());

    // NOT awaited: connect() makes two network calls with no timeout, and
    // Obsidian awaits each plugin's onload in turn — on a captive portal this
    // stalled startup for the length of a TCP timeout.
    if (this.token) {
      this.app.workspace.onLayoutReady(() => {
        void this.connect().catch(() => {
          // Opening the vault offline left the plugin inert until the user went
          // into settings, with a queue sitting untouched.
          this.statusBar?.error('not connected');
          this.registerInterval(
            window.setInterval(() => {
              if (!this.engine && !this.unloaded) void this.connect().catch(() => {});
            }, RECONNECT_MS),
          );
        });
      });
    }
  }

  /** Cancellable, so unload actually stops a pending wait. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(resolve, ms);
      this.sleepTimers.add(timer);
      this.register(() => window.clearTimeout(timer));
    });
  }

  onunload(): void {
    // Anything still queued must not run: pushFile writes frontmatter into the
    // user's files and creates notes, and doing that after the plugin has been
    // disabled is exactly what the guidelines warn about.
    this.unloaded = true;
    this.cancelFlush();
    // Give back anything still held, rather than leaving Fokus read-only until
    // the lease lapses.
    for (const path of this.dirty) void this.engine?.releaseLock(path);
    for (const timer of this.sleepTimers) window.clearTimeout(timer);
    this.sleepTimers.clear();
    this.dirty.clear();
  }

  /** Register the vault with Fokus and resolve which workspace to write into. */
  async connect(): Promise<{ workspaceName: string }> {
    if (!this.token) throw new Error('Add your access token first.');

    const client = new FokusClient({
      apiUrl: this.data.settings.apiUrl,
      token: this.token,
      clientId: this.data.clientId!,
    });

    const workspaces = await new WorkspacesApi(client).list();
    const workspace = workspaces.find((w) => w.isPersonal) ?? workspaces[0];
    if (!workspace) throw new Error('This account has no workspace.');
    client.update({ workspaceId: workspace._id });

    // A token for a different account makes every mirrored note id unreachable:
    // the ids belong to the old account, so each push is a 403 the user cannot
    // interpret. Drop the mirror and let the files re-adopt from their
    // frontmatter ids, the same path a lost cache takes.
    if (mirrorBelongsElsewhere(this.data.workspaceId, workspace._id)) {
      const forgotten = Object.keys(this.data.entries).length;
      this.data.entries = {};
      this.data.pending = [];
      this.dirty.clear();
      if (forgotten > 0) {
        new Notice(
          `This vault was synced with a different Fokus account. ${forgotten} note(s) will be re-linked.`,
        );
      }
    }
    this.data.workspaceId = workspace._id;

    const status = await new ObsidianSourceApi(client).connect({
      vaultId: this.data.vaultId!,
      name: this.app.vault.getName(),
      // Obsidian's own Platform, not process.platform: `process` is a Node
      // global and is not there on mobile, which would make this plugin
      // desktop-only by accident.
      platform: describePlatform(),
      pluginVersion: this.manifest.version,
    });
    if (!status.sourceId) throw new Error('Fokus did not return a connection id.');

    this.sourceId = status.sourceId;
    // Folder→bucket routing is configured in Fokus, so take it from the
    // connection rather than duplicating it in plugin settings.
    const vault = status.vaults.find((v) => v.vaultId === this.data.vaultId);
    this.data.folderMappings = vault?.folderMappings ?? {};
    // Turning tag sync off in Fokus had no effect: the flag was read off the
    // wire and then ignored.
    this.data.syncTags = status.syncTags !== false;
    await this.saveData(this.data);
    this.connected = true;

    const notes = new NotesApi(client);
    const tags = new TagsApi(client);
    const uploads = new UploadsApi(() => ({
      apiUrl: this.data.settings.apiUrl,
      token: this.token!,
      clientId: this.data.clientId!,
      workspaceId: workspace._id,
    }));
    this.engine = new SyncEngine({
      vault: new ObsidianVaultPort(this.app),
      fokus: new ApiFokusPort(notes, status.sourceId, tags, uploads, this.app.vault.getName()),
      notify: {
        info: (m) => new Notice(m),
        warn: (m) => new Notice(m),
      },
      data: this.data,
      // read fresh each time, so a settings change takes effect at once
      scope: () => ({ folders: this.data.settings.folders }),
      routing: () => this.data.folderMappings ?? {},
      syncTags: () => this.data.syncTags !== false,
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
      throttleUpload: async () => {
        const wait = this.uploadLimiter.reserve();
        if (wait > 0) await this.sleep(wait);
      },
    });

    this.statusBar?.idle();
    return { workspaceName: workspace.name };
  }

  /** The token itself never lives on this object; it is read on demand. */
  get token(): string | undefined {
    return this.tokens.get();
  }

  /**
   * Write the pasted token straight to the keychain.
   *
   * Nothing about it reaches `data.json` — not the value, and not an id, since
   * the id is a constant.
   */
  setToken(token: string): void {
    this.tokens.set(token);
  }

  /**
   * Writes settings as-is. The override that used to re-attach the token is
   * gone — the value belongs to the keychain now, and putting it back into the
   * file on every save is exactly what this change removes.
   */
  async saveData(data: unknown): Promise<void> {
    await super.saveData(data as object);
  }

  /**
   * Queue a file and restart the quiet timer.
   *
   * A single shared debouncer kept only the LAST file it saw, so editing two
   * notes inside the window synced one of them, and renaming a folder of fifty
   * notes updated exactly one. Collecting paths in a set fixes both while still
   * coalescing a burst of keystrokes into one pass.
   */
  private markDirty(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    if (!isPathInScope(file.path, { folders: this.data.settings.folders })) return;

    this.dirty.add(file.path);
    this.data.pending = [...this.dirty];
    // Held from the first keystroke, not just across the request: the window
    // that matters is the one where the user is still typing. Best-effort —
    // a lock that cannot be taken must never stop a local edit syncing.
    void this.engine?.holdLock(file.path);
    // Persisted here, not only in flush: a crash before the first file finished
    // used to lose the whole queue, despite the comment promising otherwise.
    this.persist();
    this.cancelFlush();
    this.flushTimer = window.setTimeout(() => void this.flush(), MODIFY_DEBOUNCE_MS);
  }

  private async forget(file: TAbstractFile): Promise<void> {
    if (!this.engine || !(file instanceof TFile)) return;

    this.dirty.delete(file.path);
    if ((await this.engine.forgetPath(file.path)) === 'unlinked') {
      this.data.pending = [...this.dirty];
      await this.saveData(this.data);
      new Notice(`${file.basename} stopped syncing. Its Fokus note was left as it is.`);
    }
  }

  private cancelFlush(): void {
    if (this.flushTimer !== undefined) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private async flush(): Promise<void> {
    this.flushTimer = undefined;
    // Symmetric with pull's guard. A pull holding a snapshot across its await
    // while a flush pushed the same file made the file visibly revert to the
    // remote version, and could turn a pure race into a real conflict.
    if (!this.engine || this.unloaded || this.flushing || this.pulling) return;

    const paths = [...this.dirty];
    if (!paths.length) return;

    // Look before pushing. The push path compares only the local hash, so
    // without this a remote edit made minutes ago was simply overwritten and
    // the conflict row was unreachable in the common case — the 2.5s debounce
    // beats a 60s poll almost every time.
    await this.pull();

    this.flushing = true;
    try {
      this.statusBar?.syncing(paths.length);
      const results: PushResult[] = [];

      for (const path of paths) {
        if (this.unloaded) return;

        const wait = this.limiter.reserve();
        if (wait > 0) await this.sleep(wait);
        // Re-checked after the wait: unload can happen during it, and the file
        // write that follows would otherwise land in a vault whose plugin is
        // already disabled.
        if (this.unloaded) return;

        const result = await this.engine.pushFile(path);
        results.push(result);

        // A path is only dropped once it has actually been dealt with. Deleting
        // it before checking the outcome discarded the very edit that had just
        // failed — it stayed gone until the user touched the file again.
        // Released before deciding what to do next: breaking out first left the
        // lock held until its TTL lapsed, blocking Fokus for three minutes over
        // a transient network error.
        await this.engine.releaseLock(path);

        if (result.outcome === 'error' && isBackoff(result.error)) break;
        this.dirty.delete(path);

        this.data.pending = [...this.dirty];
        this.persist();
      }

      await this.saveData(this.data);

      this.reportOutcomes(results);
    } catch (error) {
      this.reportFailure(error);
    } finally {
      this.flushing = false;
      // Whatever is left (a backoff, an unload) gets another go.
      if (this.dirty.size && !this.unloaded) {
        this.flushTimer = window.setTimeout(() => void this.flush(), BACKOFF_MS);
      }
    }
  }

  /**
   * Bring down what changed in Fokus.
   *
   * Skipped while a push is in flight: pulling a note we are halfway through
   * writing would compare the file against a version we ourselves are about to
   * replace, and invent a conflict out of it.
   */
  private async pull(): Promise<void> {
    if (!this.engine || this.unloaded || this.flushing || this.pulling) return;

    this.pulling = true;
    try {
      const results = await this.engine.pull();
      await this.saveData(this.data);

      const conflicts = results.filter((r) => r.outcome === 'conflict');
      const failures = results.filter((r) => r.outcome === 'error');
      const pulled = results.filter((r) => r.outcome === 'pulled');

      if (failures.length) {
        // Pull failures used to be filtered out entirely: no notice, no status
        // change, nothing — while the note quietly stopped coming down.
        this.reportFailure(failures[0]!.error ?? new Error(failures[0]!.detail ?? 'pull failed'));
      } else if (conflicts.length) {
        this.statusBar?.error(`${conflicts.length} conflict(s)`);
      } else if (pulled.length) {
        this.statusBar?.synced(new Date());
      }
    } catch (error) {
      this.reportFailure(error);
    } finally {
      this.pulling = false;
    }
  }

  /** Run whatever is queued right now, without waiting for the quiet timer. */
  private async syncQueued(): Promise<void> {
    if (!this.engine) {
      new Notice('Connect to Fokus first.');
      return;
    }
    this.cancelFlush();
    await this.flush();
  }

  private confirmFullSync(): void {
    if (!this.engine) {
      new Notice('Connect to Fokus first.');
      return;
    }

    const candidates = this.app.vault
      .getMarkdownFiles()
      .filter((file) => isPathInScope(file.path, { folders: this.data.settings.folders }));
    const unlinked = candidates.filter(
      (file) => !Object.values(this.data.entries).some((entry) => entry.path === file.path),
    );

    new ConfirmModal(
      this.app,
      {
        title: 'Sync every note in the selected folders',
        body:
          `${candidates.length} note(s) are in scope, ${unlinked.length} of which are not in Fokus yet. ` +
          'Notes already synced are left alone. This can take a while on a large vault.',
        confirmText: `Sync ${candidates.length} note(s)`,
      },
      () => void this.syncAll(),
    ).open();
  }

  private async syncAll(): Promise<void> {
    if (!this.engine) {
      new Notice('Connect to Fokus first.');
      return;
    }
    // One pass at a time. Two passes reaching the same unadopted file would mint
    // two ids and create two notes, and the frontmatter keeps only the last —
    // leaving an orphan whose external id exists in no file.
    if (this.flushing) {
      new Notice('A sync is already running.');
      return;
    }

    this.flushing = true;
    try {
      // A full sync covers every in-scope file, so anything queued is already
      // included; leaving it would run the whole vault twice.
      this.dirty.clear();
      this.data.pending = [];

      const results = await this.engine.pushAll({
        beforeEach: async () => {
          const wait = this.limiter.reserve();
          if (wait > 0) await this.sleep(wait);
        },
      });
      await this.saveData(this.data);

      this.reportOutcomes(results, { verbose: true });
    } catch (error) {
      this.reportFailure(error);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * The engine returns failures rather than throwing, so one bad file does not
   * abandon the rest of the vault — which means this is the ONLY place a
   * failure can reach the user. Discarding the results here previously left the
   * status bar reporting "synced" while nothing had synced.
   */
  private reportOutcomes(results: PushResult[], options: { verbose?: boolean } = {}): void {
    const failures = results.filter((r) => r.outcome === 'error');
    const unstable = results.filter((r) => r.outcome === 'unstable');
    const changed = results.filter(
      (r) => r.outcome === 'adopted' || r.outcome === 'pushed' || r.outcome === 'relinked',
    );

    if (failures.length) {
      // Report the first failure properly rather than a count: the response to
      // a paywall, a revoked token and a dropped connection are all different.
      this.reportFailure(failures[0]!.error ?? new Error(failures[0]!.detail ?? 'sync failed'));
      if (failures.length > 1) new Notice(`${failures.length} notes failed to sync.`);
      return;
    }

    if (unstable.length) {
      this.statusBar?.error(`${unstable.length} not syncable`);
      new Notice(`${unstable.length} note(s) could not be synced safely and were left untouched.`);
      return;
    }

    this.statusBar?.synced(new Date());
    if (options.verbose) new Notice(`Synced ${changed.length} note(s).`);
  }

  /** Each failure needs a different response, so they are not collapsed into one message. */
  private reportFailure(error: unknown): void {
    if (error instanceof FokusApiError) {
      if (error.kind === 'offline') {
        this.statusBar?.offline();
        return;
      }
      if (error.kind === 'pro-required') {
        this.statusBar?.error('Pro required');
        new Notice('Syncing notes to Fokus needs an active Pro subscription.');
        return;
      }
      if (error.kind === 'conflict') {
        // Somebody is editing the same note in Fokus. The edit is still in the
        // file and will go up once they stop — nothing is lost, so this says so
        // rather than reading like a failure.
        const holder = String((error.body?.lockedBy as string) ?? 'Fokus');
        this.statusBar?.error('waiting');
        new Notice(
          `This note is being edited in ${holder}. Your change will sync when they finish.`,
        );
        return;
      }
      if (error.kind === 'unrepresentable') {
        new Notice(
          'This note holds something markdown cannot carry (a mention, drawing or collapsible section), so it is edited in Fokus only.',
        );
        this.statusBar?.error('not syncable');
        return;
      }
      if (error.kind === 'unauthorized') {
        this.statusBar?.error('token expired');
        new Notice('Your Fokus token was rejected. Create a new one and paste it in settings.');
        return;
      }
      this.statusBar?.error(error.kind);
      new Notice(`Fokus sync: ${error.message}`);
      return;
    }
    this.statusBar?.error('failed');
    new Notice(`Fokus sync failed: ${String(error)}`);
  }
}

/** A short, stable label for which Obsidian this vault is running in. */
function describePlatform(): string {
  if (Platform.isIosApp) return 'ios';
  if (Platform.isAndroidApp) return 'android';
  if (Platform.isMacOS) return 'macos';
  if (Platform.isWin) return 'windows';
  if (Platform.isLinux) return 'linux';
  return 'unknown';
}

/** Wait before the next attempt after a rate limit or a dropped connection. */
const BACKOFF_MS = 30_000;

/** How often to ask Fokus what changed. */
const PULL_INTERVAL_MS = 60_000;

/** How often to retry a connection that failed at startup. */
const RECONNECT_MS = 5 * 60_000;
