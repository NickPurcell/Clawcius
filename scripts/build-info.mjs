#!/usr/bin/env node
/**
 * Bake the build's identity into the artefact, at build time.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 *
 * On 2026-08-18 the status page was found serving a `dist/` built on
 * 2026-08-10. For eight days `systemctl status clawcius-status` said `active
 * (running)`, memory and CPU were healthy, and the startup banner printed the
 * port and both agent roots. Every one of those statements was true, and not
 * one of them was about WHICH CODE WAS RUNNING. `/api/clawsky` returned 404 the
 * whole time because the compiled output had no such route (Clawcius #90). In
 * the same week `clawcius-ops` failed to start 22,675 consecutive times on a
 * `dist/` that predated its own config, and nothing escalated (#89).
 *
 * Both were found by a person listing a directory and eyeballing timestamps.
 *
 * That is the only way they COULD be found, because of a constraint that is
 * deliberate and permanent: the host agent can read journals but cannot make an
 * HTTP request (`ops/src/host-agent.ts`), and the container agents cannot reach
 * the host at all. The journal is therefore the only verification channel that
 * exists — so the journal has to carry the one string that answers "is this
 * current?": the commit the running code was BUILT FROM, comparable against
 * `git rev-parse HEAD` with an eye rather than with an archaeology session.
 *
 * ── Why this is generated and not a runtime `git` call ──────────────────────
 *
 * A service that shells out to `git rev-parse HEAD` at startup reports what the
 * CHECKOUT says now, which is exactly the wrong number: on 2026-08-10 the
 * checkout was current and the `dist/` was not, and a runtime call would have
 * printed a reassuring, correct, useless sha. The two answers differ precisely
 * in the case this is for. So the sha is computed here, in the same command
 * that runs `tsc`, and compiled into the artefact.
 *
 * It also means the services do not spawn a process at boot, do not need `git`
 * installed on the host, and cannot be slowed down or hung by it.
 *
 * ── Why the dirty flag is not decoration ────────────────────────────────────
 *
 * `dist/` is gitignored in every package here, so it is never proof of
 * anything by itself, and `status/dist` in particular has been hand-built on
 * the host more than once. A clean-looking sha printed over a tree with
 * uncommitted edits in it is a claim that the running code equals that commit,
 * and it would be false — the same species of quietly-outdated sentence as the
 * banner that started this. So `dirty` is reported, the uncommitted filenames
 * are reported with it, and when git cannot be asked at all the answer is
 * `null` and the banner says UNKNOWN rather than guessing "clean".
 *
 * ── What this does NOT protect against ──────────────────────────────────────
 *
 * Running `tsc` directly, without this script, after the generated file was
 * written at some earlier commit: the new `dist/` would then carry the older
 * sha. Every package wires this into `build`, `typecheck` and `dev` so that the
 * documented path cannot do it, and `ops/`'s host agent is instructed to run
 * `npm run build`. A bare `npx tsc` remains a way to lie to yourself.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *     node ../scripts/build-info.mjs [outFile]
 *
 * `outFile` defaults to `<cwd>/src/build-info.ts`. Every git question is asked
 * with cwd set to the package directory, so git finds the enclosing repository
 * (or worktree) itself and this script works from a temporary checkout in a
 * test exactly as it does from the deployed one.
 *
 * IT NEVER EXITS NON-ZERO. A build that fails because the tree cannot name
 * itself is worse than a build that ships an artefact saying "unknown" — see
 * the same rule at the service end, where an unknown commit must not stop a
 * boot.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** How many uncommitted filenames go into the one-line banner before it stops. */
const DIRTY_NAMES_IN_LINE = 10;

const packageDir = process.cwd();
const outFile = resolve(packageDir, process.argv[2] ?? 'src/build-info.ts');

/**
 * Run git and give back stdout, or the reason it could not be run.
 *
 * `spawnSync` with an argument array: no shell, so nothing here can be
 * confused by a path with a space or a branch name with a quote in it.
 */
function git(args) {
  const result = spawnSync('git', args, {
    cwd: packageDir,
    encoding: 'utf8',
    // A build step must not be able to hang a build. 30s is absurdly generous
    // for `rev-parse` and still finite.
    timeout: 30_000,
  });
  if (result.error) return { ok: false, reason: `git ${args[0]}: ${result.error.message}` };
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim().split('\n')[0] ?? '';
    return { ok: false, reason: `git ${args.join(' ')} exited ${result.status}: ${stderr}` };
  }
  return { ok: true, stdout: result.stdout };
}

/** The package's own name and version, for the banner prefix. Absence is survivable. */
function readPackage() {
  try {
    const parsed = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'));
    return {
      service: typeof parsed.name === 'string' ? parsed.name : '(unnamed package)',
      version: typeof parsed.version === 'string' ? parsed.version : '(no version)',
    };
  } catch {
    return { service: '(no package.json)', version: '(no version)' };
  }
}

