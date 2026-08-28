/** Shared shapes between the Discord layer, the scheduler, and the agent. */

export const SUPERSEDED = 'a new wake arrived before the previous turn settled';

/** Why the agent is being woken. */
export type WakeContext =
  | {
      kind: 'messages';
      channelId: string;
      /** One or more messages, coalesced by the bundler. */
      messages: Array<{
        messageId: string;
        authorId: string;
        authorTag: string;
        content: string;
        at: number;
      }>;
    }
  | {
      /** Mail arrived for an agent that was not running a turn. */
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
  /** Set when the turn ended because the API refused it — a revoked OAuth token, an exhausted rate limit. */
  apiError?: string | null;
  /** The SDK's machine-readable reason, e.g. `authentication_failed` or `rate_limit`; decides whether the turn is retried. */
  apiErrorKind?: string | null;
  /** A retry is already queued for this turn, so the failure above is not the final word. */
  retryScheduled?: boolean;
  /** 1-based attempt number when `retryScheduled`, else 0. */
  retryAttempt?: number;
  /** Why no retry was queued when the API refused the turn. Null when the turn succeeded or a retry is queued. */
  noRetryReason?: NoRetryReason | null;
  isError: boolean;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  /** `success`, or a failure subtype such as `error_max_turns`. */
  subtype: string;
};

