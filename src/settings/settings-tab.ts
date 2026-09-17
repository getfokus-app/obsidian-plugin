import {
  App,
  Notice,
  PluginSettingTab,
  SecretComponent,
  Setting,
  debounce,
  normalizePath,
} from 'obsidian';

import type FokusSyncPlugin from '@/main';
import { DEFAULT_API_URL, showsCustomServer } from '@/sync/state';

/**
 * Settings.
 *
 * The token is pasted rather than obtained through a sign-in flow: Obsidian has
 * no secure storage, so the fewer credentials this plugin holds the better. A
 * Fokus access token is scoped, expires, and can be revoked on its own without
 * touching the user's password or their other sessions.
 */
export class FokusSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: FokusSyncPlugin,
  ) {
    super(app, plugin);
  }

  /**
   * Saving on every keystroke wrote data.json once per character — and
   * persisted every partial prefix of the token to disk along the way.
   */
  private readonly save = debounce(() => void this.plugin.saveData(this.plugin.data), 600, true);

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const settings = this.plugin.data.settings;
    // Forced on whenever the stored URL is not the default, so a non-live
    // server can never sit hidden behind a toggle that is off. Hidden
    // configuration that still takes effect is how "it points at the wrong
    // server" becomes impossible to diagnose from the screen.
    const custom = showsCustomServer(settings);

    new Setting(containerEl)
      .setName('Developer mode')
      .setDesc('Point the plugin at a local or staging Fokus server instead of the live one.')
      .addToggle((toggle) =>
        toggle.setValue(custom).onChange((value) => {
          settings.customServer = value;
          // Turning it off returns to Fokus rather than keeping the old URL out
          // of sight, which would leave the plugin pointed somewhere the
          // settings screen no longer admits to.
          if (!value) settings.apiUrl = DEFAULT_API_URL;
          this.save();
          this.display();
        }),
      );

    if (custom) {
      new Setting(containerEl)
        .setName('Fokus server')
        .setDesc('The address of your Fokus API.')
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_API_URL)
            .setValue(settings.apiUrl)
            .onChange((value) => {
              settings.apiUrl = value.trim() || DEFAULT_API_URL;
              this.save();
            }),
        );
    }

    new Setting(containerEl)
      .setName('Access token')
      .setDesc('Create one in Fokus, under Settings → Integrations → Obsidian.')
      // SecretComponent, not a text field: the value goes to the OS keychain and
      // only its id reaches `data.json`, so the token no longer sits in the
      // vault or travels with it through iCloud, Dropbox or git. There is no
      // `addSecret()` on Setting — `addComponent` is how it mounts.
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.data.secretId ?? '')
          .onChange((secretId) => {
            this.plugin.stageSecretId(secretId);
            this.save();
          }),
      );

    // The row has to say which state it is in. Reading "Connect" under a line
    // that already says "Connected" invites the user to press it again to find
    // out which one is lying.
    const connected = this.plugin.connected;
    new Setting(containerEl)
      .setName(connected ? 'Connection' : 'Connect')
      .setDesc(
        connected
          ? 'This vault is registered with Fokus. Reconnect after changing the token or the server.'
          : 'Registers this vault with Fokus and picks a workspace.',
      )
      .addButton((button) => {
        button.setButtonText(connected ? 'Reconnect' : 'Connect');
        // Only the primary action gets CTA styling; once connected it is a
        // rarely-needed repair, not the thing to do next.
        if (!connected) button.setCta();
        return button.onClick(async () => {
          button.setDisabled(true);
          try {
            const status = await this.plugin.connect();
            new Notice(`Connected to ${status.workspaceName}.`);
            this.display();
          } catch (error) {
            new Notice(`Could not connect: ${describe(error)}`);
          } finally {
            button.setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName('Folders to sync')
      .setDesc('One vault folder per line. Nothing syncs until you list at least one.')
      .addTextArea((area) =>
        area
          .setPlaceholder('Work\nAreas/Projects')
          .setValue(this.plugin.data.settings.folders.join('\n'))
          .onChange(async (value) => {
            // normalizePath so a pasted './Work', 'Work\\Sub' or a trailing
            // space does not silently match nothing.
            this.plugin.data.settings.folders = value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => normalizePath(line));
            this.save();
          }),
      );

    const status = containerEl.createDiv({ cls: 'fokus-sync-status' });
    const linked = Object.keys(this.plugin.data.entries).length;
    status.createEl('p', {
      text: connected ? `Connected. ${linked} note(s) linked.` : 'Not connected yet.',
    });
    // Connecting registers the vault; it does not sync anything. Without this
    // line the reasonable conclusion from "Connected. 0 note(s) linked." is that
    // something is broken, when in fact nothing has been asked for yet.
    if (connected && linked === 0) {
      status.createEl('p', {
        text: 'Nothing has synced yet. Edit a note in one of these folders, or run "Sync every note in the selected folders" from the command palette.',
      });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
