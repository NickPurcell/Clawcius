/**
 * Installing and removing this project's systemd unit files — in code, as root,
 * with an argv this process builds.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS. WRITTEN 2026-08-12, AFTER AN AUDIT OF THE SUDOERS FILE.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Until 2026-08-12 unit files were installed by the host agent session itself,
 * through two sudo rules:
 *
 *     /usr/bin/install -m 0644 -o root -g root * /etc/systemd/system/clawcius*.service
 *     /usr/bin/rm -f /etc/systemd/system/clawcius*.service
 *
 * and a paragraph above them said "a unit file arrives 0644 root:root or it does
 * not arrive". That sentence was false, and the two rules together were a
 * one-command path to unrestricted root. Both facts were established by a
 * six-lens adversarial audit on 2026-08-12 and then reproduced by hand against
 * `fnmatch(3)` and GNU coreutils 9.1. The mechanism, because it is the thing to
 * remember rather than the specific strings:
 *
 *   **sudo joins the arguments into ONE string and `fnmatch()`es it without
 *   FNM_PATHNAME.** So `*` matches spaces, and a `*` sitting in an ARGUMENT
 *   position is not "one argument" — it is "any number of arguments". Whatever
 *   it absorbs is handed to a program that re-parses it as flags.
 *
 * GNU `install` applies repeated flags last-wins, so:
 *
 *   - `install -m 0644 -o root -g root -t /etc/sudoers.d <src> \
 *      /etc/systemd/system/clawciusX.service` matched the rule, and `-t` turns
 *     every remaining operand into a SOURCE. It wrote an attacker-authored file
 *     into /etc/sudoers.d, mode 0644 root:root, which passes sudo's own
 *     secure-file check. `clawcius-ops ALL=(ALL) NOPASSWD: ALL` is one command.
 *     The trailing bogus source makes install exit 1 — after the file has
 *     landed. Reproduced: `install -m 0644 -t dst src dst/missing` copies `src`
 *     and then fails.
 *   - `-m 4755 -t /tmp /bin/bash …` matched too, and `install -m 0644 -m 0777`
 *     really does produce 0777 (verified against coreutils 9.1). Setuid-root
 *     bash, one command.
 *   - the SOURCE was a free `*`, so `install … /root/.ssh/id_ed25519
 *     /etc/systemd/system/clawcius-leak.service` copied any root-only file to a
 *     world-readable path.
 *   - `rm -f /etc/systemd/system/clawciusA.service /var/lib/clawcius-ops/journal.jsonl
 *     /etc/systemd/system/clawciusB.service` matched: the pattern only anchors
 *     the first and last token of the flattened string. That deleted the audit
 *     log, the circuit breaker and every armed rollback deadline — the state the
 *     whole design says nothing can reach.
 *   - and `/etc/systemd/system/clawcius/../ssh.service` matched both rules,
 *     because `*` matches `/` as well, so the "namespaced destination" reached
 *     sshd's unit file and every other one on the box.
 *
 * No `Cmnd_Alias` pattern fixes that in place. Any surviving `*` re-absorbs
 * `-t`/`-m`/`-o`/`-d`, and a wildcard argument spec cannot express
 * "exactly one argument" at all. So the rules are gone, and this file is what
 * stands where they stood.
 *
 * ── Why the executor is allowed to do this and the session is not ────────
 *
 * `clawcius-ops.service` is `User=root`. The executor therefore does not need
 * sudo for anything; it needs sudo rules only because the SESSION it spawns
 * runs as an unprivileged account. This is exactly the argument
 * ops/clawcius-sudoers has always made for `run-container.sh` and
 * `snapshot.sh` — "the executor runs those two scripts itself, as root, with an
 * argv it builds" — applied to the one capability that had been left in sudo.
 *
 * The difference between the two is not that root is involved. It is that here
 * the destination, the mode and the owner are CONSTRUCTED, not matched:
 *
 *   - the unit NAME is the only thing that comes from the agent, and it must
 *     satisfy `UNIT_NAME_PATTERN` — no separators, no `..`, no spaces, no
 *     uppercase, no suffix other than `.service` or `.timer`;
 *   - the destination is `join(unitDir, name)` computed here. There is no path
 *     from agent input to a directory;
 *   - the CONTENT is read from a fixed staging directory, through a descriptor
 *     opened `O_NOFOLLOW`, and every decision is made against `fstat` of that
 *     descriptor rather than against the name. A staging entry that is a symlink
 *     to `/root/.ssh/id_ed25519` is refused rather than published into a
 *     world-readable unit file (CWE-59);
 *   - the mode is 0644 and the owner is 0:0 because this code sets them on the
 *     file descriptor it wrote, not because a pattern in a text file asked
 *     politely.
 *
 * ── What this still does NOT prevent, stated rather than discovered ──────
 *
 * The unit's CONTENT is authored by the session. Installing a unit whose
 * ExecStart is anything, then `systemctl daemon-reload` and `systemctl restart
 * clawcius.service` — both of which the session may still do — is root. That
 * escalation is the documented trade and it has not changed; what has changed is
 * that it is now the ONLY one, that it takes three steps that are each in the
 * journal, and that it can no longer be turned into an arbitrary root write of
 * an arbitrary file at an arbitrary path in a single command.
 *
 * Two things narrow it further, and both are refusals rather than warnings:
 *
 *   - `PROTECTED_UNITS`. The executor's own unit is not installable or
 *     removable through here. Overwriting clawcius-ops.service is root at the
 *     next boot with nothing watching, and the session already cannot restart
 *     it. Deploying a change to that one unit is the operator's job, by hand,
 *     which is the same answer the sudoers file gives for restarting it.
 *   - `UNIT_PREFIXES`. A name must belong to this project. Without that,
 *     `ssh.service` in /etc/systemd/system overrides /lib/systemd/system/ssh.service
 *     and the whole "sshd is DELIBERATELY ABSENT" argument evaporates — which is
 *     precisely what the `..` climb-out bought the adversary before.
 */

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';

