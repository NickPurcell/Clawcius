/**
 * The host agent's mailbox — CLAWSKY.md phase 6.
 *
 * What this replaces is not the ops user, the sudoers file or the privilege
 * drop. Those are untouched and remain the whole containment story. What it
 * replaces is the SCHEDULING: file a request into a spool, wait for every
 * container in scope to fall idle, take a snapshot, run, arm a rollback
 * deadline, and answer by writing a wake file that the requester reads whenever
 * it next runs. That apparatus is what made asking the host to do something a
 * thing you did and then went away from.
 *
 * A DM to `<crew>-host` runs it, now, and the answer comes back as a DM.
 *
 * ── Who may ask ─────────────────────────────────────────────────────────────
 *
 * Only a coordinator. With the queue gone this is the only remaining access
 * control on running commands on the VPS, so it is checked twice, in two
 * processes, against two different things:
 *
 *   - `src/mail.ts` refuses the DM at delivery, in the container's waker, by
 *     the sender's registry role. That is what an engineer runs into.
 *   - this file re-reads the AUTHOR COLUMN of the committed row and looks its
 *     role up again, here, immediately before running anything. That is what
 *     holds if anything ever writes to the mail table other than `deliver` —
 *     and something already can: this file writes to it, as root.
 *
 * The author column is written by the waker from the agent id that session's
 * own `sendMail` tool closes over — a variable in the waker's process, which no
 * argument reaches. It is never read from a body, and nothing here adds a way
 * for a message to say who filed it: the `requester` handed to `runHostAgent`
 * is that column and only that column.
 *
 * ── What the trust boundary actually is ─────────────────────────────────────
 *
 * A crew's coordinator can now run commands on the host by calling one tool.
 * That was true before — the ops spool was reachable from the same container,
 * with the same authorship guarantee —
 * and the checks that stood between the request and the machine were never the
 * queue: they are the unprivileged `clawcius-ops` account, its narrow sudoers
 * file, the setuid/setgid drop, the tool deny-list, and an audit written to
 * `journal.jsonl` before each command's result is known. Every one of those is
 * still in the path, unchanged, in `ops/src/host-agent.ts`.
 *
 * What is genuinely gone is the ability to undo. The old path snapshotted every
 * container in scope first and rolled back on failure; this one does not,
 * because a snapshot is part of the apparatus the operator asked to remove. The
 * health sample either side is what is left, and it reports rather than
 * repairs. Say so in the reply, so the coordinator knows what it is asking for.
 *
 * And the coordinator check is a rule between crews and against a mistake, NOT
 * a boundary within a crew. Every agent in a crew shares one container, one uid
 * and one disk today (Clawcius #31). Mail itself no longer gives that shared
 * disk a way in — sending is a tool closed over the sending session's id, the
 * per-agent drop directories that could be written across are gone (#35), and
 * the board is outside every bind mount. The wake spool still does: `run/wake`
 * takes any channel id, so any process in the container can start a turn as its
 * coordinator with a prompt of its choosing, and that turn holds the
 * coordinator's `sendMail` (#39). Retiring the spool is CLAWSKY.md phase 4;
 * per-agent uids are the other half. Until both, this check is worth exactly
 * what the container's own boundary is worth and no more.
 *
 * ── Reading the board ───────────────────────────────────────────────────────
 *
 * `fs.watch` on the directory holding the database is the fast path — SQLite
 * touches `-wal` on every commit — and a poll is the guarantee, the same
 * arrangement as every spool in this repository. There is no notification
 * across the process boundary and there is no socket: the container may not
 * have one, and the waker must not be able to call into a root daemon.
 */

import { watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { Board, BoardError, type BoardMessage } from './board.js';

/** What the executor does with one message. Never rejects; see `#drain`. */
export type MailTaskRunner = (task: {
  /** The crew whose board this is. */
  crew: string;
  /** The agent id from the row's author column. Never from a body. */
  requester: string;
  subject: string;
  task: string;
}) => Promise<{ subject: string; body: string }>;

export class HostMailbox {
  readonly #board: Board;
  readonly #dbDir: string;
  readonly #instance: string;
  readonly #run: MailTaskRunner;
  readonly #pollMs: number;
  readonly #log: (line: string) => void;
  #watcher: FSWatcher | null = null;
  #poller: NodeJS.Timeout | null = null;
  #draining = false;
  #stopped = false;

  /** @throws BoardError from `Board` — the caller reports and carries on. */
  constructor(options: {
    dbPath: string;
    crew: string;
    instance: string;
    workDir: string;
    pollSeconds: number;
    run: MailTaskRunner;
    log: (line: string) => void;
  }) {
    this.#instance = options.instance;
    this.#run = options.run;
    this.#pollMs = options.pollSeconds * 1000;
    this.#log = options.log;
    this.#board = new Board({ dbPath: options.dbPath, crew: options.crew, log: options.log });
    if (!this.#board.register(options.workDir)) {
      this.#board.close();
      throw new BoardError(`${this.#board.hostId} could not take its own row on the board`);
    }
    this.#dbDir = dirname(options.dbPath);
  }

  get hostId(): string {
    return this.#board.hostId;
  }

  start(): void {
    try {
      // The directory, not the file: SQLite in WAL mode commits by writing the
      // sidecar, and a watch on the database itself would see very little.
      this.#watcher = watch(this.#dbDir, () => void this.drain());
    } catch (error) {
      this.#log(`cannot watch ${this.#dbDir}: ${String(error)} — polling only`);
    }
    this.#poller = setInterval(() => void this.drain(), this.#pollMs);
    this.#poller.unref();
    // Anything filed while this daemon was down is still a request.
    void this.drain();
    this.#log(`${this.#board.hostId} is on the board for ${this.#instance} (${this.#dbDir})`);
  }

  stop(): void {
    this.#stopped = true;
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#poller) clearInterval(this.#poller);
    this.#poller = null;
    this.#board.close();
  }

  /**
   * Run everything waiting, one at a time.
   *
   * Serial rather than concurrent: each of these is a Claude Code session with
   * a shell on this host, and two of them at once would be two sessions racing
   * over the same systemd units. The guard is re-entrancy, not rate — an agent
   * that files four messages gets four sessions, in order, as fast as they can
   * be run.
   */
  async drain(): Promise<void> {
    if (this.#draining || this.#stopped) return;
    this.#draining = true;
    try {
      for (const message of this.#board.unread()) {
        if (this.#stopped) return;
        // Before it is acted on, never after. A task that takes the daemon down
        // with it must not be re-read and re-run on the next boot.
        this.#board.markRead(message.id);
        await this.#handle(message);
      }
    } catch (error) {
      // The board is a file another process is writing. A read that fails is
      // logged and retried on the next poll; it must never take down the
      // daemon that holds the rollback deadlines.
      this.#log(`could not drain the mailbox: ${String(error)}`);
    } finally {
      this.#draining = false;
    }
  }

  async #handle(message: BoardMessage): Promise<void> {
    const role = this.#board.roleOf(message.author);

    // ── The only access control left on running commands on the VPS ────────
    if (role !== 'coordinator') {
      this.#log(
        `REFUSED a task from ${message.author} (role ${role || 'unregistered'}): only a ` +
          'coordinator may DM the host agent. Nothing was run.',
      );
      this.#reply(
        message.author,
        `Refused: ${message.subject || '(no subject)'}`,
        [
          'Refused. Only a coordinator may ask the host agent to do anything, and this board',
          `has ${message.author} as ${role ? `a ${role}` : 'no registered agent at all'}.`,
          '',
          'This is not a prompt-level rule. With the ops queue gone it is the only access',
          'control on running commands on the VPS, and it is checked twice: once where the',
          'DM is delivered, and once here against the row itself. Nothing was run.',
        ].join('\n'),
      );
      return;
    }

    if (!message.body.trim()) {
      this.#reply(message.author, `Refused: ${message.subject || '(no subject)'}`, 'Empty task.');
      return;
    }

    this.#log(`running a task for ${message.author}: ${message.subject || '(no subject)'}`);

    let answer: { subject: string; body: string };
    try {
      answer = await this.#run({
        crew: this.#board.crew,
        requester: message.author,
        subject: message.subject,
        task: message.body,
      });
    } catch (error) {
      // The runner is supposed to turn every failure into an answer. Reaching
      // here is a bug, and the requester still has to hear something — silence
      // is the failure mode this whole change exists to remove.
      answer = {
        subject: `Failed: ${message.subject || '(no subject)'}`,
        body: `The executor threw before it could report: ${String(error)}`,
      };
    }
    this.#reply(message.author, answer.subject, answer.body);
  }

  #reply(to: string, subject: string, body: string): void {
    try {
      this.#board.send(to, subject, body);
    } catch (error) {
      // Nothing else can carry it. The journal is the record.
      this.#log(`could not answer ${to}: ${String(error)}`);
    }
  }
}
