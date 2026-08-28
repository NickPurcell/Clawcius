import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { TokenProvider } from './github-app.js';

/** An installation token lives an hour; one this old is treated as dead. */
const STALE_AFTER_MS = 55 * 60_000;

/** How often to ask the provider for the current token. */
export const REFRESH_INTERVAL_MS = 5 * 60_000;

/** Atomic, 0600, and never observable half-written. */
export function writeSecretFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existing = statSync(path, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) rmSync(path, { recursive: true, force: true });
  // Named per target and per process, so two daemons on one host cannot rename each other's half-written file into place.
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, contents, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
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
  /** The directory the container mounts: the token file, the netrc and the curlrc live here. */
  readonly dir: string;
  readonly provider: TokenProvider;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  readonly intervalMs?: number;
};

/** Keeps the token file and the netrc in `dir` holding a currently-valid installation token, or absent. */
export class TokenFileRefresher {
  readonly #opts: TokenFileOptions;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #token: string | null = null;
  /** When `#token` was first obtained; 0 while nothing is on disk. */
  #freshAt = 0;

  constructor(opts: TokenFileOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  /** Writes once now, then every interval. Answers whether a token is on disk. */
  async start(): Promise<boolean> {
    await this.#tick();
    this.#timer = setInterval(() => void this.#tick(), this.#opts.intervalMs ?? REFRESH_INTERVAL_MS);
    this.#timer.unref?.();
    return this.#freshAt > 0;
  }

  /** Stop refreshing, and take the credential with you. */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#remove();
  }

  /** Visible for tests: run one refresh without waiting for the interval. */
  async refreshNow(): Promise<void> {
    await this.#tick();
  }

  async #tick(): Promise<void> {
    try {
      const token = await this.#opts.provider();
      writeSecretFile(tokenFilePath(this.#opts.dir), token);
      writeCurlConfig(this.#opts.dir, token);
      // A caching provider hands back the same token until it has to mint, so the age that matters is the token's, not the write's.
      if (token !== this.#token) {
        this.#token = token;
        this.#freshAt = this.#now();
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'failed';
      const ageMs = this.#now() - this.#freshAt;
      if (this.#freshAt > 0 && ageMs < STALE_AFTER_MS) {
        this.#opts.log(
          `[token-file] refresh failed (${code}); the token on disk is ` +
            `${Math.round(ageMs / 60_000)} minute(s) old and stays in use`,
        );
        return;
      }
      this.#remove();
      this.#opts.log(
        `[token-file] no installation token (${code}); nothing at ` +
          `${tokenFilePath(this.#opts.dir)} until a refresh succeeds`,
      );
    }
  }

  /** Runs from a timer and on shutdown, so it must not throw. */
  #remove(): void {
    this.#token = null;
    this.#freshAt = 0;
    try {
      rmSync(tokenFilePath(this.#opts.dir), { force: true });
      removeCurlConfig(this.#opts.dir);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'failed';
      this.#opts.log(`[token-file] could not remove the credential (${code}); a usable token may remain on disk`);
    }
  }
}