/**
 * The only shape a unit name may have.
 *
 * Lowercase, starts with a letter or a digit, then letters, digits and hyphens,
 * then exactly `.service` or `.timer`. It admits no `/`, no `.`, no `..`, no
 * space, no NUL and no leading `-` (which several coreutils would read as a
 * flag). Those are also checked one at a time below, before this pattern, so
 * that the refusal names the thing that was wrong instead of saying "does not
 * match a regex" — the message is read by an agent that then has to decide
 * whether it made a typo or is being told no.
 */
export const UNIT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*\.(service|timer)$/;

/** Longest unit name accepted. systemd's own limit is 255 including the suffix. */
export const MAX_UNIT_NAME = 96;

/**
 * Unit names this project owns.
 *
 * A name must be one of these exactly, or one of these followed by `-`. So
 * `clawcius.service`, `clawcius-status.service` and `oj-container.service` are
 * in; `clawciusfoo.service` is not, and neither is `ssh.service`,
 * `sshd.service` or `docker.service`.
 *
 * The old sudoers rule expressed this as `/etc/systemd/system/clawcius*.service`
 * and got two things wrong that a glob cannot get right: `*` matched `/` (so
 * `clawcius/../ssh.service` was "namespaced"), and `clawcius*` also matched
 * `clawcius-ops.service`, this daemon's own unit.
 */
export const UNIT_PREFIXES = ['clawcius', 'hamachi', 'oj'] as const;

/**
 * Units that may not be installed or removed by a task, at all.
 *
 * There is exactly one, and it is the process running this code. See the header.
 */
export const PROTECTED_UNITS = ['clawcius-ops.service'] as const;

/** Largest unit file accepted. A systemd unit is a few hundred bytes. */
export const MAX_UNIT_BYTES = 64 * 1024;

/** Largest unit-op request file accepted. It holds two short strings. */
const MAX_REQUEST_BYTES = 4096;

/** Request file names the desk will even look at. Same rule as the ops spool. */
const REQUEST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

