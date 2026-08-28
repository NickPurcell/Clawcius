/** Coalesces rapid Discord messages into a single wake. */

export type BufferedMessage = {
  messageId: string;
  authorId: string;
  authorTag: string;
  content: string;
  /** Whether this particular message @-mentioned the bot. */
  addressed: boolean;
  at: number;
};

export type BundleHandler = (channelId: string, messages: BufferedMessage[]) => void;

type Pending = {
  messages: BufferedMessage[];
  /** When the first message in this bundle arrived — anchors the max wait. */
  openedAt: number;
  timer: NodeJS.Timeout;
};

export class MessageBundler {
  #pending = new Map<string, Pending>();
  #debounceMs: number;
  #maxWaitMs: number;
  #onFlush: BundleHandler;

  constructor(debounceMs: number, maxWaitMs: number, onFlush: BundleHandler) {
    this.#debounceMs = debounceMs;
    this.#maxWaitMs = maxWaitMs;
    this.#onFlush = onFlush;
  }

  get enabled(): boolean {
    return this.#debounceMs > 0;
  }

  add(channelId: string, message: BufferedMessage): void {
    // Disabled: hand it over immediately, no buffering.
    if (!this.enabled) {
      this.#onFlush(channelId, [message]);
      return;
    }

    const existing = this.#pending.get(channelId);

    if (!existing) {
      const pending: Pending = {
        messages: [message],
        openedAt: message.at,
        timer: setTimeout(() => this.flush(channelId), this.#debounceMs),
      };
      pending.timer.unref();
      this.#pending.set(channelId, pending);
      return;
    }

    existing.messages.push(message);
    clearTimeout(existing.timer);

    const elapsed = Date.now() - existing.openedAt;
    const remaining = Math.max(0, this.#maxWaitMs - elapsed);
    const wait = Math.min(this.#debounceMs, remaining);

    existing.timer = setTimeout(() => this.flush(channelId), wait);
    existing.timer.unref();
  }

  /** Hand over whatever is buffered for a channel, if anything. */
  flush(channelId: string): void {
    const pending = this.#pending.get(channelId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.#pending.delete(channelId);
    this.#onFlush(channelId, pending.messages);
  }

  /** Pending message count, for `!status`. */
  pendingCount(channelId: string): number {
    return this.#pending.get(channelId)?.messages.length ?? 0;
  }

  /** Flush everything — used on shutdown so buffered messages are not lost. */
  flushAll(): void {
    for (const channelId of [...this.#pending.keys()]) this.flush(channelId);
  }
}
