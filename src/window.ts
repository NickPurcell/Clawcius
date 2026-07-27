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
 *
 * Windows can be confined to named channels. That matters because "bot
 * activity" includes automations, which share the bot account: a video uploader
 * posting to a busy channel would otherwise open a window there and have every
 * subsequent message wake the agent, uncapped. Confining conversation to the
 * channels meant for it lets automation run anywhere without that consequence.
 */

export class ConversationWindows {
  #expiry = new Map<string, number>();
  #durationMs: number;
  #allowed: ReadonlySet<string> | null;

  /**
   * @param durationSeconds Window length. 0 disables follow-ups entirely.
   * @param allowedChannelIds Channels that may open a window. Empty or omitted
   *   means every channel, which is the historical behaviour.
   */
  constructor(durationSeconds: number, allowedChannelIds: readonly string[] = []) {
    this.#durationMs = durationSeconds * 1000;
    this.#allowed = allowedChannelIds.length > 0 ? new Set(allowedChannelIds) : null;
  }

  get enabled(): boolean {
    return this.#durationMs > 0;
  }

  /** May a window open on this channel at all? */
  allows(channelId: string): boolean {
    return this.#allowed === null || this.#allowed.has(channelId);
  }

  /**
   * Open or extend the window on a channel. No-op when disabled, and no-op on
   * channels outside the allowlist.
   *
   * The check lives here rather than at the call sites deliberately: there are
   * several places that extend a window, and a future one added by someone
   * unaware of this rule should be safe by default rather than a quiet leak.
   */
  extend(channelId: string): void {
    if (!this.enabled) return;
    if (!this.allows(channelId)) return;
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
