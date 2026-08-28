#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** How many uncommitted filenames go into the one-line banner before it stops. */
const DIRTY_NAMES_IN_LINE = 10;

/** How many are kept in the data. */
const DIRTY_NAMES_KEPT = 20;

/** Longest any single string in the output may be. */
const STRING_MAX = 200;
const PATH_MAX = 100;

/** Longest failure reason kept, in the one field whose length comes from outside: git's own stderr. */
const REASON_MAX = 300;

/** Clip a string to `max`, marking it so a truncated value cannot be mistaken for a short one. */
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

/** Run git and give back stdout, or the reason it could not be run. */
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

  // `--porcelain` rather than the prose form: the prose is localised and reformatted between git versions.
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

  // Counted off `dirtyFileCount`, never off `dirtyFiles.length`: the array is capped at DIRTY_NAMES_KEPT.
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
