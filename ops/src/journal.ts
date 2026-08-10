/**
 * The durable record of what this daemon was asked to do and what it did.
 *
 * Two sinks, because they answer different questions.
 *
 * **journal.jsonl**, append-only, fsynced. This is the one that has to survive
 * the machine going away mid-operation. The whole reason the executor exists
 * is that the agents can now restart things — including the waker, including
 * their own containers — and when something is broken the first question is
 * always "what did it do, and when". A record that lives only in the systemd
 * journal is a record that gets rotated, and a record buffered in a process
 * that just crashed is not a record. So every entry is written and flushed
 * before the operation it describes proceeds.
 *
 * **ops-status.json**, rewritten atomically, holding the current state and the
 * last N events. This is for the status page: `status/` reads files off local
 * disk and renders them, and giving it a file is the entire integration. No
 * socket, no API, no shared library — the page can grow a panel for this
 * whenever someone wants one, and until then the file is still the thing an
 * operator cats when the journal is too long.
 *
 * Everything written here may contain text the agent chose, which may in turn
 * contain text a stranger on the internet chose. It is JSON-encoded on the way
 * out, and anything that renders it owes it the same suspicion.
 */

import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type JournalKind =
  | 'boot'
  | 'shutdown'
  | 'request'
  | 'rejected'
  | 'queued'
  | 'started'
  | 'command'
  // One thing the host agent did — a Bash invocation, in full, in the
  // `command` field, or another tool call, or a refusal by the permission
  // system, or the auditor reporting on itself.
  //
  // Its own kind because it is the single most important thing in this file
  // since 2026-08-10. The verb allowlist is gone; this is what replaced it.
  // `grep '"kind":"audit"' journal.jsonl` is the answer to "what has this
  // machine actually been told to do", and it must stay one word.
  | 'audit'
  // A before/after health comparison across the configured units and
  // containers. Written when something regressed, which is the case worth
  // finding by grep.
  | 'health'
  // A build step ran, or deliberately did not. Kept although the executor no
  // longer builds anything itself: journal.jsonl is append-only and years of
  // it exist, so the kind has to stay readable by whatever reads it.
  | 'build'
  | 'finished'
  | 'failed'
  | 'idle-wait'
  | 'deadline-armed'
  | 'deadline-met'
  | 'deadline-missed'
  | 'breaker'
  | 'frozen'
  | 'verify';

export type JournalEntry = {
  at: number;
  atIso: string;
  kind: JournalKind;
  /** Short machine-ish summary, e.g. `redeploy hamachi`. */
  what: string;
  /** Prose. Always says *why*, because that is what you want at 3am. */
  detail: string;
  /** Present when the entry is about a specific instance — the TARGET. */
  instance?: string;
  /**
   * Who asked. The instance whose spool the request arrived in, or
   * `(executor)` for the daemon's own actions.
   *
   * Distinct from `instance`, and the distinction is the point. Before
   * 2026-08-10 there was one shared spool and this field could not have
   * existed: every entry named the target and nothing named the requester, so
   * "Hamachi asked to redeploy Hamachi" and "Hamachi asked to redeploy
   * Clawcius" produced byte-identical journal lines. The second is an agent
   * reaching across at its neighbour and it should never have been possible to
   * confuse the two after the fact.
   *
   * It is set from the spool directory, never from the request body, so it is
   * as trustworthy as the bind mount — which is the most trustworthy thing in
   * this pipeline.
   */
  requester?: string;
  /**
   * Present when the entry concerns a command.
   *
   * Two different things live in this field, and the `kind` says which:
   *
   *   - for most kinds, an argv array rendered by `render()` for humans, which
   *     is never parsed and never re-executed;
   *   - for `audit`, the FULL command string the host agent handed to its Bash
   *     tool, byte for byte, untouched.
   *
   * The second is deliberately not normalised, quoted or shortened. It is the
   * primary evidence of what a session with sudo did on this host, and evidence
   * that has been tidied up is not evidence.
   */
  command?: string;
  ok?: boolean;
  dryRun?: boolean;
};

/** Events kept in ops-status.json. The jsonl is the archive. */
const STATUS_EVENTS = 100;

/**
 * The last task, for the status page's benefit.
 *
 * A summary, not the task text: the full text is in the `request` journal entry
 * and every command is in the `audit` entries, both of which are in `events`.
 * This exists so a page can render "a task from hamachi ran 14 commands and
 * cost $0.31" without walking the event list.
 */
export type TaskSummary = {
  at: number;
  requester: string;
  /** The named instance, or `(all)` when the task named none. */
  instance: string;
  what: string;
  commands: number;
  turns: number;
  costUsd: number;
  ok: boolean;
  dryRun: boolean;
  sessionId: string;
};

