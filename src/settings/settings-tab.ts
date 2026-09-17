import { App, Notice, PluginSettingTab, Setting, debounce, normalizePath } from 'obsidian';

import type FokusSyncPlugin from '@/main';

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

    new Setting(containerEl)
      .setName('Fokus server')
      .setDesc('Leave as-is unless you self-host.')
      .addText((text) =>
        text
          .setPlaceholder('https://api.getfokus.app')
          .setValue(this.plugin.data.settings.apiUrl)
          .onChange((value) => {
            this.plugin.data.settings.apiUrl = value.trim() || 'https://api.getfokus.app';
            this.save();
          }),
      );

    new Setting(containerEl)
      .setName('Access token')
      .setDesc('Create one in Fokus under Settings. It is stored in this vault in plain text.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('Paste your token')
          .setValue(this.plugin.token ?? '')
          .onChange((value) => {
            this.plugin.stageToken(value.trim());
            this.save();
          });
      });

    new Setting(containerEl)
      .setName('Connect')
      .setDesc('Registers this vault with Fokus and picks a workspace.')
      .addButton((button) =>
        button
          .setButtonText('Connect')
          .setCta()
          .onClick(async () => {
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
          }),
      );

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
    status.createEl('p', {
      text: this.plugin.connected
        ? `Connected. ${Object.keys(this.plugin.data.entries).length} note(s) linked.`
        : 'Not connected yet.',
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
