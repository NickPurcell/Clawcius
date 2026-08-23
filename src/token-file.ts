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
import { basename, dirname, join } from 'node:path';
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
  writeSecretFile(path, token);
}

/** Atomic, 0600, and never observable half-written. See `writeTokenFile`. */
export function writeSecretFile(path: string, contents: string): void {
  // 0700 rather than the default 0755, so the directory's mode does not depend
  // on whether the daemon or `run-container.sh` created it first.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Defence in depth. `container.githubTokenDir` is refused inside any bind
  // mount and is mounted read-only, so nothing in a container should be able to
  // put a directory here — but `renameSync` throws EISDIR onto a path that has
  // one, and that throw took down the daemon at boot in the first version of
  // this module. Clear a non-file rather than propagating an error whose text
  // explains nothing.
  const existing = statSync(path, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) rmSync(path, { recursive: true, force: true });
  // Named per TARGET and per process: per process so two daemons on one host
  // cannot rename each other's half-written file into place, and per target
  // because this now writes three files into one directory and a shared temp
  // name would have them treading on each other the moment any two overlap.
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, contents, { mode: 0o600 });
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

/** Curl reads `$CURL_HOME/.curlrc`; this is the directory we point it at. */
export function curlrcPath(githubTokenDir: string): string {
  return join(githubTokenDir, '.curlrc');
}

export function netrcPath(githubTokenDir: string): string {
  return join(githubTokenDir, 'netrc');
}

/**
 * The GitHub host this credential is scoped to, named once.
 *
 * SCOPE IS THE WHOLE SAFETY PROPERTY OF A NETRC. `machine api.github.com`
 * attaches the credential to that host and nothing else — verified including
 * across `curl -L`, which does not carry the header to a redirect target. A
 * `default` entry, or a second `machine` line, silently hands the App token to
 * any host an agent curls, and nothing downstream would notice.
 *
 * A test asserts the written file has exactly one `machine` line and that it is
 * this one, because that is the assertion whose absence would cost something.
 *
 * DELIBERATELY NOT DERIVED FROM `agent.armed.github.apiBase`, which is
 * configurable. Point that at a GitHub Enterprise instance and the daemon's
 * poller follows while agents' curl carries nothing, because this still names
 * `api.github.com` — which looks like an oversight and is not. Deriving the
 * netrc host from configuration is exactly the scope-widening described above,
 * and it would make the host an operator-settable input to a credential's
 * blast radius. A crew on Enterprise needs this constant changed with the
 * change reviewed, rather than inherited silently from a URL somebody edited
 * for a different reason.
 */
export const GITHUB_API_HOST = 'api.github.com';

/**
 * Make a bare `curl https://api.github.com/...` authenticate, per call.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 *
 * `gitEnv`'s credential helper routes GIT through the token file, so pushes
 * carry the App. But opening a pull request, commenting, labelling and merging
 * are REST calls, and those were still using `$GITHUB_TOKEN` — the PAT. So
 * every pull request was authored by the account, which is what stops anyone
 * approving the crew's work.
 *
 * The obvious fix — put the installation token in `$GITHUB_TOKEN` — is the
 * defect this repository already fixed once. A session's environment is fixed
 * when its process spawns and an installation token dies in an hour, so a long
 * session would end up holding a corpse. Whatever an agent uses for REST has to
 * resolve the credential AT CALL TIME.
 *
 * Curl re-reads its netrc on every invocation, so a file the daemon keeps
 * current is exactly that — the same shape as the git credential helper, and
 * for the same reason.
 *
 * ── The fallback lives here rather than at the call ────────────────────────
 *
 * The git helper reads the file first and `$GITHUB_TOKEN` second, resolving per
 * call. Curl cannot do that: with no netrc it sends nothing and gets a 401
 * rather than falling back. Verified.
 *
 * So the daemon writes WHICHEVER CREDENTIAL IS IN FORCE — the installation
 * token when the App is usable, the PAT otherwise. That is not a compromise. The
 * helper's ordering depends on the file being ABSENT at the right moment, which
 * is the gap where a file holding a useless token is present and the fallback
 * never fires; writing the credential in force makes the fallback happen on
 * every refresh instead of at one branch point.
 *
 * ── What this does not cover, stated rather than implied ───────────────────
 *
 * A netrc holding a token that lacks the permission the call needs is
 * well-formed and present, and fails as a 403 at the call. Presence cannot see
 * that, and neither can this.
 *
 * And it is CURL-SPECIFIC. An agent using a Python request or a fetch is
 * unaffected and silently stays on whatever `$GITHUB_TOKEN` holds. Most agent
 * REST goes through curl, which is why this is worth doing; it is not the same
 * claim as "agents authenticate as the App".
 */
export function writeCurlConfig(githubTokenDir: string, token: string): void {
  writeSecretFile(
    netrcPath(githubTokenDir),
    `machine ${GITHUB_API_HOST}\n  login x-access-token\n  password ${token}\n`,
  );
  // `netrc-optional` rather than `netrc`: a missing file must not make every
  // unrelated curl in the container fail.
  //
  // AND THE PATH IS QUOTED. curl terminates an unquoted config parameter at the
  // first space, so a `githubTokenDir` containing one would silently disable the
  // credential — `netrc-optional` then does its job, curl exits 0, and the agent
  // gets a 401 from GitHub with nothing saying why. It would also print an
  // unquoted-whitespace warning on EVERY curl in the container, since CURL_HOME
  // makes this file global. `agent.ts` carries the same lesson about a path
  // spliced into a shell command: silent is the part that matters.
  writeSecretFile(
    curlrcPath(githubTokenDir),
    `netrc-optional\nnetrc-file = "${netrcPath(githubTokenDir)}"\n`,
  );
}

