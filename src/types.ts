/** Shared shapes between the Discord layer, the scheduler, and the agent. */

/**
 * Why the agent is being woken.
 *
 * The distinction matters to the agent, not just to us: a mention has a message
 * to reply to, a scheduled wake does not. An agent that tries `discord reply`
 * with no message ID gets a validation error and then has to work out why.
 */
export type WakeContext =
  | {
      kind: 'messages';
      channelId: string;
      /**
       * One or more messages, coalesced by the bundler. Chronological.
       * The last one is the natural reply target.
       */
      messages: Array<{
        messageId: string;
        authorId: string;
        authorTag: string;
        content: string;
        at: number;
      }>;
    }
  | {
      kind: 'schedule';
      channelId: string;
      scheduleId: string;
      /** The instruction the agent left for its future self. */
      prompt: string;
      /** Present for repeating schedules. */
      repeats?: string;
    };

export type TurnSummary = {
  /**
   * Set when the turn ended because the API refused it — a revoked OAuth
   * token, an exhausted rate limit. Distinct from `isError`, which stays false
   * for these: the SDK considers the turn to have completed normally.
   */
  apiError?: string | null;
  isError: boolean;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  /** `success`, or a failure subtype such as `error_max_turns`. */
  subtype: string;
  /**
   * Whether the agent actually invoked the discord CLI during this turn.
   * A turn that ends without a send is indistinguishable from a broken bot
   * from the user's side, so the waker watches for it.
   */
  sentMessage: boolean;
};

export type Schedule = {
  id: string;
  channelId: string;
  prompt: string;
  nextRunAt: number;
  /** Repeat every N seconds, or null for one-shot / daily. */
  intervalSeconds: number | null;
  /** 'HH:MM' local time for daily repeats, or null. */
  dailyAt: string | null;
  createdAt: number;
  lastRunAt: number | null;
};
