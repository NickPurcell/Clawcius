/**
 * The agent's way to ask to be woken: drop a file in a watched directory.
 *
 * This replaces the bespoke scheduler — a SQLite table, a poll loop and four
 * MCP tools — with a directory. Inside its container the agent has cron and a
 * real filesystem, so scheduling is something it already knows how to do:
 *
 *   0 9 * * *  echo '{"channel":"…","prompt":"post the briefing"}' \
 *                > /var/lib/clawcius/run/wake/$(date +%s).json
 *
 * A directory rather than a socket because gVisor blocks connections to host
 * unix sockets — correctly, since a host UDS is a hole straight through the
 * sandbox boundary. A bind-mounted directory needs no such exception, and
 * writing a file is simpler for the agent than making an HTTP request.
 *
 * The waker still owns the decision to run a turn. A request is a request:
 * the concurrency cap and rate limit still apply, so this cannot be used to
 * get around them.
 *
 * AND A REQUEST MAY NOT MINT AN IDENTITY. This directory is inside the crew's
 * bind mount, so anything in the container can write to it, and `channel` used
 * to be handed straight on to a call that registers a row for an id it has not
 * seen. That made this a forge rather than a scheduler: name any id you like
 * and a turn starts under that name, holding that name's tools, running a
 * prompt of your choosing — an engineer could wake as its coordinator and from
 * there reach the host agent. `knows` is checked here, at the parse boundary,
 * for the same reason the author of a message is: it is the last point at which
 * the request is still data.
 *
 * It does not make this route safe. One crewmate can still wake another,
 * because a crew shares a container and this spool is not per agent (#31, #39).
 * It removes the ability to invent a name, which is what turned a shared
 * filesystem into a privilege boundary anybody could cross. The full answer is
 * the durable scheduler in CLAWSKY.md phase 4, which retires this file.
 */

import { readFileSync, readdirSync, mkdirSync, unlinkSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

export type WakeRequest = {
  channelId: string;
  prompt: string;
};

export type WakeHandler = (request: WakeRequest) => { accepted: boolean; detail: string };

/** Whether an id is already an agent on the board. See the header. */
export type KnowsAgent = (channelId: string) => boolean;

/** Ignore anything larger — a wake request is a couple of lines of JSON. */
const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * Re-scan interval. fs.watch is the fast path, but gVisor's gofer does not
 * always deliver inotify events for writes made inside the sandbox, so a slow
 * sweep guarantees requests are picked up even when the event never arrives.
 */
const SWEEP_INTERVAL_MS = 5_000;

export class WakeSpool {
  #dir: string;
  #onWake: WakeHandler;
  #knows: KnowsAgent;
  #watcher: FSWatcher | null = null;
  #sweeper: NodeJS.Timeout | null = null;
  #draining = false;

  constructor(dir: string, onWake: WakeHandler, knows: KnowsAgent = () => true) {
    this.#dir = dir;
    this.#onWake = onWake;
    this.#knows = knows;
  }

  get dir(): string {
    return this.#dir;
  }

  start(): void {
    mkdirSync(this.#dir, { recursive: true });

    try {
      this.#watcher = watch(this.#dir, () => void this.drain());
    } catch (error) {
      process.stderr.write(`[wake] cannot watch ${this.#dir}: ${String(error)} — polling only\n`);
    }

    this.#sweeper = setInterval(() => void this.drain(), SWEEP_INTERVAL_MS);
    this.#sweeper.unref();

    // Anything dropped while the waker was down is still valid.
    void this.drain();
    process.stdout.write(`[wake] watching ${this.#dir}\n`);
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
  }

  /** Process and remove every request file currently present. */
  drain(): void {
    if (this.#draining) return;
    this.#draining = true;

    try {
      let names: string[];
      try {
        names = readdirSync(this.#dir);
      } catch {
        return;
      }

      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const path = join(this.#dir, name);

        try {
          if (statSync(path).size > MAX_REQUEST_BYTES) {
            process.stderr.write(`[wake] ${name}: too large, discarded\n`);
            unlinkSync(path);
            continue;
          }

          const raw = readFileSync(path, 'utf8');
          // Remove before acting: a request that throws must not be retried
          // forever on every sweep.
          unlinkSync(path);

          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            process.stderr.write(`[wake] ${name}: not valid JSON, discarded\n`);
            continue;
          }

          const body = (parsed ?? {}) as Record<string, unknown>;
          const channelId = typeof body['channel'] === 'string' ? body['channel'] : '';
          const prompt = typeof body['prompt'] === 'string' ? body['prompt'] : '';

          if (!channelId || !prompt) {
            process.stderr.write(`[wake] ${name}: needs "channel" and "prompt", discarded\n`);
            continue;
          }

          if (!this.#knows(channelId)) {
            process.stderr.write(
              `[wake] ${name}: REFUSED — ${channelId} is not an agent on this board. ` +
                'A wake may name an identity that exists; it may not create one.\n',
            );
            continue;
          }

          const result = this.#onWake({ channelId, prompt });
          process.stdout.write(
            `[wake] ${name}: ${result.accepted ? 'accepted' : 'refused'} — ${result.detail}\n`,
          );
        } catch (error) {
          process.stderr.write(`[wake] ${name}: ${String(error)}\n`);
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}
