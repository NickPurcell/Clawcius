/** Follow-up conversation windows. */

export class ConversationWindows {
  #expiry = new Map<string, number>();
  #durationMs: number;
  #allowed: ReadonlySet<string> | null;

  /** @param durationSeconds Window length. */
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

  /** Open or extend the window on a channel. */
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