/**
 * Where the session stages unit content, asks for it to be installed, and reads
 * the answer.
 *
 * All three are under `hostAgent.workDir`, which the executor creates and chowns
 * to the agent account before every task. Deliberately NOT under `stateDir`:
 * that directory holds journal.jsonl, the breaker and the armed deadlines, is
 * 0750 root-owned, and the one invariant this whole rework restored is that
 * nothing the session can reach touches it.
 */
export function unitStagingDir(workDir: string): string {
  return join(workDir, 'units');
}

export function unitRequestDir(workDir: string): string {
  return join(workDir, 'unit-requests');
}

export function unitResultDir(workDir: string): string {
  return join(workDir, 'unit-results');
}

export type UnitOp = 'install' | 'remove';

/** What one install or remove did, or refused to do, and why. */
export type UnitOpResult = {
  ok: boolean;
  op: UnitOp;
  /** The name as asked for, clipped for the log. Never used to build a path unless it validated. */
  unit: string;
  /** The destination this code computed, or '' if the name never validated. */
  path: string;
  /** Prose for the journal and for the agent. Always says why. */
  detail: string;
  /** True when nothing was touched because this is a dry run. */
  skipped: boolean;
};

export type UnitOpOptions = {
  unit: string;
  /** `/etc/systemd/system` on the host; a temp directory in the self-test. */
  unitDir: string;
  /** Fixed. The content comes from `join(stagingDir, unit)` and nowhere else. */
  stagingDir: string;
  dryRun: boolean;
};

type NameVerdict = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Is this a unit name this executor will act on?
 *
 * Pure, exported, and the first thing every path here calls. The order of the
 * checks is deliberate: the specific, nameable failures come first so that the
 * refusal explains itself, and the pattern is the backstop that catches
 * everything nobody thought of. Both halves matter — a list of named checks
 * alone would be a denylist, and a regex alone would produce refusals an agent
 * would try to route around because it could not tell what was wrong.
 */
export function validateUnitName(unit: unknown): NameVerdict {
  if (typeof unit !== 'string') {
    return { ok: false, reason: `unit must be a string, not ${typeof unit}` };
  }
  if (unit.length === 0) return { ok: false, reason: 'unit name is empty' };
  if (unit.length > MAX_UNIT_NAME) {
    return {
      ok: false,
      reason: `unit name is ${unit.length} characters; the ceiling is ${MAX_UNIT_NAME}`,
    };
  }
  if (unit.includes('/') || unit.includes('\\')) {
    return {
      ok: false,
      reason:
        `"${clip(unit)}" contains a path separator. A unit name is a NAME: the destination ` +
        'directory is built by this executor and cannot be chosen by a task.',
    };
  }
  if (unit.includes('..')) {
    return {
      ok: false,
      reason:
        `"${clip(unit)}" contains "..". Traversal is refused rather than resolved — the ` +
        'sudoers rule this replaced accepted /etc/systemd/system/clawcius/../ssh.service, ' +
        'which is how a namespaced destination reached sshd.',
    };
  }
  if (/\s/.test(unit)) {
    return {
      ok: false,
      reason:
        `"${clip(unit)}" contains whitespace. That is exactly what defeated the old sudo ` +
        'rule: sudo joins argv with spaces before matching, so a wildcard that matches a ' +
        'space matches any number of extra arguments.',
    };
  }
  if (/[\u0000-\u001f\u007f]/.test(unit)) {
    return { ok: false, reason: 'unit name contains a control character or NUL' };
  }
  if (unit.startsWith('-')) {
    return {
      ok: false,
      reason: `"${clip(unit)}" starts with "-", which several programs would read as a flag`,
    };
  }
  if (!UNIT_NAME_PATTERN.test(unit)) {
    return {
      ok: false,
      reason:
        `"${clip(unit)}" is not a unit name this executor will install. It must match ` +
        `${String(UNIT_NAME_PATTERN)} — lowercase, and ending in .service or .timer. ` +
        'Drop-ins (.d/override.conf), .socket, .mount, .path and .target are not installable ' +
        'from a task: each of them reaches parts of the base system this project does not own.',
    };
  }
  if ((PROTECTED_UNITS as readonly string[]).includes(unit)) {
    return {
      ok: false,
      reason:
        `${unit} is this executor's own unit and is refused. Rewriting it is root at the ` +
        'next boot with nothing watching, and the session already cannot restart it. If it ' +
        'genuinely needs to change, say so in your report and let the operator install it.',
    };
  }
  const base = unit.replace(/\.(service|timer)$/, '');
  const owned = UNIT_PREFIXES.some((prefix) => base === prefix || base.startsWith(`${prefix}-`));
  if (!owned) {
    return {
      ok: false,
      reason:
        `"${unit}" is not one of this project's units. A name must be ` +
        `${UNIT_PREFIXES.join(', ')} exactly, or one of those followed by "-". A unit file ` +
        'in /etc/systemd/system OVERRIDES the one in /lib/systemd/system, so without this ' +
        'check installing "ssh.service" would replace sshd — which is the thing the sudoers ' +
        'file spends two paragraphs saying is out of reach.',
    };
  }
  return { ok: true, name: unit };
}

