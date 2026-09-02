import { renderMail } from './mail-tool.js';
import { FEED, type MailStore } from './mail.js';
import type { AgentRecord, AgentRegistry } from './store.js';
import type { WakeContext } from './types.js';
import { SUPERSEDED } from './types.js';

/** The timer sweep that backs the delivery fast path. */
const SWEEP_INTERVAL_MS = 10_000;

const MAX_REOFFERS = 3;

const REOFFER_WINDOW_MS = 60_000;

export type MailWakerOptions = {
  crew: string;
  registry: AgentRegistry;
  mail: MailStore;
  /** True while a turn is in flight for this agent. */
  busy: (agentId: string) => boolean;
  start: (
    agent: AgentRecord,
    context: WakeContext,
    settle: (ran: boolean, why: string) => void,
  ) => void;
  log: (line: string) => void;
};

export class MailWaker {
  readonly #options: MailWakerOptions;
  #sweeper: NodeJS.Timeout | null = null;
  /** Re-entrancy guard, and it is not optional. */
  #sweeping = false;

  constructor(options: MailWakerOptions) {
    this.#options = options;
  }

  start(): void {
    this.#sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.#sweeper.unref();
    // Mail that arrived while this process was down is still mail.
    this.sweep();
    this.#options.log(`waking idle agents of crew ${this.#options.crew} on mail`);
  }

  stop(): void {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
  }

  /** What to do when a message is delivered. */
  onDelivered(recipient: string): void {
    this.#options.log(
      recipient === FEED ? 'a feed post arrived' : `mail arrived for ${recipient}`,
    );
    this.sweep();
  }

  /** How many turns one message gets before the sweep stops offering it. */
  #offers = new Map<string, Map<number, number>>();

  #offersFor(agentId: string): Map<number, number> {
    const existing = this.#offers.get(agentId);
    if (existing) return existing;
    const fresh = new Map<number, number>();
    this.#offers.set(agentId, fresh);
    return fresh;
  }

  /** Agents already told their mail hit the ceiling — so the line prints once. */
  #capped = new Set<string>();

  /** When the current re-offer window opened, per agent. See `REOFFER_WINDOW_MS`. */
  #windowStartedAt = new Map<string, number>();

  /** Give a turn to every agent of this crew that has mail and is not running one. */
  sweep(): void {
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      for (const agent of this.#options.registry.listByCrew(this.#options.crew)) {
        if (agent.status === 'live') this.#consider(agent);
      }
    } finally {
      this.#sweeping = false;
    }
  }

  #consider(agent: AgentRecord): void {
    const { mail, busy, start, log } = this.#options;


    if (busy(agent.id)) return;

    const pending = mail.unread(agent.id);
    if (pending.length === 0) return;

    // ── A CEILING ON RE-OFFERS ───────────────────────────────────────────────
    const now = Date.now();
    // The window is per agent: the messages are offered as one batch, so they
    // are capped and released as one.
    if (this.#windowStartedAt.has(agent.id) && now - (this.#windowStartedAt.get(agent.id) ?? 0) > REOFFER_WINDOW_MS) {
      this.#windowStartedAt.delete(agent.id);
      this.#capped.delete(agent.id);
      this.#offers.delete(agent.id);
    }
    const offers = this.#offersFor(agent.id);
    const stillPending = new Set(pending.map((message) => message.id));
    for (const id of offers.keys()) if (!stillPending.has(id)) offers.delete(id);

    const overdue = pending.filter((message) => (offers.get(message.id) ?? 0) >= MAX_REOFFERS);
    if (overdue.length === pending.length) {
      if (!this.#capped.has(agent.id)) {
        this.#capped.add(agent.id);
        log(
          `${agent.id}: ${pending.length} message(s) have each been offered ${MAX_REOFFERS} times ` +
            `without a turn that settled — pausing for ${REOFFER_WINDOW_MS / 1000}s. They stay ` +
            'UNREAD. The sweep tries again after the pause, and a NEW message to this agent ' +
            'releases the batch immediately; a discord or scheduled wake does not deliver them, ' +
            'it only gives the agent a chance to call checkMail. Whatever ended those turns is ' +
            'in the journal above this line.',
        );
      }
      return;
    }
    this.#capped.delete(agent.id);

    const context: WakeContext = {
      kind: 'mail',
      channelId: agent.id,
      mail: renderMail(pending),
      count: pending.length,
    };

    const ids = pending.map((message) => message.id);

    if (!this.#windowStartedAt.has(agent.id)) this.#windowStartedAt.set(agent.id, now);
    for (const id of pending.map((message) => message.id)) {
      offers.set(id, (offers.get(id) ?? 0) + 1);
    }

    let settled = false;
    const settle = (ran: boolean, why: string): void => {
      // Once. `onDone` and `onError` can both fire for one turn, and marking
      // read on the first while logging a loss on the second would be worse
      // than either.
      if (settled) return;
      settled = true;
      if (!ran && why.startsWith(SUPERSEDED)) {
        for (const id of ids) {
          const spent = offers.get(id);
          if (spent !== undefined) offers.set(id, Math.max(0, spent - 1));
        }
      }

      if (ran) {
        for (const id of ids) offers.delete(id);
        mail.markRead(agent.id, ids);
        return;
      }
      log(
        `${agent.id}: turn died before it ran (${why}) — ${ids.length} message(s) left ` +
          'unread for the next sweep',
      );
    };

    try {
      start(agent, context, settle);
    } catch (error) {
      // Capacity, a dead child transport, a workspace that cannot be created.
      // Nothing is marked read, so this is a retry rather than a loss.
      log(`could not wake ${agent.id} for ${pending.length} message(s): ${String(error)}`);
      return;
    }

    if (settled) return;
    log(`woke ${agent.id} with ${pending.length} message(s)`);
  }
}
