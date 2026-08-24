/**
 * Mail wakes an idle agent — CLAWSKY.md phase 3.
 *
 * Phases 1 and 2 gave every agent an inbox and a `checkMail` tool, and left the
 * inbox useful only to an agent that happened to run for some other reason. A
 * DM to an engineer that was not currently being mentioned on Discord went into
 * the table and stayed there. This is the part that makes the board a way to
 * reach somebody.
 *
 * ── What the turn looks like from the agent's seat ──────────────────────────
 *
 * The turn opens with the mail ALREADY READ, rendered by `renderMail` — the
 * same text `checkMail` returns — as though the agent had happened to poll at
 * exactly the right moment. It does not open with "you have mail, go and look".
 * The difference is the difference between an agent that carries on with what
 * arrived and one that stops to ask what just happened to it.
 *
 * Being honest about the mechanism: the SDK's streaming input accepts user
 * messages only, so this is not literally an assistant `tool_use` block with a
 * `tool_result` after it. It is the tool's output arriving as a synthetic user
 * message (`isSynthetic`, see PromptQueue.push) wrapped in `prompts.mailWake`,
 * which is two words long for exactly that reason. The property is bought by
 * the framing, not by the transcript's structure.
 *
 * ── Three rules, all of them deliberate ─────────────────────────────────────
 *
 * NOTHING INTERRUPTS A RUNNING TURN. `busy` is checked before anything else,
 * and mail that arrives mid-turn is left unread. It is picked up on the next
 * turn — and the sweep below is what guarantees there IS a next turn, rather
 * than the message sitting in the table until somebody says something on
 * Discord.
 *
 * NO LOOP BREAKER, NO THROTTLE, NO COALESCING WINDOW. Sending is a `sendMail`
 * call and a tool call happens inside a turn, so an agent that never finishes a
 * turn never sends anything: the rate is turn-paced by construction. Two
 * agents can argue for a long time and cannot argue fast. The ceiling is the
 * account's own rate limit and the operator would rather watch a runaway than
 * pre-empt one. The sweep here is not a throttle in disguise: it never delays,
 * drops or merges anything, it only re-tries what the fast path could not do at
 * the moment it fired.
 *
 * A DEAD AGENT IS NOT RESURRECTED BY MAIL. CLAWSKY.md settles this for a
 * scheduled wake — a reminder that fires into silence is the worst way for a
 * reminder to fail — and says nothing about mail. Resurrecting on mail would
 * mean `kill` does not kill: any crewmate could bring an agent back by writing
 * to it, and the coordinator that killed it would not be told. The mail keeps.
 * Whoever resurrects the agent hands it that mail as its first turn.
 *
 * THE HOST AGENT'S MAILBOX IS NOT SWEPT HERE. Its row lives on this crew's
 * board, but it runs on the host outside every container, and the process that
 * runs it is the ops executor (ops/src/host-mailbox.ts). A waker that tried to
 * wake it would spawn a `claude` inside the sandbox under the host agent's
 * name, which is the one thing the containment story does not survive.
 */

import { renderMail } from './mail-tool.js';
import { FEED, type MailStore } from './mail.js';
import type { AgentRecord, AgentRegistry } from './store.js';
import type { WakeContext } from './types.js';
import { SUPERSEDED } from './types.js';

/**
 * The guarantee behind the fast path.
 *
 * `onDelivered` fires the moment a message lands, which covers the ordinary
 * case. It cannot cover: mail delivered while the recipient was mid-turn, mail
 * delivered while the session cap was full, mail that arrived while this
 * process was down, or a second message sent from the same turn as the one that
 * started the recipient's. Every one of those is a message that would otherwise
 * wait for an unrelated event. Same shape as every spool in this repository:
 * the event is the fast path, the timer is the promise.
 */
const SWEEP_INTERVAL_MS = 10_000;

/**
 * How many turns one message gets before the sweep stops offering it.
 *
 * Three, because the failures this is bounding do not clear in one attempt and
 * do not clear in twenty either: a dead credential, a refusing API, a container
 * that will not start. Two would risk giving up on a genuine one-off; the point
 * is only that the number is FINITE, since the sweep now fires on the busy flip
 * and so re-offers with no delay at all. OJ #241 round 3 measured 26.
 */