/**
 * Install one unit file: fixed source directory, computed destination, mode and
 * ownership set on the descriptor.
 *
 * Written to a temporary file in the destination directory and renamed, so
 * systemd never sees a half-written unit, and so a failure part-way leaves the
 * previous unit exactly as it was.
 */
export function installUnit(options: UnitOpOptions): UnitOpResult {
  const verdict = validateUnitName(options.unit);
  if (!verdict.ok) return refusal('install', options.unit, verdict.reason);
  const name = verdict.name;
  const path = join(options.unitDir, name);
  const source = join(options.stagingDir, name);

  const dirProblem = realDirectoryProblem(options.stagingDir);
  if (dirProblem) {
    return refusal('install', name, `staging directory ${options.stagingDir}: ${dirProblem}`, path);
  }

  // Opened O_NOFOLLOW, and every decision made against the descriptor rather
  // than the path. This directory is owned by the agent account: the name
  // `clawcius-x.service` in it can be a symlink to anything root can read, and
  // following it would publish /root/.ssh/id_ed25519 into a world-readable unit
  // file — which is one of the exact exploits the sudo rule permitted.
  // O_NONBLOCK so that a FIFO with the right name is an error rather than a
  // read that parks this daemon and every deadline it is holding.
  let fd: number;
  try {
    fd = openSync(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    return refusal(
      'install',
      name,
      `could not open ${source} as a plain file (${String(error)}). Stage the unit's content ` +
        `at that exact path first — a symlink, a FIFO or a missing file is refused, not followed.`,
      path,
    );
  }

  let content: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return refusal('install', name, `${source} is not a regular file`, path);
    if (stat.nlink !== 1) {
      return refusal(
        'install',
        name,
        `${source} has ${stat.nlink} links. A hard link is the symlink attack without the ` +
          'symlink, and a staged unit has no reason to be one.',
        path,
      );
    }
    if (stat.size === 0) return refusal('install', name, `${source} is empty`, path);
    if (stat.size > MAX_UNIT_BYTES) {
      return refusal(
        'install',
        name,
        `${source} is ${stat.size} bytes, over the ${MAX_UNIT_BYTES}-byte ceiling. It was ` +
          'not read.',
        path,
      );
    }
    content = readFileSync(fd, 'utf8');
  } catch (error) {
    return refusal('install', name, `could not read ${source}: ${String(error)}`, path);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* nothing useful to do about a failed close */
    }
  }

  const contentProblem = unitContentProblem(content);
  if (contentProblem) return refusal('install', name, `${source}: ${contentProblem}`, path);

  // A symlink or a directory where the unit belongs is refused rather than
  // replaced. `rename(2)` would replace a symlink without following it, so this
  // is not strictly necessary for safety — it is here because something else
  // put that there, and quietly overwriting it would destroy the evidence.
  //
  // Checked BEFORE the dry-run return, deliberately: a dry run exists to tell
  // you what a live run would do, and one that reported "would have installed"
  // where the live run refuses is worse than no dry run at all. Everything above
  // this point is likewise a read, so the whole refusal set is identical in both
  // modes and only the write is skipped.
  const existing = lstatOrNull(path);
  if (existing && !existing.isFile()) {
    return refusal(
      'install',
      name,
      `${path} exists and is not a regular file (it is ${describe(existing)}). Refusing to ` +
        'replace it; look at what it is.',
      path,
    );
  }

  if (options.dryRun) {
    return {
      ok: true,
      op: 'install',
      unit: name,
      path,
      skipped: true,
      detail:
        `DRY RUN — would have installed ${content.length} bytes from ${source} to ${path} ` +
        'as 0644 root:root. Nothing was written.',
    };
  }

  const temp = join(options.unitDir, `.${name}.tmp`);
  try {
    unlinkSync(temp);
  } catch {
    /* it was not there, which is the normal case */
  }

  let out: number;
  try {
    out = openSync(
      temp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    return refusal('install', name, `could not create ${temp}: ${String(error)}`, path);
  }

  try {
    writeSync(out, content);
    // Set on the DESCRIPTOR, not on the path, and this is the line that makes
    // "a unit file arrives 0644 root:root or it does not arrive" a true
    // sentence for the first time. The sudoers rule that used to claim it was
    // pinning the mode was passing `-m 0644` to a command whose wildcard could
    // carry a second `-m 4755`.
    fchmodSync(out, 0o644);
    if (process.getuid?.() === 0) {
      fchownSync(out, 0, 0);
    }
    fsyncSync(out);
  } catch (error) {
    try {
      closeSync(out);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(temp);
    } catch {
      /* ignore */
    }
    return refusal('install', name, `could not write ${temp}: ${String(error)}`, path);
  }
  try {
    closeSync(out);
  } catch {
    /* ignore */
  }

  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* ignore */
    }
    return refusal('install', name, `could not put ${temp} in place at ${path}: ${String(error)}`, path);
  }

  syncDir(options.unitDir);

  const asRoot = process.getuid?.() === 0;
  return {
    ok: true,
    op: 'install',
    unit: name,
    path,
    skipped: false,
    detail:
      `installed ${content.length} bytes from ${source} to ${path}, mode 0644` +
      (asRoot
        ? ', owner root:root'
        : `, owner left as uid ${String(process.getuid?.() ?? -1)} because this executor is ` +
          'NOT running as root. On the host it is (clawcius-ops.service is User=root); if you ' +
          'are seeing this on the host, that is the finding.') +
      '. Run `sudo systemctl daemon-reload` before starting or restarting it.',
  };
}

