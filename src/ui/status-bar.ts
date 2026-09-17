/** The one-line summary of what sync is doing, shown in Obsidian's status bar. */
export class SyncStatusBar {
  constructor(private el: HTMLElement) {
    this.idle();
  }

  idle(): void {
    this.el.setText('Fokus: idle');
  }

  syncing(count: number): void {
    this.el.setText(`Fokus: syncing ${count}…`);
  }

  synced(at: Date): void {
    this.el.setText(
      `Fokus: synced ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    );
  }

  offline(): void {
    this.el.setText('Fokus: offline');
  }

  error(message: string): void {
    this.el.setText(`Fokus: ${message}`);
  }
}
