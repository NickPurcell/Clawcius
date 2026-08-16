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
      /**
       * Mail arrived for an agent that was not running a turn.
       *
       * The turn opens with the mail already read, rendered exactly as
       * `checkMail` renders it, because the alternative — telling the agent it
       * has mail and asking it to go and look — reads as an external prod and
       * makes an agent stop to ask what just happened to it rather than get on
       * with what arrived. See CLAWSKY.md § checkMail.
       */
      kind: 'mail';
      /** The agent id. Named for the session key it shares with the others. */
      channelId: string;
      /** `renderMail` output — the tool's own text, not a paraphrase of it. */
      mail: string;
      count: number;
    };

export type TurnSummary = {
  /**
   * Set when the turn ended because the API refused it — a revoked OAuth
   * token, an exhausted rate limit. Distinct from `isError`, which stays false
   * for these: the SDK considers the turn to have completed normally.
   */
  apiError?: string | null;
  /**
   * The SDK's machine-readable reason, e.g. `authentication_failed` or
   * `rate_limit`. `apiError` is the human sentence; this is what decides
   * whether the turn is worth retrying.
   */
  apiErrorKind?: string | null;
  /**
   * A retry is already queued for this turn, so the failure above is not the
   * final word. Kept out of `isError` on purpose: callers that only report
   * outcomes should say "retrying", not "failed".
   */
  retryScheduled?: boolean;
  /** 1-based attempt number when `retryScheduled`, else 0. */
  retryAttempt?: number;
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