/** Remove one of this project's unit files. Same validation, same anchoring. */
export function removeUnit(options: UnitOpOptions): UnitOpResult {
  const verdict = validateUnitName(options.unit);
  if (!verdict.ok) return refusal('remove', options.unit, verdict.reason);
  const name = verdict.name;
  const path = join(options.unitDir, name);

  const existing = lstatOrNull(path);
  if (!existing) {
    return refusal('remove', name, `${path} is not installed; nothing to remove`, path);
  }
  if (!existing.isFile()) {
    return refusal(
      'remove',
      name,
      `${path} is not a regular file (it is ${describe(existing)}). Refusing to unlink it — ` +
        'something put it there and that is worth looking at before it disappears.',
      path,
    );
  }

  if (options.dryRun) {
    return {
      ok: true,
      op: 'remove',
      unit: name,
      path,
      skipped: true,
      detail: `DRY RUN — would have removed ${path}. Nothing was deleted.`,
    };
  }

  try {
    unlinkSync(path);
  } catch (error) {
    return refusal('remove', name, `could not remove ${path}: ${String(error)}`, path);
  }
  syncDir(options.unitDir);
  return {
    ok: true,
    op: 'remove',
    unit: name,
    path,
    skipped: false,
    detail:
      `removed ${path}. Run \`sudo systemctl daemon-reload\` so systemd forgets it, and stop ` +
      'it first if it is running.',
  };
}

// ── The desk: how a session asks for one of the two operations above ──────