const MAX_REOFFERS = 3;

/**
 * How long a spent ceiling holds before the message is offered again.
 *
 * The attempt count alone had no time in it, and each failure re-sweeps
 * SYNCHRONOUSLY through `release()`, so three offers could be spent in
 * milliseconds. The flagship incident this whole change is about — the sentry
 * OOM-killed and back seconds later — therefore ended with the mail parked
 * indefinitely, which is the phase-2 behaviour the feature exists to replace.
 *
 * So the ceiling is three attempts PER WINDOW rather than three ever: it bounds
 * the hot loop to a handful of turns a minute, and a blip recovers on its own.
 * #241 round 4.
 */
const REOFFER_WINDOW_MS = 60_000;

export type MailWakerOptions = {
  crew: string;
  registry: AgentRegistry;
  mail: MailStore;
  /** True while a turn is in flight for this agent. */
  busy: (agentId: string) => boolean;
  /**
   * Start a turn. May throw — the session cap is real — and a throw is not
   * fatal here: nothing has been marked read, so the next sweep tries again.
   *
   * `settle` is how the mail gets marked read, and it is the whole of #239.
   * Call it with `true` once the turn has actually run, `false` if the turn died
   * without producing. Never calling it leaves the mail unread, which is the
   * safe direction: the next sweep re-offers it.
   */
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
  /**
   * Re-entrancy guard, and it is not optional.
   *
   * `start` sets the session busy synchronously, which fires the busy-count
   * change that this class is subscribed to, which calls `sweep` again from
   * inside its own loop. The guard makes that a no-op instead of a recursion
   * whose depth is the size of the crew.
   */
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

  /**
   * What to do when a message is delivered.
   *
   * A full sweep rather than a lookup of the recipient, because a feed post has
   * every agent as its recipient and there is no reason for those two cases to
   * take different code. The argument is only used for the log line.
   */
  onDelivered(recipient: string): void {
    this.#options.log(
      recipient === FEED ? 'a feed post arrived' : `mail arrived for ${recipient}`,
    );
    this.sweep();
  }

  /**
   * How many turns one message gets before the sweep stops offering it. See the
   * ceiling in `#consider`; the counter is dropped the moment a turn settles it.
   */
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
        this.#consider(agent);
      }
    } finally {
      this.#sweeping = false;
    }
  }

  #consider(agent: AgentRecord): void {
    const { mail, busy, start, log } = this.#options;

    // Runs on the host, woken by the ops executor. See the header.
    if (agent.role === 'host') return;

    if (busy(agent.id)) return;

    const pending = mail.unread(agent.id);
    if (pending.length === 0) return;

    // ── A CEILING ON RE-OFFERS, BECAUSE THE SWEEP IS NO LONGER ON A TIMER ────
    //
    // Deferring the mark means an unsettled turn leaves its mail unread and the
    // next sweep re-offers it. That is the intended trade — a duplicate is
    // visible, a loss is silent — but the sweep now also fires SYNCHRONOUSLY on
    // the busy flip at the end of a turn, not only on the ten-second timer. So
    // against an API that is refusing every call, "re-offer" has no delay in it:
    // OJ measured 26 turns for one message, and it stops only when the API
    // recovers.
    //
    // That is not the duplicate-vs-loss trade. A duplicate is one extra turn;
    // this is a hot loop against a failing API for as long as the condition
    // stands, and this branch introduced it — before it, the mail was consumed
    // and the loop was one turn long.
    //
    // So a message gets MAX_REOFFERS turns and then stops being offered, and the
    // line says so rather than the mail simply going quiet. It stays UNREAD, so
    // nothing is lost and `checkMail` still returns it the moment anything else
    // wakes the agent — which is the difference between a ceiling and a drop.
    const now = Date.now();
    // The window is per agent: the messages are offered as one batch, so they
    // are capped and released as one.
    if (this.#windowStartedAt.has(agent.id) && now - (this.#windowStartedAt.get(agent.id) ?? 0) > REOFFER_WINDOW_MS) {
      this.#windowStartedAt.delete(agent.id);
      this.#capped.delete(agent.id);
      this.#offers.delete(agent.id);
    }
    // Mail read by some OTHER turn — an agent calling `checkMail` itself —
    // never reaches `settle(true)`, so its counters were never dropped and the
    // map grew with message volume for the life of the process. `pending` is
    // the whole truth about what is unread for this agent, so anything counted
    // and no longer in it is finished with. That is also why the counters are
    // keyed by agent: it makes this sweepable without asking the store which
    // recipient a message id belonged to.
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
            'UNREAD, any other wake still delivers them, and the sweep tries again after the ' +
            'pause. Whatever ended those turns is in the journal above this line.',
        );
      }
      return;
    }
    this.#capped.delete(agent.id);

    if (agent.status !== 'live') {
      log(
        `${agent.id} is dead and has ${pending.length} unread message(s) — not waking it. ` +
          'Mail does not resurrect: a killed agent that any crewmate could bring back by ' +
          'writing to it was never killed. Resurrect it and this is its first turn.',
      );
      return;
    }

    const context: WakeContext = {
      kind: 'mail',
      channelId: agent.id,
      mail: renderMail(pending),
      count: pending.length,
    };

    const ids = pending.map((message) => message.id);

    // MARKED READ WHEN THE TURN HAS RUN, NOT WHEN IT WAS HANDED OVER. This is
    // Clawcius #239, and the old ordering lost five messages in one second on
    // 2026-08-24.
    //
    // `start` only hands the turn to a session and returns. The `catch` below is
    // therefore SYNCHRONOUS-ONLY, and every way a turn actually dies is
    // asynchronous and lands after it: an API refusal with no retry, a stale
    // token, and — the one that bit — a dead transport reported through
    // `onError`. Marking read at handoff meant all three were permanent silent
    // loss, because `checkMail` reads UNREAD rows and the row was no longer one.
    //
    // The guard that was there is not wrong; it guards the narrower half of one
    // failure mode. It is kept, and `settle` covers the rest.
    //
    // WHICH WAY THIS ERRS, STATED RATHER THAN INCIDENTAL: toward DUPLICATE
    // DELIVERY. If a turn dies after the model has seen the mail but before it
    // settles, the next sweep offers the same messages again. A duplicate is
    // visible and annoying; a loss is silent and cost this crew an hour, seven
    // times in four days without anyone noticing. So the trade is deliberate.
    //
    // Nothing re-delivers WHILE a turn is running: `busy` is set synchronously
    // by `start` and is checked at the top of this method, so the window between
    // handoff and settle is not a window in which the same mail is offered
    // twice.
    // The window opens on the FIRST offer of a batch, not on the sweep that
    // happened to look — so the pause is measured from when the trouble started.
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
      // A SUPERSEDE IS NOT A FAILED OFFER, so it does not spend one. Three
      // Discord messages interleaved with a pending mail turn — ordinary
      // traffic in a coordinator's channel — otherwise parked the mail and
      // printed "something is failing every turn: check the journal for the
      // refusal" with three supersede lines above it and no refusal anywhere.
      // A false sentence and a false ceiling from the same miscount. #241 r4.
      if (!ran && why.startsWith(SUPERSEDED)) {
        for (const id of ids) {
          const spent = offers.get(id);
          if (spent !== undefined) offers.set(id, Math.max(0, spent - 1));
        }
      }

      if (ran) {
        // MEMORY, NOT BEHAVIOUR, and there is deliberately no test for it. The
        // map is keyed by message id, so a stale entry cannot affect a NEW
        // message — it can only accumulate. I wrote a test asserting "a settled
        // agent never hits the ceiling", then mutated this line away and the
        // test still passed: it could not fail, which makes it worse than
        // nothing. Deleted, and the reason recorded here instead.
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

    // `settle` CAN HAVE RUN ALREADY, from inside the call above. `AgentSession`'s
    // `#push` has a synchronous catch — "the child transport can be dead — a
    // failed spawn, or a process that exited" — which routes straight to
    // `onError`, so the daemon settles before `start` returns.
    //
    // Without this the log reads backwards and claims something untrue: "turn
    // died before it ran … left unread", immediately followed by "woke X with 5
    // message(s)". No turn was woken. Announcing a wake that did not happen, in
    // the path built to stop things failing silently, would be the same defect
    // one line lower.
    if (settled) return;
    log(`woke ${agent.id} with ${pending.length} message(s)`);
  }
}
