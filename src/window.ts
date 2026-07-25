/**
 * Follow-up conversation windows.
 *
 * Being @-mentioned for every single message is unnatural in a chat. After the
 * bot is addressed, a window opens on that channel during which ordinary
 * messages also reach the agent, so a conversation reads like a conversation.
 *
 * The window is extended by *bot activity* — a fresh mention, or the bot
 * posting or editing a message — and deliberately not by human messages alone.
 * That keeps the window anchored to an exchange the bot is actually part of: if
 * two people carry on talking to each other after the bot has finished, the
 * window closes on schedule instead of being held open by their conversation.
 *
 * State is in memory rather than SQLite. A window is a few minutes of chat
 * context; if the bot restarts, the right behaviour is for it to stop listening
 * to messages that were never addressed to it.
 */

export class ConversationWindows {
  #expiry = new Map<string, number>();
  #durationMs: number;

  constructor(durationSeconds: number) {
    this.#durationMs = durationSeconds * 1000;
  }

  get enabled(): boolean {
    return this.#durationMs > 0;
  }

  /** Open or extend the window on a channel. No-op when disabled. */
  extend(channelId: string): void {
    if (!this.enabled) return;
    this.#expiry.set(channelId, Date.now() + this.#durationMs);
  }

  isOpen(channelId: string): boolean {
    if (!this.enabled) return false;
    const expiresAt = this.#expiry.get(channelId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.#expiry.delete(channelId);
      return false;
    }
    return true;
  }

  /** Seconds left, for `!status`. Zero when closed. */
  remainingSeconds(channelId: string): number {
    const expiresAt = this.#expiry.get(channelId);
    if (expiresAt === undefined) return 0;
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  }

  close(channelId: string): void {
    this.#expiry.delete(channelId);
  }

  /** Drop expired entries so the map does not grow with dead channels. */
  sweep(): void {
    const now = Date.now();
    for (const [channelId, expiresAt] of this.#expiry) {
      if (expiresAt <= now) this.#expiry.delete(channelId);
    }
  }
}