export type UnitDeskOptions = {
  /** `<workDir>/unit-requests`. Agent-owned; the executor drains it. */
  requestDir: string;
  /** `<workDir>/unit-results`. The executor writes here; the agent reads. */
  resultDir: string;
  unitDir: string;
  stagingDir: string;
  dryRun: boolean;
  /** Ceiling on operations per drain. Bounds a session that loops. */
  max: number;
  onLog: (line: string) => void;
};

/**
 * Read every pending request, act on it, and write the answer back.
 *
 * ── Why a directory and not a tool ───────────────────────────────────────
 *
 * The session is a Claude Code process with a shell, spawned by this daemon and
 * dropped to an unprivileged account. There is no channel from it back to the
 * executor except the filesystem and the stdout stream, and the stdout stream is
 * the audit — it is read, never answered. A directory of small JSON files is the
 * same mechanism the ops spool already uses between the containers and this
 * daemon, with the same defences, and it has the property that matters: the
 * request says WHICH unit, and nothing else. It cannot say where, or with what
 * mode, or as whom.
 *
 * Everything hostile-input-shaped about it is handled the way the retired ops
 * spool handled the same problem, which is where these rules were worked out:
 * implausible names discarded unread, size checked on the descriptor rather than
 * on the path, `O_NOFOLLOW | O_NONBLOCK`, and the file unlinked BEFORE it is
 * acted on so that a request which throws cannot come back on the next drain.
 * This is now the only directory-as-a-queue left in the repository.
 *
 * This is NOT "the host agent ingesting untrusted content" in the sense
 * host-agent.ts forbids: nothing read here reaches a prompt. It reaches
 * `validateUnitName`, and the two things it can say are the name of a unit and
 * which of two verbs to apply to it.
 */
export function drainUnitRequests(options: UnitDeskOptions): UnitOpResult[] {
  const results: UnitOpResult[] = [];

  const problem = realDirectoryProblem(options.requestDir);
  if (problem) {
    // Missing is the ordinary case: most tasks never install a unit. Anything
    // else — a symlink, a file — is refused loudly, because the only party who
    // could have put it there is the session.
    if (problem !== 'does not exist') {
      options.onLog(`unit request directory ${options.requestDir}: ${problem}; not drained`);
    }
    return results;
  }

  let names: string[];
  try {
    names = readdirSync(options.requestDir).sort();
  } catch (error) {
    options.onLog(`could not read ${options.requestDir}: ${String(error)}`);
    return results;
  }

  for (const name of names) {
    if (results.length >= options.max) {
      options.onLog(
        `unit-op ceiling reached (${options.max} in one drain); ` +
          `${names.length - results.length} request(s) left where they are`,
      );
      break;
    }
    const path = join(options.requestDir, name);
    if (!REQUEST_NAME_PATTERN.test(name)) {
      options.onLog(`${name}: implausible unit-request file name, discarded unread`);
      discard(path);
      continue;
    }

    const body = readSmallFile(path, MAX_REQUEST_BYTES, options.onLog);
    // Removed before it is acted on, like an ops request. A request that throws
    // must not be retried forever, least of all a removal.
    discard(path);
    if (body === null) continue;

    const parsed = parseUnitRequest(body);
    const result = !parsed.ok
      ? refusal('install', '', parsed.reason)
      : parsed.op === 'install'
        ? installUnit({
            unit: parsed.unit,
            unitDir: options.unitDir,
            stagingDir: options.stagingDir,
            dryRun: options.dryRun,
          })
        : removeUnit({
            unit: parsed.unit,
            unitDir: options.unitDir,
            stagingDir: options.stagingDir,
            dryRun: options.dryRun,
          });

    results.push(result);
    writeResult(options.resultDir, name, result, options.onLog);
  }

  return results;
}

type ParsedUnitRequest =
  | { ok: true; op: UnitOp; unit: string }
  | { ok: false; reason: string };

/**
 * `{"op":"install","unit":"clawcius-status.service"}` and nothing else.
 *
 * Structural rejection, never repair. Malformed JSON is discarded whole,
 * nothing salvages the parseable prefix of a broken file, and nothing coerces
 * types — a number where a string belongs is a reject. An unknown key is a
 * rejection here rather than a logged curiosity, because this object has
 * exactly two fields and there is no forward-compatibility story to protect.
 */
