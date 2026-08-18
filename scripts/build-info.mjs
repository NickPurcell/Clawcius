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
 * ── When it fails, and when it refuses to ─────────────────────────────────
 *
 * NOT KNOWING is never a failure. If git is absent, the directory is not a
 * checkout, or `rev-parse` refuses, this writes an artefact that says UNKNOWN
 * and exits 0 — the same rule as at the service end, where an unknown commit
 * must not stop a boot.
 *
 * NOT WRITING is a failure, and deliberately so. If the file cannot be written
 * the build must stop, because `&& tsc` would otherwise compile against
 * whatever `build-info.ts` was left there by an earlier build — which is
 * precisely the stale-identity lie this file exists to prevent, arrived at by a
 * new route. It is not hypothetical on this host: SETUP.md documents a
 * `chown -R` for when a root build gets in first, so root-owned files under the
 * checkout recur, and the host agent's `npm run build` output is what somebody
 * reads about it afterwards. So the error is caught and stated in one sentence
 * naming the file and why it matters, rather than thrown as a raw stack.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * ── Every field here is bounded, and that is a correctness requirement ──────
 *
 * `BUILD_INFO` is not only printed. `src/waker-status.ts` publishes it inside
 * `waker-status.json`, and `ops/src/idle.ts` refuses to parse that file above
 * `MAX_STATUS_BYTES` (8 KiB) — treating anything larger as an implausible write
 * and therefore as BUSY. Because this value is compiled in, an oversized one is
 * not a transient fat write: every publish from that artefact is the same
 * oversized file, so ops would never see that instance idle again for the life
 * of the build, and the journal would blame the waker for a corrupt status file
 * rather than name the field that grew.
 *
 * A dirty tree at build time is exactly the "hand-built on the host" case this
 * whole change is written around, so it is not an exotic input: 262 uncommitted
 * paths produced a 10098-byte status file. Caps, not hope.
 *
 * The arithmetic, worst case, pretty-printed at indent 2:
 *
 *     dirtyFiles     DIRTY_NAMES_KEPT x PATH_MAX
 *     line           DIRTY_NAMES_IN_LINE x PATH_MAX + STRING_MAX + prose
 *     unknownReason  REASON_MAX
 *     repoRoot, branch, service, version   4 x STRING_MAX
 *     commit, shortCommit, keys, structure
 *
 * Measured rather than asserted in prose: test/build-info.test.js reads these
 * five constants out of THIS FILE by name, reads `MAX_STATUS_BYTES` out of
 * ops/src/idle.ts, builds the worst case the former permit and measures it in
 * bytes against the latter. As of 2026-08-18 that is 5311 against 8192.
 *
 * Nothing there is hand-copied, deliberately. A budget test that restates the
 * numbers it protects passes while the thing it protects changes underneath it
 * — which is the same defect as a sweep asserting a remembered list, and this
 * repository has now shipped that shape twice.
 */

/** How many uncommitted filenames go into the one-line banner before it stops. */
const DIRTY_NAMES_IN_LINE = 10;

/**
 * How many are kept in the data.
 *
 * More than the line shows, because the structured field is where somebody
 * looks when the line was not enough — and far fewer than a dirty tree can
 * have, because `dirtyFileCount` is the number that matters and 262 filenames
 * in a status file are not actionable by anyone.
 */
const DIRTY_NAMES_KEPT = 20;

/**
 * Longest any single string in the output may be. Paths are middle-elided.
 *
 * These four are read back out of this file by test/build-info.test.js, which
 * builds the worst case they permit and measures it against the real
 * `MAX_STATUS_BYTES` in ops/src/idle.ts. Raising one here without raising the
 * ceiling there fails that test — so the names and the `const NAME = <digits>;`
 * shape are load-bearing, not incidental.
 */
const STRING_MAX = 200;
const PATH_MAX = 100;

/**
 * Longest failure reason kept, in the one field whose length comes from
 * outside: git's own stderr.
 */
const REASON_MAX = 300;

/**
 * Clip a string to `max`, marking it so a truncated value cannot be mistaken
 * for a short one. Paths lose the middle: the leading directory says which
 * package, the trailing segment says which file, and it is the run of nested
 * directories between them that nobody needs.
 */
