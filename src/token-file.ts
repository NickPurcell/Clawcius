import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { TokenProvider } from './github-app.js';

/** How long before a written token is treated as too old to keep serving. */
const STALE_AFTER_MS = 55 * 60_000;

/** How often to ask the provider for the current token. */
export const REFRESH_INTERVAL_MS = 5 * 60_000;

/** Write the token so that no reader can ever observe a partial one. */
export function writeTokenFile(path: string, token: string): void {
  writeSecretFile(path, token);
}

/** Atomic, 0600, and never observable half-written. See `writeTokenFile`. */
export function writeSecretFile(path: string, contents: string): void {
  // 0700 rather than the default 0755, so the directory's mode does not depend
  // on whether the daemon or `run-container.sh` created it first.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existing = statSync(path, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) rmSync(path, { recursive: true, force: true });
  // Named per target and per process, so two daemons on one host cannot rename each other's half-written file into place.
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, contents, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    // A failed rename would otherwise leave a 0600 file holding a live token that nothing cleans up.
    rmSync(tmp, { force: true });
  }
}

/** Where the installation token is written for the git credential helper. */
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

/** The one host the netrc entry covers. */
export const GITHUB_API_HOST = 'api.github.com';

/** Write a netrc for `GITHUB_API_HOST` and a `.curlrc` pointing at it, so curl inside the container sends the credential in force. */
export function writeCurlConfig(githubTokenDir: string, token: string): void {
  writeSecretFile(
    netrcPath(githubTokenDir),
    `machine ${GITHUB_API_HOST}\n  login x-access-token\n  password ${token}\n`,
  );
  writeSecretFile(
    curlrcPath(githubTokenDir),
    `netrc-optional\nnetrc-file = "${netrcPath(githubTokenDir)}"\n`,
  );
}

/** Remove the netrc only; `.curlrc` stays, and `netrc-optional` makes its absence harmless. */
export function removeCurlConfig(githubTokenDir: string): void {
  rmSync(netrcPath(githubTokenDir), { force: true });
}

export type TokenFileOptions = {
  readonly path: string;
  readonly provider: TokenProvider;
  readonly log: (message: string) => void;
  /** Called with every token actually written, so a second consumer can be kept in step without a second provider and a second cache. */
  readonly onToken?: (token: string) => void;
  /** Called when the written token is given up on, for the same reason. */
  readonly onNoToken?: () => void;
  /** Called on `stop()`, to clear rather than replace. See `stop()`. */
  readonly onStop?: () => void;
  /** Whether a PAT exists to fall back TO. */
  readonly hasFallbackToken?: boolean;
  readonly now?: () => number;
  readonly intervalMs?: number;
};

/** Keeps one file, shared by the whole crew, holding a currently-valid installation token. */
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

  /** Stop refreshing, and take the credential with you. */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#written = false;
    this.#lastToken = null;
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
    if (token !== this.#lastToken) {
      this.#lastToken = token;
      this.#mintedAtMs = this.#now();
    }
    this.#written = true;

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
        // `#tick` runs as `void this.#tick()` from a timer, so a throw out of this catch would be an uncaught exception.
      }
      try {
        this.#opts.onNoToken?.();
      } catch {
        // Same reason as the `rmSync` catch above.
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