export function parseUnitRequest(body: string): ParsedUnitRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { ok: false, reason: `not JSON (${String(error)}); discarded whole` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'a unit request must be a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== 'op' && key !== 'unit');
  if (extra.length > 0) {
    return {
      ok: false,
      reason:
        `unknown field(s): ${extra.join(', ')}. A unit request carries "op" and "unit" and ` +
        'nothing else — in particular it cannot carry a path, a mode or an owner, which is ' +
        'the whole reason this replaced a sudo rule.',
    };
  }
  const op = record['op'];
  if (op !== 'install' && op !== 'remove') {
    return { ok: false, reason: `"op" must be "install" or "remove", not ${JSON.stringify(op)}` };
  }
  const verdict = validateUnitName(record['unit']);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, op, unit: verdict.name };
}

// ── Small shared helpers ──────────────────────────────────────────────────

function refusal(op: UnitOp, unit: string, reason: string, path = ''): UnitOpResult {
  return { ok: false, op, unit: clip(unit), path, detail: `REFUSED: ${reason}`, skipped: false };
}

function clip(value: string): string {
  return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

function describe(stat: Stats): string {
  if (stat.isSymbolicLink()) return 'a symlink';
  if (stat.isDirectory()) return 'a directory';
  if (stat.isFIFO()) return 'a FIFO';
  if (stat.isSocket()) return 'a socket';
  if (stat.isBlockDevice() || stat.isCharacterDevice()) return 'a device node';
  return 'not a regular file';
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

/** '' if this is a real directory; otherwise what it is instead. */
function realDirectoryProblem(path: string): string {
  const stat = lstatOrNull(path);
  if (!stat) return 'does not exist';
  if (stat.isSymbolicLink()) {
    return 'it is a symlink, which is refused rather than followed (CWE-59)';
  }
  if (!stat.isDirectory()) return `it is ${describe(stat)}`;
  return '';
}

/**
 * A unit file has sections. A blob with none of them is not one.
 *
 * Cheap, and it catches the case worth catching: something that is not a unit
 * file at all being published into /etc/systemd/system under a unit name.
 */
function unitContentProblem(content: string): string {
  if (content.includes('\u0000')) return 'contains a NUL byte, so it is not a unit file';
  if (!/^\s*\[[A-Za-z]+\]\s*$/m.test(content)) {
    return 'has no [Section] header, so it is not a systemd unit file';
  }
  return '';
}

function readSmallFile(path: string, cap: number, onLog: (line: string) => void): string | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    onLog(`${path}: could not open as a plain file (${String(error)}), discarded`);
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      onLog(`${path}: not a regular file, discarded unread`);
      return null;
    }
    if (stat.size > cap) {
      onLog(`${path}: ${stat.size} bytes exceeds the ${cap}-byte cap, discarded unread`);
      return null;
    }
    return readFileSync(fd, 'utf8');
  } catch (error) {
    onLog(`${path}: could not read (${String(error)})`);
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Hand the answer back where the session can read it.
 *
 * Best-effort on purpose: the operation has already happened and is already in
 * the journal, which is the record that matters. A failure to write the reply is
 * logged and does not turn a completed install into a failure.
 */
function writeResult(
  resultDir: string,
  name: string,
  result: UnitOpResult,
  onLog: (line: string) => void,
): void {
  if (realDirectoryProblem(resultDir)) return;
  try {
    writeFileSync(
      join(resultDir, name),
      `${JSON.stringify({ ok: result.ok, op: result.op, unit: result.unit, path: result.path, detail: result.detail }, null, 2)}\n`,
      { mode: 0o644 },
    );
  } catch (error) {
    onLog(`could not write the unit-op result for ${name}: ${String(error)}`);
  }
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[ops] could not remove ${path}: ${String(error)}\n`);
    }
  }
}

/** fsync the directory so a rename or unlink survives a power cut. Best effort. */
function syncDir(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    /* not every filesystem allows it; the rename already happened */
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}
