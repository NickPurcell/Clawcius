/**
 * Coalesces rapid Discord messages into a single wake.
 *
 * People type the way they think — three short lines in five seconds rather
 * than one composed paragraph. Waking the agent once per line means it starts
 * answering the first thought before the second has landed.
 *
 * So each incoming message restarts a short debounce timer, and the buffer
 * flushes when the channel goes quiet. A hard ceiling from the first message in
 * the bundle stops a continuously-typing channel from deferring the agent
 * forever.
 *
 * This only governs when a bundle is *handed over*. Messages arriving while the
 * agent is mid-turn are not held back for it to finish — they queue into the
 * live session and reach it during the turn, the same way typing at Claude Code
 * while it works does.
 */

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

    // Never push the flush past the ceiling measured from the first message,
    // or a channel that keeps typing would defer the agent indefinitely.
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
