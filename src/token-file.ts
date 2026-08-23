/**
 * The agent session's GitHub credential, when the deployment authenticates as a
 * GitHub App.
 *
 * ── Why a file, when the whole point was that there was no file ─────────────
 *
 * `agent.ts`'s git configuration was built so the token appears in no URL, no
 * remote and no reflog, and its comment said the token never lands on disk.
 * This module makes that last clause false on purpose, so it is worth being
 * exact about what changed and what did not.
 *
 * A session's environment is FIXED when its process spawns. A PAT does not
 * expire, so handing it over at spawn was correct forever. An installation
 * token expires in an hour, and agent sessions outlive that — an agent that
 * pushes three hours into a turn would find a credential that died two hours
 * ago, with no mechanism to learn a new one. The env var cannot be updated from
 * outside the process, so the credential has to live somewhere the helper can
 * re-read. That is the whole reason.
 *
 * ── What the file costs, stated rather than waved at ────────────────────────
 *
 * NOT a new reader. Every process in the container runs as uid 1000 `agent`,
 * and `/proc/1/environ` is readable, so a sibling could already read the token
 * out of the environment. The file does not widen who can see it.
 *
 * GENUINELY WIDER IN ONE WAY: a workspace is a bind mount, so a file outlives
 * the container where an env var does not. That is bounded — `docker/
 * snapshot.sh` uses `docker commit`, which excludes mounts, so the token cannot
 * reach an image. It is not bounded against someone reading the host disk, and
 * that is the trade this module makes.
 *
 * `0600` is not the protection here; the shared uid means it separates the crew
 * from nobody. It is there so that a future change which stops sharing a uid
 * finds the file already private, rather than needing to remember.
 *
 * ── Failure, which is the part with a body count ────────────────────────────
 *
 * The waker's version of "a credential refresh failed" is issue #176: a poll
 * that throws calls `store.disarm()`, so a transiently unreadable PEM during a
 * key rotation permanently kills every armed watch in the crew. On 2026-08-23 a
 * token rotation did exactly that to a live watch — one 401, one disarmed row,
 * no retry.
 *
 * So this module deliberately does NOT treat a failed refresh as fatal, and
 * deliberately does not treat it as nothing:
 *
 *   - A refresh that throws while the current token is still valid is LOGGED
 *     and retried on the next tick. Deleting the file there would convert a
 *     five-minute credential blip into an outage for every agent, which is the
 *     mistake #176 describes.
 *   - A refresh that throws when the written token is at or past its useful
 *     life DELETES the file. A stale token is worse than an absent one: git
 *     keeps working until the moment it does not, and then fails with a `401`
 *     that names nothing. An absent file fails immediately, and the helper says
 *     which file was missing.
 *
 * That is the same distinction #176 argues the waker should make, applied here
 * on the way in rather than argued for elsewhere.
 *
 * ── Logging ────────────────────────────────────────────────────────────────
 *
 * Never the token, and never the PEM's path. `error.code` rather than
 * `String(error)`, for the reason `github-app.ts` gives: an `fs` error carries
 * the path in its message, and a path names the file, and the file is the key.
 * The token FILE's path is not a secret and is logged, because an operator
 * cannot fix a file they cannot name.
 */

import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TokenProvider } from './github-app.js';

/** How long before a written token is treated as too old to keep serving. */
const STALE_AFTER_MS = 55 * 60_000;

/** How often to ask the provider for the current token. */
export const REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * Write the token so that no reader can ever observe a partial one.
 *
 * `writeFileSync` to the final path truncates first, so a `git push` landing in
 * that window reads an empty or half-written credential and fails with an
 * authentication error that has nothing to do with authentication. Write to a
 * neighbouring temp file and `rename`, which is atomic within a filesystem.
 *
 * The mode is on the `writeFileSync` rather than a later `chmod`: the file must
 * never exist, even briefly, at the default 0644.
 */
