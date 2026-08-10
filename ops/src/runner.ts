/**
 * Running privileged commands, and not running them.
 *
 * Two rules, both absolute:
 *
 *   **argv arrays, never a shell.** `execFile` with an explicit
 *   `shell: false`. There is no command *string* anywhere in this service, so
 *   there is no quoting to get wrong, no `IFS`, no glob, no `$(…)`. The
 *   rendered form in the logs is built by `render()` and is for humans only —
 *   it is never parsed, never re-executed, and deliberately quoted in a way
 *   that would be wrong to paste blindly, so that nobody mistakes it for the
 *   real invocation.
 *
 *   **A mutating command goes through `run`, a read-only one through
 *   `probe`.** The distinction exists so that `dryRun` can be honest. If
 *   dry-run suppressed *everything*, the executor would have no idea what the
 *   current image is or whether the container is up, and every dry-run log
 *   line would be a guess about a machine it never looked at. So probes always
 *   execute and `run` never does while dryRun is on. Every call site of
 *   `probe` is enumerated in the executor and every one of them is a `docker
 *   inspect`, `docker images`, `git rev-parse` or `git status` — if you find
 *   yourself wanting to probe something that changes state, you want `run`.
 *
 * The environment is built rather than inherited. systemd hands this unit a
 * minimal environment already, but "minimal" is not "known", and a daemon that
 * runs docker and git should not be carrying whatever happened to be exported
 * when it was started by hand during an incident.
 */

import { execFile } from 'node:child_process';

export type CommandResult = {
  ok: boolean;
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Milliseconds spent. */
  durationMs: number;
  /** True when nothing was executed because dryRun is on. */
  skipped: boolean;
  /** The argv exactly as it would have been / was executed. */
  argv: string[];
  /** Non-empty when the process could not be started at all. */
  spawnError: string;
};

export type RunOptions = {
  /** Working directory. Always a config-derived absolute path. */
  cwd?: string;
  /** Extra environment on top of the fixed base. Config-derived only. */
  env?: Record<string, string>;
  /** Override the default timeout for a long operation like an image pull. */
  timeoutSeconds?: number;
  /**
   * Run the child as this user instead of root. Both or neither.
   *
   * Added 2026-08-10 for the build step, and it is the only reason this
   * process ever runs a child as anybody but itself. `npm ci` and `npm run
   * build` executed as root leave root-owned `node_modules/` and `dist/` in a
   * checkout owned by `npurcell`, after which every unit that runs as npurcell
   * fails to start with an EACCES naming a file nobody edited. It happened
   * twice on the night of 2026-08-09; see ops/src/build.ts for the whole story.
   *
   * The uid comes from `stat`ing the checkout, never from config and never from
   * a request. It reaches `execFile` as a number in the options object, so
   * libuv performs `setgid(2)` then `setuid(2)` in the forked child before
   * `execve` — no `sudo`, no `su`, no setuid binary, and therefore nothing that
   * `NoNewPrivileges=true` would neuter. Dropping privilege was never the thing
   * NNP forbids; gaining it is.
   */
  uid?: number;
  gid?: number;
};

/** Output kept per stream. Enough to diagnose, bounded enough to journal. */
const MAX_OUTPUT_CHARS = 8000;

/**
 * The fixed environment every command starts from.
 *
 * PATH is spelled out rather than inherited because the executor invokes
 * `docker/run-container.sh`, which is bash and calls `docker`, `date` and
 * `stat` by name. HOME is set because git refuses to be helpful without one.
 */
function baseEnv(): Record<string, string> {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env['HOME'] ?? '/root',
    LANG: 'C.UTF-8',
    // Git must never try to ask anybody anything: this process has no
    // terminal, and a credential prompt would hang until the timeout rather
    // than failing with a usable message.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
  };
}

/**
 * Human-readable rendering of an argv array, for logs.
 *
 * Not a shell command. Nothing consumes this.
 */
export function render(argv: string[]): string {
  return argv
    .map((arg) => (/^[A-Za-z0-9._:/=@-]+$/.test(arg) ? arg : JSON.stringify(arg)))
    .join(' ');
}

function truncate(value: string): string {
  const clean = value.replace(/\s+$/, '');
  return clean.length > MAX_OUTPUT_CHARS
    ? `${clean.slice(0, MAX_OUTPUT_CHARS)}\n…[${clean.length - MAX_OUTPUT_CHARS} more chars]`
    : clean;
}

export class Runner {
  #dryRun: boolean;
  #defaultTimeoutSeconds: number;
  #log: (line: string) => void;

  constructor(dryRun: boolean, defaultTimeoutSeconds: number, log: (line: string) => void) {
    this.#dryRun = dryRun;
    this.#defaultTimeoutSeconds = defaultTimeoutSeconds;
    this.#log = log;
  }