function clip(value, max, middle = false) {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  if (!middle) return `${value.slice(0, max - 1)}…`;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

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
/** Every uncommitted path, before the cap. Never emitted; `dirtyFileCount` is. */
let allDirtyFiles = [];
let dirtyFiles = [];
/** `null`, not 0, when the tree state could not be read. See below. */
let dirtyFileCount = null;
let unknownReason = null;

const head = git(['rev-parse', 'HEAD']);
if (!head.ok) {
  unknownReason = `${head.reason} (cwd ${packageDir})`;
} else {
  commit = head.stdout.trim();
  shortCommit = commit.slice(0, 7);

  const top = git(['rev-parse', '--show-toplevel']);
  if (top.ok) repoRoot = clip(top.stdout.trim(), STRING_MAX, true);

  // `--abbrev-ref HEAD` answers the literal string "HEAD" on a detached head,
  // which is not a branch name and must not be printed as one.
  const ref = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (ref.ok) {
    const name = ref.stdout.trim();
    branch = name === 'HEAD' ? null : clip(name, STRING_MAX);
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
    allDirtyFiles = status.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // Porcelain v1 is `XY <path>`; rename entries are `R  <old> -> <new>`.
      // The status letters go, the rest is kept verbatim including the arrow.
      .map((line) => line.slice(2).trim());
    dirty = allDirtyFiles.length > 0;
    // The COUNT is uncapped and authoritative. The LIST is capped, because it
    // is carried inside a status file with a hard size ceiling — see the note
    // on the constants above.
    dirtyFileCount = allDirtyFiles.length;
    dirtyFiles = allDirtyFiles.slice(0, DIRTY_NAMES_KEPT).map((path) => clip(path, PATH_MAX, true));
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

  // Counted off `dirtyFileCount`, never off `dirtyFiles.length` — the array is
  // capped at DIRTY_NAMES_KEPT, so measuring the tree by it would report a
  // 262-file tree as a 20-file one, which is the same species of confident
  // wrong number this whole file exists to stop printing.
  const shown = dirtyFiles.slice(0, DIRTY_NAMES_IN_LINE);
  const rest = dirtyFileCount - shown.length;
  const more = rest > 0 ? `, and ${rest} more` : '';
  return (
    `${stamp} from a DIRTY tree — ${dirtyFileCount} uncommitted path(s): ` +
    `${shown.join(', ')}${more}. This artefact is NOT ${shortCommit}.`
  );
}

const info = {
  service: clip(service, STRING_MAX),
  version: clip(version, STRING_MAX),
  commit,
  shortCommit,
  branch,
  repoRoot,
  dirty,
  // Tracks `dirty`: `null` when git could not be asked. It used to be 0 there,
  // and a 0 sitting beside an unknown reads as reassurance in a field a person
  // scans — "no dirty files" rather than "nobody looked".
  dirtyFileCount,
  dirtyFiles,
  builtAt,
  unknownReason: clip(unknownReason, REASON_MAX),
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
  /**
   * How many paths were uncommitted. Uncapped and authoritative; \`null\`
   * whenever \`dirty\` is null, because a 0 beside an unknown reads as
   * reassurance rather than as "nobody looked".
   */
  dirtyFileCount: number | null;
  /**
   * The first ${DIRTY_NAMES_KEPT} of them, each middle-elided past
   * ${PATH_MAX} characters.
   *
   * CAPPED, and it has to be: this object is published inside
   * \`waker-status.json\`, which \`ops/src/idle.ts\` refuses to parse above 8 KiB
   * and then treats as busy. Use \`dirtyFileCount\` for how many there were.
   */
  dirtyFiles: string[];
  builtAt: string;
  /** Why the commit or the tree state is unknown. Null when both are known. */
  unknownReason: string | null;
  /** The whole thing as one line, for a boot banner. */
  line: string;
};

export const BUILD_INFO: BuildInfo = ${JSON.stringify(info, null, 2)};
`;

// A write failure STOPS THE BUILD, and the message has to explain why that is
// the right outcome — otherwise the obvious next move is to work around it.
// `&& tsc` continuing here would compile against whatever build-info.ts an
// earlier build left behind, which is a stale identity reached by a new route.
try {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, source);
} catch (error) {
  const code = error && error.code ? `${error.code}: ` : '';
  process.stderr.write(
    `[build-info] CANNOT WRITE ${outFile}\n` +
      `[build-info] ${code}${error instanceof Error ? error.message : String(error)}\n` +
      '[build-info] Stopping the build on purpose. Compiling now would bake in whatever\n' +
      '[build-info] identity the previous build left in that file, and a service reporting\n' +
      "[build-info] someone else's commit is the exact failure this generator exists to\n" +
      '[build-info] prevent. On this host the usual cause is a root-owned file from a build\n' +
      '[build-info] that ran as root: see SETUP.md, `sudo chown -R npurcell:npurcell`.\n',
  );
  process.exit(1);
}

if (commit === null || dirty !== false) {
  // stderr, and never a non-zero exit: this is a build that should complete
  // and be visibly suspect, not a build that fails.
  process.stderr.write(`[build-info] ${service}: ${info.line}\n`);
}