export type OpsStatusSnapshot = {
  /** What the executor is doing right now, or 'idle'. */
  current: string;
  /** Requests waiting behind the lock. */
  queued: number;
  frozen: boolean;
  frozenReason: string;
  dryRun: boolean;
  /**
   * The spools being watched, one per instance, and whether each is
   * restricted. Published so the status page can show at a glance that every
   * agent has a reachable queue — the failure this replaced was one agent
   * silently having none.
   */
  spools: Array<{ instance: string; dir: string; restricted: boolean }>;
  /** Instances with an armed check-in deadline, and when it expires. */
  pendingCheckins: Array<{ instance: string; deadlineAt: number; reason: string }>;
  quarantined: Array<{ instance: string; build: string; at: number }>;
  consecutiveFailedRecoveries: number;
  lastVerify: { at: number; ok: boolean; detail: string } | null;
  /**
   * The host agent's configuration, as loaded. Published so the status page can
   * say out loud what this daemon is now capable of — the honest version of the
   * old "closed verb list" line, which the page could have rendered as
   * reassurance long after it stopped being true.
   */
  hostAgent: {
    enabled: boolean;
    claudePath: string;
    timeoutMinutes: number;
    maxCostUsd: number;
  };
  /** Bash invocations audited since this process started. */
  auditedCommands: number;
  lastTask: TaskSummary | null;
};

export class Journal {
  #dir: string;
  #jsonlPath: string;
  #statusPath: string;
  #recent: JournalEntry[] = [];
  #snapshot: () => OpsStatusSnapshot;

  constructor(stateDir: string, snapshot: () => OpsStatusSnapshot) {
    this.#dir = stateDir;
    this.#jsonlPath = join(stateDir, 'journal.jsonl');
    this.#statusPath = join(stateDir, 'ops-status.json');
    this.#snapshot = snapshot;
    mkdirSync(stateDir, { recursive: true, mode: 0o750 });
  }

  get path(): string {
    return this.#jsonlPath;
  }

  get statusPath(): string {
    return this.#statusPath;
  }

  /**
   * Record one event.
   *
   * Synchronous and fsynced, and yes that is a blocking write on every step of
   * every operation. It costs a millisecond a few times an hour, against a
   * daemon whose entire job is a handful of operations a day, and it buys the
   * property that the record of "I am about to recreate your container"
   * survives the container recreation going wrong in an interesting way.
   */
  write(entry: Omit<JournalEntry, 'at' | 'atIso'>): JournalEntry {
    const now = Date.now();
    const full: JournalEntry = { at: now, atIso: new Date(now).toISOString(), ...entry };

    const line = `${JSON.stringify(full)}\n`;
    try {
      const fd = openSync(this.#jsonlPath, 'a', 0o640);
      try {
        writeSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      // A journal that cannot be written must not stop the daemon — but it
      // must be loud, because from this moment the systemd journal is the only
      // record and nobody has been told.
      process.stderr.write(`[ops] JOURNAL WRITE FAILED (${String(error)}): ${line}`);
      try {
        appendFileSync(this.#jsonlPath, line);
      } catch {
        /* already reported */
      }
    }

    // The same line to stdout, so `journalctl -u clawcius-ops` is readable
    // without a JSON reader. Prefixed with the kind because the interesting
    // greps are `rejected` and `deadline-missed`.
    //
    // The requester goes in the prose line too, not only in the jsonl. The
    // journalctl output is what an operator actually reads during an incident,
    // and `redeploy hamachi` on its own does not say whether Hamachi asked for
    // its own rebuild or Clawcius asked for someone else's. `grep 'from
    // clawcius'` is now a question with an answer.
    const flag = full.dryRun ? ' [dry-run]' : '';
    const from = full.requester ? ` (from ${full.requester})` : '';
    process.stdout.write(`[ops] ${full.kind}${flag}: ${full.what}${from} — ${full.detail}\n`);

    this.#recent.push(full);
    if (this.#recent.length > STATUS_EVENTS) this.#recent.splice(0, this.#recent.length - STATUS_EVENTS);
    this.publishStatus();
    return full;
  }

  /**
   * Rewrite ops-status.json.
   *
   * Atomic, because the reader is another process on its own schedule and a
   * torn read of a status file is a status page confidently rendering half a
   * document.
   */
  publishStatus(): void {
    const payload = {
      service: 'clawcius-ops',
      generatedAt: Date.now(),
      generatedAtIso: new Date().toISOString(),
      state: this.#snapshot(),
      events: this.#recent,
    };

    const temp = join(dirname(this.#statusPath), `.ops-status.${process.pid}.tmp`);
    try {
      writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
      renameSync(temp, this.#statusPath);
    } catch (error) {
      process.stderr.write(`[ops] could not publish ops-status.json: ${String(error)}\n`);
    }
  }

  /** Directory holding both files, for the boot banner. */
  get dir(): string {
    return this.#dir;
  }
}