const { service, version } = readPackage();
const builtAt = new Date().toISOString();

let commit = null;
let shortCommit = null;
let branch = null;
let repoRoot = null;
let dirty = null;
let dirtyFiles = [];
let unknownReason = null;

const head = git(['rev-parse', 'HEAD']);
if (!head.ok) {
  unknownReason = `${head.reason} (cwd ${packageDir})`;
} else {
  commit = head.stdout.trim();
  shortCommit = commit.slice(0, 7);

  const top = git(['rev-parse', '--show-toplevel']);
  if (top.ok) repoRoot = top.stdout.trim();

  // `--abbrev-ref HEAD` answers the literal string "HEAD" on a detached head,
  // which is not a branch name and must not be printed as one.
  const ref = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (ref.ok) {
    const name = ref.stdout.trim();
    branch = name === 'HEAD' ? null : name;
  }

  // `--porcelain` rather than the prose form: the prose is localised and
  // reformatted between git versions. Paths come back relative to the
  // repository root, which is what a reader of a journal on another machine
  // can act on. Not `-z`, so one record stays one line.
  const status = git(['status', '--porcelain']);
  if (!status.ok) {
    // The commit is known and the tree state is not. Saying "clean" here would
    // be the exact lie this file exists to prevent, so `dirty` stays null and
    // the banner says so.
    unknownReason = `commit known but tree state is not: ${status.reason}`;
  } else {
    dirtyFiles = status.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // Porcelain v1 is `XY <path>`; rename entries are `R  <old> -> <new>`.
      // The status letters go, the rest is kept verbatim including the arrow.
      .map((line) => line.slice(2).trim());
    dirty = dirtyFiles.length > 0;
  }
}

/** The one line every service prints at boot. */
function buildLine() {
  if (commit === null) {
    return (
      `UNKNOWN — ${unknownReason}. This build cannot name the commit it came from, so ` +
      'nothing downstream can tell whether it is current.'
    );
  }

  const where = branch === null ? 'detached HEAD' : branch;
  const stamp = `${shortCommit} (${where}) built ${builtAt}`;

  if (dirty === null) {
    return `${stamp} from a tree of UNKNOWN state — ${unknownReason}`;
  }
  if (!dirty) return `${stamp} from a clean tree`;

  const shown = dirtyFiles.slice(0, DIRTY_NAMES_IN_LINE);
  const rest = dirtyFiles.length - shown.length;
  const more = rest > 0 ? `, and ${rest} more` : '';
  return (
    `${stamp} from a DIRTY tree — ${dirtyFiles.length} uncommitted path(s): ` +
    `${shown.join(', ')}${more}. This artefact is NOT ${shortCommit}.`
  );
}

const info = {
  service,
  version,
  commit,
  shortCommit,
  branch,
  repoRoot,
  dirty,
  dirtyFileCount: dirtyFiles.length,
  dirtyFiles,
  builtAt,
  unknownReason,
  line: buildLine(),
};

const source = `/**
 * GENERATED AT BUILD TIME — do not edit, do not commit.
 *
 * Written by scripts/build-info.mjs, which runs immediately before \`tsc\` in
 * this package's \`build\`, \`typecheck\` and \`dev\` scripts. It is gitignored on
 * purpose: a tracked copy would be rewritten by every build, so every build
 * would dirty the tree, and a dirty tree is what stops \`git pull\` on the host.
 *
 * Read scripts/build-info.mjs for why any of this exists.
 */

export type BuildInfo = {
  /** The package name from package.json, e.g. \`clawcius-status\`. */
  service: string;
  version: string;
  /** Full sha of HEAD at build time, or null if git could not be asked. */
  commit: string | null;
  shortCommit: string | null;
  /** Branch name, or null on a detached HEAD. */
  branch: string | null;
  repoRoot: string | null;
  /**
   * Whether the tree had uncommitted changes when this was compiled.
   *
   * \`null\` means git could not be asked — which is NOT the same as clean and
   * must never be rendered as it.
   */
  dirty: boolean | null;
  dirtyFileCount: number;
  dirtyFiles: string[];
  builtAt: string;
  /** Why the commit or the tree state is unknown. Null when both are known. */
  unknownReason: string | null;
  /** The whole thing as one line, for a boot banner. */
  line: string;
};

export const BUILD_INFO: BuildInfo = ${JSON.stringify(info, null, 2)};
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, source);

if (commit === null || dirty !== false) {
  // stderr, and never a non-zero exit: this is a build that should complete
  // and be visibly suspect, not a build that fails.
  process.stderr.write(`[build-info] ${service}: ${info.line}\n`);
}