/**
 * Remove the curl credential without disturbing the token file.
 *
 * The netrc only, deliberately — `.curlrc` is left pointing at a path that no
 * longer exists, which is exactly what `netrc-optional` is for: curl finds no
 * netrc, sends no credential, and does not error. Removing both would be tidier
 * and would buy nothing.
 */
export function removeCurlConfig(githubTokenDir: string): void {
  rmSync(netrcPath(githubTokenDir), { force: true });
}

export type TokenFileOptions = {
  readonly path: string;
  readonly provider: TokenProvider;
  readonly log: (message: string) => void;
  /**
   * Called with every token actually written, so a second consumer can be kept
   * in step without a second provider and a second cache.
   */
  readonly onToken?: (token: string) => void;
  /** Called when the written token is given up on, for the same reason. */
  readonly onNoToken?: () => void;
  /** Called on `stop()`, to clear rather than replace. See `stop()`. */
  readonly onStop?: () => void;
  /**
   * Whether a PAT exists to fall back TO. Decides what the failure line may
   * promise — `github-app.ts` spends a paragraph on why: a warning the reader
   * watches get disproved is a warning they learn to skip. With no PAT the
   * helper hands git an empty password, so "agents fall back to GITHUB_TOKEN"
   * would be refuted by the next thing that happens.
   */
  readonly hasFallbackToken?: boolean;
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
  async start(): Promise<boolean> {
    await this.#tick();
    // Reported rather than assumed: the caller announces the file to the
    // operator and must not announce one that is not there.
    const wrote = this.#written;
    this.#timer = setInterval(() => {
      void this.#tick();
    }, this.#opts.intervalMs ?? REFRESH_INTERVAL_MS);
    this.#timer.unref?.();
    return wrote;
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
    // NOT `onNoToken` — that writes whichever credential is IN FORCE, which for
    // an App-plus-PAT deployment means shutdown would install the PAT: an
    // hour-lived credential replaced by one that never expires and that nothing
    // ever removes, in the directory this method exists to clear. The bounding
    // argument in this module's header — a bind-mounted file outlives the
    // container, but the token dies in an hour — does not transfer to a PAT.
    //
    // Which credential is in force is the RUNNING daemon's business. A stopped
    // one leaves nothing.
    // Logged, not swallowed, and WITHOUT the asymmetry an earlier version of
    // this comment defended. That argument was that a netrc left here holds an
    // installation token, dead within the hour, so the failure was not worth a
    // line — but `onNoToken` writes the PAT into the netrc when the App is given
    // up on, and `stop()` runs after that like any other. So the comment
    // reasoned about WHICH BRANCH when the deciding variable is WHAT THE NETRC
    // HOLDS, which this method cannot see. It was wrong twice, the same way.
    //
    // Saying it unconditionally makes the distinction unnecessary rather than
    // correcting it a third time. A credential that could not be removed is
    // worth a line whatever it is.
    try {
      this.#opts.onStop?.();
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'failed';
      this.#opts.log(
        `[token-file] could not remove the curl credential on shutdown (${code}); ` +
          'a usable token may remain on disk. Shutdown continues.',
      );
    }
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

    // THE SECONDARY CONSUMER CANNOT INVALIDATE THE PRIMARY ONE. Called last,
    // after every piece of bookkeeping, and inside its own catch.
    //
    // Inside `#write`'s try it was worse than it looks: a throw from here was
    // attributed to the PROVIDER, so a token that had been obtained and written
    // was deleted and the operator was told "could not obtain an installation
    // token" naming the wrong subsystem. And because `#mintedAtMs` was stamped
    // after it returned, a persistently failing netrc write froze the staleness
    // clock — sixty minutes of a healthy credential, then every agent's git
    // demoted to the PAT because a file one directory over could not be written.
    try {
      this.#opts.onToken?.(token);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'failed';
      this.#opts.log(
        `[token-file] the git credential is current, but the curl credential could not ` +
          `be written (${code}); it is UNCHANGED — REST keeps using whatever was last ` +
          'written there, or nothing if there never was any. There is no fallback: with ' +
          'no netrc curl sends nothing and takes a 401.',
      );
    }
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
      try {
        this.#opts.onNoToken?.();
      } catch {
        // Same reason as the `rmSync` below: `#tick` runs as `void this.#tick()`
        // from a timer, so a throw out of this catch is an unhandled rejection
        // and Node turns that into an uncaught exception. From `start()` it
        // would be a throw out of `main()`'s await — the daemon-wide restart
        // loop this module deliberately stopped doing.
      }
      this.#opts.log(
        `[token-file] could not obtain an installation token (${code}); there is no ` +
          `usable credential at ${this.#opts.path}. ` +
          (this.#opts.hasFallbackToken
            ? 'Agents fall back to GITHUB_TOKEN until a refresh succeeds; retrying.'
            : 'GITHUB_TOKEN is not set either, so agent git operations will fail ' +
              'until a refresh succeeds; retrying.'),
      );
    }
  }
}