export function writeTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Defence in depth. `container.githubTokenDir` is refused inside any bind
  // mount and is mounted read-only, so nothing in a container should be able to
  // put a directory here — but `renameSync` throws EISDIR onto a path that has
  // one, and that throw took down the daemon at boot in the first version of
  // this module. Clear a non-file rather than propagating an error whose text
  // explains nothing.
  const existing = statSync(path, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) rmSync(path, { recursive: true, force: true });
  // Named per process so two daemons on one host cannot rename each other's
  // half-written file into place.
  const tmp = join(dirname(path), `.github-token.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, token, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    // A rename that fails, or a process that dies between the two, would
    // otherwise leave a 0600 file holding a live token that nothing ever
    // cleans up — the next write reuses this name only while the pid is the
    // same. `force` so the ordinary success case, where the rename already
    // consumed it, is not an error.
    rmSync(tmp, { force: true });
  }
}

/**
 * Where the credential lives, derived rather than configured.
 *
 * ONE function, two callers — the daemon that writes it and `agent.ts`'s
 * credential helper that reads it. A config knob for the FILE would let those
 * two drift, and a path wrong on one side fails as an authentication error
 * rather than as a missing file, which is the least legible form this can take.
 *
 * THE DIRECTORY IS NOT THE WORKSPACE, and that is the whole of what round 1
 * corrected. The first version put this in `sessions.workspaceRoot`, which is
 * bind-mounted READ-WRITE and is the container's working directory — so the
 * least trusted process on the machine could replace the credential the daemon
 * serves it, or create a directory at the path and turn `renameSync`'s EISDIR
 * into a permanent restart loop. `container.githubTokenDir` is mounted
 * READ-ONLY instead (`run-container.sh`), and `agent-config.ts` refuses to let
 * it sit inside any bind mount, by the same rule and for the same reason as
 * `container.execEnvDir`.
 *
 * The directory is mounted at the SAME path inside the container as outside, as
 * every other mount in that script is, so there is no translation to get wrong
 * between the daemon writing and an agent reading.
 */
export function tokenFilePath(githubTokenDir: string): string {
  return join(githubTokenDir, 'installation-token');
}

export type TokenFileOptions = {
  readonly path: string;
  readonly provider: TokenProvider;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  readonly intervalMs?: number;
};

/**
 * Keeps one file holding a currently-valid installation token.
 *
 * ONE file for the whole crew, not one per agent. N copies on a timer is N
 * chances for one of them to be stale, and the failure of a stale one is
 * invisible until an agent tries to push.
 */
export class TokenFileRefresher {
  readonly #opts: TokenFileOptions;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #mintedAtMs = 0;
  #lastToken: string | null = null;
  #written = false;

  constructor(opts: TokenFileOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Fetch once and write, then keep it current.
   *
   * A FIRST FETCH THAT FAILS IS LOGGED, NOT THROWN, and that is a reversal of
   * the first version of this module.
   *
   * Throwing here took down the entire daemon — Discord, mail, reminders — into
   * a five-second restart loop, because `main()` awaits this and nothing above
   * catches. And the trigger is a network call: a rate limit, a 5xx, or thirty
   * seconds of packet loss at the wrong moment. That made a MISCONFIGURED App
   * degrade gracefully while a CORRECTLY configured one that was briefly
   * unreachable was fatal, which is backwards, and it contradicts this module's
   * own argument that a transient credential failure must not become a
   * permanent one.
   *
   * Nothing is lost by continuing. No file means the credential helper falls
   * through to `GITHUB_TOKEN`, which is the same degradation `checkAppConfig`
   * chooses one screen up for the same reason — a crew reaching GitHub as the
   * older identity beats a crew not running.
   */
  async start(): Promise<void> {
    await this.#tick();
    this.#timer = setInterval(() => {
      void this.#tick();
    }, this.#opts.intervalMs ?? REFRESH_INTERVAL_MS);
    this.#timer.unref?.();
  }

  /**
   * Stop refreshing, and take the credential with you.
   *
   * Clearing the timer alone would leave a working installation token in a
   * mounted directory for up to an hour with nothing refreshing or removing it
   * — across a clean shutdown or a redeploy. This module's own argument is that
   * an absent file beats a stale one, and the file outliving the container is
   * the single genuinely new exposure the design accepts, so unlinking here is
   * implied by the reasoning already written above.
   */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#written = false;
    this.#lastToken = null;
    try {
      rmSync(this.#opts.path, { force: true });
    } catch {
      // Shutdown is not a place to throw. The next start overwrites it anyway.
    }
  }

  /** Visible for tests: run one refresh without waiting for the interval. */
  async refreshNow(): Promise<void> {
    await this.#tick();
  }

  async #write(): Promise<void> {
    const token = await this.#opts.provider();
    writeTokenFile(this.#opts.path, token);
    // THE CLOCK TRACKS THE TOKEN, NOT THE WRITE, and the difference is 45
    // minutes of serving a corpse.
    //
    // `appTokenProvider` is a CACHE. It answers with the same token, without
    // touching the network or the PEM, until five minutes before expiry — so
    // for the first ~55 minutes of a token's life every tick rewrites identical
    // bytes and succeeds whether or not the credential source is healthy.
    // Stamping the clock on every successful write therefore measured the age
    // of the last provider CALL, which is never more than one interval, so "the
    // token is past its useful life" was never true while the token was
    // actually dying.
    //
    // A changed value is the only evidence available here that a mint actually
    // happened, since a `TokenProvider` returns a string and not an expiry.
    if (token !== this.#lastToken) {
      this.#lastToken = token;
      this.#mintedAtMs = this.#now();
    }
    this.#written = true;
  }

  async #tick(): Promise<void> {
    try {
      await this.#write();
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'failed';
      const ageMs = this.#now() - this.#mintedAtMs;

      if (this.#written && ageMs < STALE_AFTER_MS) {
        // Keep serving. See the header: turning a transient failure into a
        // permanent one is issue #176, and it has already cost a live watch.
        this.#opts.log(
          `[token-file] refresh failed (${code}); the token on disk is ` +
            `${Math.round(ageMs / 60_000)} minute(s) old and still in use. Retrying.`,
        );
        return;
      }

      // Past its life and unrefreshable. An absent file fails immediately and
      // legibly; a stale one fails later, as a 401 that names nothing.
      this.#written = false;
      try {
        rmSync(this.#opts.path, { force: true });
      } catch {
        // `#tick` is called as `void this.#tick()` from a timer, so a throw out
        // of this catch is an unhandled rejection and Node turns that into an
        // uncaught exception. There is nothing useful to do about a failed
        // unlink and nothing at all to gain by dying of it.
      }
      this.#opts.log(
        `[token-file] could not obtain an installation token (${code}); there is no ` +
          `usable credential at ${this.#opts.path}. Agents fall back to GITHUB_TOKEN ` +
          'until a refresh succeeds; retrying.',
      );
    }
  }
}