  get dryRun(): boolean {
    return this.#dryRun;
  }

  /**
   * A command that changes something. Suppressed by dryRun.
   *
   * The suppressed result is `ok: true` deliberately: dry-run is supposed to
   * walk the whole decision tree, including the branches that only happen
   * after a success, so that the log shows the shape of a real run. It is
   * marked `skipped` so that nothing downstream mistakes it for evidence — the
   * executor refuses to arm a check-in deadline off a skipped operation, for
   * instance, because there is nothing to check in about.
   */
  async run(argv: string[], options: RunOptions = {}): Promise<CommandResult> {
    if (this.#dryRun) {
      const where = options.cwd ? ` (cwd ${options.cwd})` : '';
      const env = options.env
        ? ` (env ${Object.entries(options.env)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ')})`
        : '';
      // The uid is in the dry-run line on purpose. "Would the build have run
      // as root?" is the question the dry run is being read to answer, and an
      // answer that is only visible by inspecting the code is not an answer.
      const as = options.uid === undefined ? '' : ` (as uid ${options.uid} gid ${options.gid})`;
      this.#log(`DRY-RUN would run: ${render(argv)}${where}${as}${env}`);
      return {
        ok: true,
        code: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        skipped: true,
        argv,
        spawnError: '',
      };
    }
    const as = options.uid === undefined ? '' : ` (as uid ${options.uid} gid ${options.gid})`;
    this.#log(`exec: ${render(argv)}${options.cwd ? ` (cwd ${options.cwd})` : ''}${as}`);
    return this.#exec(argv, options);
  }

  /**
   * A read-only command. Always executed, dryRun or not.
   *
   * See the header: a dry run that cannot see the machine reports fiction.
   */
  async probe(argv: string[], options: RunOptions = {}): Promise<CommandResult> {
    return this.#exec(argv, options);
  }

  #exec(argv: string[], options: RunOptions): Promise<CommandResult> {
    const [command, ...args] = argv;
    const started = Date.now();

    if (!command) {
      return Promise.resolve({
        ok: false,
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        skipped: false,
        argv,
        spawnError: 'empty argv',
      });
    }

    return new Promise<CommandResult>((resolve) => {
      execFile(
        command,
        args,
        {
          cwd: options.cwd,
          env: { ...baseEnv(), ...(options.env ?? {}) },
          // Spread rather than set unconditionally: `uid: undefined` is not
          // the same as absent to libuv on every Node line, and "run as
          // whoever we already are" must stay the default that costs nothing
          // to reason about.
          ...(options.uid === undefined ? {} : { uid: options.uid, gid: options.gid }),
          timeout: (options.timeoutSeconds ?? this.#defaultTimeoutSeconds) * 1000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
          // Belt and braces. This is the default; it is written out because
          // the entire security argument of this service rests on it, and a
          // default is a thing someone can change without noticing what they
          // changed.
          shell: false,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - started;
          if (!error) {
            resolve({
              ok: true,
              code: 0,
              signal: null,
              stdout: truncate(stdout),
              stderr: truncate(stderr),
              durationMs,
              skipped: false,
              argv,
              spawnError: '',
            });
            return;
          }

          // execFile reports three different failures through one channel: a
          // non-zero exit, a signal (our own timeout kill included), and a
          // failure to spawn at all. They are not the same thing to a caller —
          // "docker is not installed" and "docker said no" want different
          // reactions — so they are separated here rather than collapsed into
          // a boolean.
          const withCode = error as NodeJS.ErrnoException & {
            code?: number | string;
            signal?: string;
          };
          const numericCode = typeof withCode.code === 'number' ? withCode.code : null;
          const spawnError =
            typeof withCode.code === 'string' ? `${withCode.code}: ${error.message}` : '';

          resolve({
            ok: false,
            code: numericCode,
            signal: withCode.signal ?? null,
            stdout: truncate(stdout),
            stderr: truncate(stderr || error.message),
            durationMs,
            skipped: false,
            argv,
            spawnError,
          });
        },
      );
    });
  }
}

/** One-line summary of a result, for the journal. */
export function summarise(result: CommandResult): string {
  if (result.skipped) return 'skipped (dry-run)';
  if (result.ok) return `ok in ${(result.durationMs / 1000).toFixed(1)}s`;
  if (result.spawnError) return `could not start: ${result.spawnError}`;
  if (result.signal) return `killed by ${result.signal} after ${(result.durationMs / 1000).toFixed(1)}s`;
  return `exit ${result.code ?? '?'} after ${(result.durationMs / 1000).toFixed(1)}s`;
}
