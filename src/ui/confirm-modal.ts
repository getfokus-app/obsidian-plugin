import { App, Modal, Setting } from 'obsidian';

/**
 * A confirmation before anything large or one-way happens.
 *
 * A first full sync can create hundreds of notes in someone's account, so it is
 * never automatic and never a side effect of enabling the plugin.
 */
export class ConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private options: { title: string; body: string; confirmText: string },
    private onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.options.title);
    this.contentEl.createEl('p', { text: this.options.body });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(this.options.confirmText)
          .setCta()
          .onClick(() => {
            this.confirmed = true;
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.confirmed) this.onConfirm();
  }
}
