/**
 * How an agent sends mail: it writes a file into its own drop directory.
 *
 *     /var/lib/clawcius/run/clawsky/<agent-id>/<anything>.json
 *     { "to": "hamachi-engineer1", "subject": "...", "body": "..." }
 *     { "to": "*",                 "subject": "...", "body": "..." }
 *
 * THE AUTHOR IS NEVER READ FROM THE MESSAGE. It is stamped from the directory
 * the file arrived in. An agent can write anything it likes into a body; it
 * cannot write itself a different name, because the name is not in the body.
 * That is the only defence that survives an agent being prompt-injected by
 * something it read, and it is the same property the ops spool has, for the
 * same reason. Nothing in this file may ever grow a fallback that takes an
 * author from the JSON.
 *
 * What the directory proves, precisely. The drop root lives under the state
 * directory's `run/`, which `docker/run-container.sh` bind-mounts into exactly
 * one container — so a name under it is reachable from that crew's container
 * and from no other, and a crew cannot forge a message from another crew. It
 * does NOT separate agents *within* a crew: they share one container, one uid
 * and one disk, so an engineer that goes looking can write into its
 * coordinator's drop directory. That is the existing trust boundary rather
 * than a new hole — anything sharing a container already shares everything —
 * but it is worth being honest that the guarantee is per crew.
 *
 * A directory rather than a socket because gVisor blocks connections to host
 * unix sockets, correctly, since a host UDS is a hole straight through the
 * sandbox boundary. A bind-mounted directory needs no such exception, and
 * writing a file is simpler for the agent than making a request.
 *
 * The gVisor lessons from the wake spool are kept: fs.watch is the fast path,
 * the periodic sweep is the guarantee (the gofer does not reliably deliver
 * inotify events for writes made inside the sandbox), oversized files are
 * discarded rather than read, and every file is unlinked *before* it is acted
 * on so a message that throws is not retried forever on every sweep.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { join } from 'node:path';
import { FEED, type DeliveryResult, type MailStore } from './mail.js';
import type { AgentRegistry } from './store.js';

/** Ignore anything larger — a message is prose, not a payload. */
const MAX_MESSAGE_BYTES = 64 * 1024;

/** Re-scan interval. See the header: the sweep is the guarantee. */
const SWEEP_INTERVAL_MS = 5_000;

export class MailDrop {
  readonly #root: string;
  readonly #crew: string;
  readonly #registry: AgentRegistry;
  readonly #mail: MailStore;
  #watcher: FSWatcher | null = null;
  #sweeper: NodeJS.Timeout | null = null;
  #draining = false;
  /** Directory names already complained about, so a stray dir logs once. */
  #warned = new Set<string>();

  constructor(options: {
    root: string;
    crew: string;
    registry: AgentRegistry;
    mail: MailStore;
  }) {
    this.#root = options.root;
    this.#crew = options.crew;
    this.#registry = options.registry;
    this.#mail = options.mail;
  }

  get root(): string {
    return this.#root;
  }

  /** Where a given agent drops its outgoing mail. */
  dirFor(agentId: string): string {
    return join(this.#root, agentId);
  }

  start(): void {
    mkdirSync(this.#root, { recursive: true });
    this.syncDirectories();

    try {
      // Recursive where the platform manages it, since the files land one
      // level down; the non-recursive fallback still fires on directory
      // creation, and the sweep covers everything either way.
      this.#watcher = watch(this.#root, { recursive: true }, () => this.drain());
    } catch {
      try {
        this.#watcher = watch(this.#root, () => this.drain());
      } catch (error) {
        process.stderr.write(
          `[mail] cannot watch ${this.#root}: ${String(error)} — sweeping only\n`,
        );
      }
    }

    this.#sweeper = setInterval(() => {
      this.syncDirectories();
      this.drain();
    }, SWEEP_INTERVAL_MS);
    this.#sweeper.unref();

    // Anything dropped while the waker was down is still mail.
    this.drain();
    process.stdout.write(`[mail] watching ${this.#root} for crew ${this.#crew}\n`);
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
  }

