/** Shared shapes between the Discord layer, the scheduler, and the agent. */

/**
 * The opening of the `why` a superseded turn settles with.
 *
 * A CONSTANT BECAUSE TWO MODULES AGREE ON IT. `AgentSession` writes this reason
 * when a new wake replaces a turn still in flight; `MailWaker` matches it to
 * tell a supersede apart from a failure, because a supersede must not spend one
 * of a message's re-offers. Matching the prose inline in both places is a
 * coupling that breaks the moment somebody improves the wording — and it breaks
 * SILENTLY, into a false ceiling and a journal line blaming a refusal that never
 * happened. That is the defect this constant exists to make impossible, not a
 * hypothetical: it is #241 round 4.
 */
export const SUPERSEDED = 'a new wake arrived before the previous turn settled';

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

/** Why a refused turn has no retry coming. See `TurnSummary.noRetryReason`. */
export type NoRetryReason =
  | 'not-retryable'
  | 'exhausted'
  | 'abandoned'
  | 'credential-dead';

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
  /**
   * Why no retry was queued, when the API refused the turn and nothing is
   * coming. Null when the turn succeeded or when a retry IS queued.
   *
   * FOUR STATES, AND THEY WANT OPPOSITE THINGS FROM A HUMAN. Before this
   * existed the caller had one bit — `retryScheduled` — and said the same
   * sentence for all of them: "retries are exhausted or would not help, so this
   * needs a look at the host". That covers every case and therefore tells the
   * reader none of them, and for a 529 it is false twice: the fault is
   * Anthropic's, and waiting is exactly what helps.
   *
   *   not-retryable    a standing condition — `billing_error`,
   *                    `invalid_request`. A retry reproduces the same answer.
   *                    THIS is the one that genuinely needs a look at the host.
   *   exhausted        a TRANSIENT kind that used every rung of its ladder. The
   *                    fault is upstream and time is the fix.
   *   credential-dead  the AUTH ladder is spent. Distinct from `exhausted`,
   *                    which is a transient that ran out of time — this one is
   *                    the token being dead, and no amount of waiting fixes it.
   *                    `AUTH_RETRY_DELAYS_MS` has one rung precisely because
   *                    "if that fails the credential is genuinely dead and
   *                    hammering it is pointless".
   *   abandoned        rungs were left, but the session was closed or its
   *                    stored context cleared out from under the retry —
   *                    `!reset`, `!stop`, or `onError` dropping a session whose
   *                    child process died. NOT an outage, and not the user's
   *                    fault to diagnose: something on this side threw the
   *                    message away.
   *
   * Computed where the distinction is legible — beside the `willRetry`
   * expression that makes it — rather than re-derived by a caller from
   * `apiErrorKind`, which cannot see `#closed` or `#lastContext` at all.
   */
  noRetryReason?: NoRetryReason | null;
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