  /**
   * Give every agent in this crew a drop directory.
   *
   * Created by the waker rather than by the agent, so the set of directories
   * that exist is the set of agents that exist. Re-run on every sweep because
   * a channel that has just been spoken to for the first time is a new agent,
   * and it should not have to wait for a restart to be able to send.
   *
   * Dead agents get one too. `status` is declared rather than observed, so a
   * row marked dead while a turn was in flight would otherwise silently lose
   * that turn's mail.
   */
  syncDirectories(): void {
    for (const agent of this.#registry.listByCrew(this.#crew)) {
      try {
        mkdirSync(this.dirFor(agent.id), { recursive: true });
      } catch (error) {
        process.stderr.write(`[mail] cannot create drop dir for ${agent.id}: ${String(error)}\n`);
      }
    }
  }

  /** Read, stamp and deliver every message currently on disk. */
  drain(): void {
    if (this.#draining) return;
    this.#draining = true;

    try {
      let entries: string[];
      try {
        entries = readdirSync(this.#root);
      } catch {
        return;
      }

      for (const author of entries) {
        const dir = join(this.#root, author);
        let names: string[];
        try {
          if (!statSync(dir).isDirectory()) continue;
          names = readdirSync(dir);
        } catch {
          continue;
        }
        if (names.length === 0) continue;

        // A directory that is not a registered agent of this crew cannot be a
        // sender: the whole point is that the name is the identity, so a name
        // nobody minted stamps nothing. Left on disk rather than deleted —
        // discarding files from a directory we do not understand is how you
        // lose the evidence of whatever created it.
        const agent = this.#registry.get(author);
        if (!agent || agent.crew !== this.#crew) {
          if (!this.#warned.has(author)) {
            this.#warned.add(author);
            process.stderr.write(
              `[mail] ${author}/ holds ${names.length} file(s) but is not an agent of ` +
                `crew ${this.#crew} — ignoring, nothing will be delivered from it\n`,
            );
          }
          continue;
        }

        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          this.#handleFile(author, join(dir, name), name);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  #handleFile(author: string, path: string, name: string): void {
    try {
      if (statSync(path).size > MAX_MESSAGE_BYTES) {
        process.stderr.write(`[mail] ${author}/${name}: too large, discarded\n`);
        unlinkSync(path);
        return;
      }

      const raw = readFileSync(path, 'utf8');
      // Remove before acting — see the header.
      unlinkSync(path);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        process.stderr.write(`[mail] ${author}/${name}: not valid JSON, discarded\n`);
        return;
      }

      const body = (parsed ?? {}) as Record<string, unknown>;
      const to = typeof body['to'] === 'string' ? body['to'].trim() : '';
      const subject = typeof body['subject'] === 'string' ? body['subject'] : '';
      const text = typeof body['body'] === 'string' ? body['body'] : '';

      // Worth a line in the journal: an agent that supplies `from` believes it
      // can choose who a message is from. It cannot, and it should find out
      // from the log rather than from a message that silently went out under
      // its own name anyway.
      if ('from' in body || 'author' in body) {
        process.stderr.write(
          `[mail] ${author}/${name}: ignoring "from"/"author" in the body — ` +
            'authorship comes from the drop directory\n',
        );
      }

      if (!to || !text) {
        process.stderr.write(
          `[mail] ${author}/${name}: needs "to" and "body", discarded\n`,
        );
        return;
      }

      const result: DeliveryResult = this.#mail.deliver({
        author,
        recipient: to,
        subject,
        body: text,
      });

      const target = to === FEED ? 'the feed' : to;
      if (result.accepted) {
        process.stdout.write(`[mail] ${author} → ${target}: ${result.detail}\n`);
      } else {
        process.stderr.write(`[mail] ${author} → ${target}: REFUSED — ${result.detail}\n`);
      }
    } catch (error) {
      process.stderr.write(`[mail] ${author}/${name}: ${String(error)}\n`);
    }
  }
}
