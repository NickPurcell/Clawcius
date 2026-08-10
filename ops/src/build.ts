/**
 * Building a checkout before anything is restarted onto it.
 *
 * ── Why this file exists at all ──────────────────────────────────────────
 *
 * Every service in this repository is started as `node dist/index.js`. Not one
 * unit compiles anything: `clawcius.service`, `hamachi.service` and
 * `clawcius-status.service` all exec a *build artefact*, and nothing in systemd
 * produces it. The build is a thing a human used to do by hand between the pull
 * and the restart, and it was never written down as a step because it was never
 * a step — it was a habit.
 *
 * On 2026-08-09 the habit was skipped. The always-on-channels change was
 * merged, `ops-config.yaml` and `agent-config.yaml` were both correct, the
 * checkout was pulled, `systemctl restart clawcius` returned 0, and the feature
 * did nothing at all for an hour. `dist/` was still yesterday's. Nothing failed;
 * nothing logged; the unit was `active (running)` the whole time. The tell,
 * eventually, was that the *config* warning about unreachable always-on
 * channels never appeared in the journal — code that had been merged was simply
 * not on the machine.
 *
 * That hour was the cost of a human doing pull-then-restart once. The first
 * draft of this executor exposed `pull` and `restart` as separate verbs with no
 * build between them, which does not merely permit that mistake — it is a
 * machine that makes it, on request, in about four seconds, as often as asked.
 * An agent wiring "pull, then restart" into a redeploy loop would reproduce the
 * silent no-op perfectly and far faster than anyone could notice.
 *
 * So the build is no longer a habit. It is a step in the `pull` and `redeploy`
 * verbs, it runs `npm ci && npm run build` exactly as `package.json` defines
 * them, and if it fails the operation stops there. Nothing gets restarted onto
 * a stale `dist/`, and — the case that is actually worse — nothing gets
 * restarted onto a *half-built* one, where `tsc` emitted four files out of
 * thirty before it hit the error.
 *
 * ── Why it drops privileges ──────────────────────────────────────────────
 *
 * `clawcius-ops.service` is `User=root`. The checkout is `/home/npurcell/clawcius`
 * and `clawcius.service`, `hamachi.service` and `clawcius-status.service` all
 * run as `User=npurcell`. A build run as root leaves root-owned `node_modules/`
 * and `dist/` behind, and every one of those services then fails to start with
 * an EACCES that names a file nobody edited.
 *
 * That happened twice on the night of 2026-08-09, by hand, before anyone
 * connected the two facts — the second time only ten minutes after `chown -R`
 * had fixed the first, because the fix was applied to the symptom and the root
 * `npm ci` was run again. It is a particularly nasty failure because the build
 * *succeeds*: the exit code is 0, `dist/` is complete and correct, and the
 * damage is in the file metadata rather than in anything the build reports.
 *
 * So the owner is discovered by `stat`ing the checkout — never hardcoded,
 * because the executor is not entitled to an opinion about who owns a directory
 * it was pointed at — and the build runs as that uid/gid. If the owner cannot
 * be determined, or the drop cannot be performed, the build is refused. Running
 * it as root anyway is the failure this is here to prevent.
 *
 * ── Why the drop is setuid(2) and not sudo or su ─────────────────────────
 *
 * `sudo` and `su` are setuid binaries, and a setuid bit is exactly what
 * `NoNewPrivileges=true` turns into a no-op. Under NNP the kernel refuses to
 * grant the privilege transition at `execve`, so `sudo -u npurcell npm ci`
 * fails with a message about being unable to set the effective uid — and it
 * fails whether or not the caller is already root, which makes it look like a
 * permissions bug rather than a unit setting.
 *
 * A `setuid(2)` performed by an already-root process is a different operation:
 * it *drops* privilege, it happens before `execve`, and `NoNewPrivileges` has
 * no bearing on it. So the drop is done with the `uid`/`gid` spawn options,
 * which is what `Runner` passes to `execFile`, and this file needs no setuid
 * helper, no sudoers rule and no shell. The unit does not have to weaken
 * `NoNewPrivileges` to make the build work; see `systemd/clawcius-ops.service`
 * for what it does have to do instead, which is stop making /home read-only.
 *
 * Honest limitation, in the same spirit as the rest of this codebase: the
 * spawn options set the gid and the uid but do not call `setgroups(2)`, so the
 * build inherits root's supplementary group list (in practice just `root`).
 * Files it creates are owned `npurcell:npurcell` — which is the property that
 * matters here — but the process is not as thoroughly unprivileged as a real
 * login would be. Fixing that properly means `setpriv --clear-groups`, which
 * is another binary to depend on and another thing that has never been run on
 * this host; noted rather than half-done.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { OpsConfig, RepoEntry } from './config.js';
import type { Runner, CommandResult } from './runner.js';
import { summarise } from './runner.js';

/** Where the owning user's name and home directory are looked up. */
const PASSWD_PATH = '/etc/passwd';

export type BuildOwner = {
  uid: number;
  gid: number;
  /** Login name, for the log. Never interpolated into a command. */
  user: string;
  /** The owner's home, which becomes HOME and the npm cache root. */
  home: string;
};

export type OwnerResult =
  | { ok: true; owner: BuildOwner; drop: boolean }
  | { ok: false; reason: string };

/**
 * Who owns the checkout, and can this process become them?
 *
 * `drop` is false when the executor is already running as the owner — which is
 * the case in the self-test, and would be the case on a host where someone
 * decided the executor should not be root. Nothing is dropped in that case
 * because there is nothing to drop; the build simply runs as the process
 * already is, which by definition produces correctly-owned files.
 *
 * Everything else is a refusal. In particular: a non-root executor that is not
 * the owner cannot become the owner, and saying so is the whole point — the
 * alternative is a build that succeeds and leaves a service that will not
 * start.
 */
export function resolveOwner(dir: string, passwdPath: string = PASSWD_PATH): OwnerResult {
  let uid: number;
  let gid: number;
  try {
    const stat = statSync(dir);
    uid = stat.uid;
    gid = stat.gid;
  } catch (error) {
    return {
      ok: false,
      reason:
        `cannot stat ${dir} to find out who owns it: ${String(error)}. Refusing to build — ` +
        'a build run as the wrong user leaves root-owned node_modules/ and dist/ behind, ' +
        'and every service that runs as a person then fails to start with an EACCES ' +
        'naming a file nobody edited.',
    };
  }

  const passwd = lookupPasswd(uid, passwdPath);
  if (!passwd) {
    return {
      ok: false,
      reason:
        `${dir} is owned by uid ${uid}, which has no entry in ${passwdPath}. Refusing to ` +
        'build: without a passwd entry there is no home directory to point HOME and the ' +
        'npm cache at, and npm would fall back to the running user\'s — which is root\'s.',
    };
  }

  const me = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (me === uid) {
    return { ok: true, drop: false, owner: { uid, gid, user: passwd.user, home: passwd.home } };
  }
  if (me !== 0) {
    return {
      ok: false,
      reason:
        `${dir} is owned by ${passwd.user} (uid ${uid}) but this process runs as uid ${me}, ` +
        'which cannot become another user. Refusing to build rather than building as the ' +
        'wrong user.',
    };
  }

  return { ok: true, drop: true, owner: { uid, gid, user: passwd.user, home: passwd.home } };
}

/**
 * getpwuid, by hand.
 *
 * Node exposes `os.userInfo()` for the *current* user and nothing at all for an
 * arbitrary uid, so the file gets parsed. Fields are name:passwd:uid:gid:gecos:home:shell
 * and a line with fewer than seven of them is not a passwd line and is skipped
 * rather than guessed at. Hosts using nsswitch with a non-file backend will not
 * be found here, which surfaces as the loud refusal above rather than as a
 * build that runs as somebody unexpected.
 */
function lookupPasswd(uid: number, passwdPath: string): { user: string; home: string } | null {
  let text: string;
  try {
    text = readFileSync(passwdPath, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(':');
    if (fields.length < 7) continue;
    if (Number(fields[2]) !== uid) continue;
    const user = fields[0] ?? '';
    const home = fields[5] ?? '';
    if (!user || !home) continue;
    return { user, home };
  }
  return null;
}

export type BuildStep = {
  /** For the journal: `npm ci in ops`. Never re-parsed. */
  label: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** Present only when the executor is dropping privilege for this step. */
  uid?: number;
  gid?: number;
  timeoutSeconds: number;
};

/**
 * The commands, in order, with nothing left implicit.
 *
 * Pure — it decides and returns, it does not execute — so the self-test can
 * assert on the ordering, the working directories and the uid/gid without a
 * root process and without npm installed. That matters more than usual here:
 * the interesting properties of this function are "the build comes before the
 * restart" and "the build does not run as root", and both are statements about
 * a plan rather than about an outcome.
 *
 * `npm ci`, not `npm install`. `ci` deletes `node_modules/` and installs
 * exactly what `package-lock.json` says, which is the only form of the command
 * whose result does not depend on what happened to be installed before it. An
 * unattended root daemon silently rewriting a lockfile — which is what `npm
 * install` does when it feels the lockfile is out of date — is a change nobody
 * reviewed arriving in a checkout that is about to be deployed.
 */
export function planBuild(
  config: OpsConfig,
  repo: RepoEntry,
  owner: BuildOwner,
  drop: boolean,
): BuildStep[] {
  // npm re-execs node and runs `tsc` out of node_modules/.bin through sh, so
  // the directory npm itself lives in has to be on PATH. It is not on the
  // system PATH on this host — node is installed under the owner's home — and
  // without this the build fails at `npm run build` with "tsc: not found",
  // several minutes after `npm ci` succeeded.
  const nodeBin = dirname(config.npmPath);
  const env: Record<string, string> = {
    PATH: `${nodeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: owner.home,
    // Set explicitly rather than left to npm's HOME-relative default. The
    // default is correct given the HOME above, and stating it anyway means a
    // future change to how HOME is derived cannot quietly send a root-run
    // build's cache into /root/.npm — the same class of mistake as the
    // root-owned node_modules this whole file exists for.
    npm_config_cache: join(owner.home, '.npm'),
    // Nothing here has a terminal and nothing here should be phoning home for
    // a version banner mid-deploy.
    NO_UPDATE_NOTIFIER: '1',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    CI: '1',
  };

  const steps: BuildStep[] = [];
  for (const relative of repo.buildDirs) {
    const cwd = resolve(repo.path, relative);
    const where = relative === '.' ? repo.name : `${repo.name}/${relative}`;
    for (const [label, argv] of [
      [`npm ci in ${where}`, [config.npmPath, 'ci']],
      [`npm run build in ${where}`, [config.npmPath, 'run', 'build']],
    ] as Array<[string, string[]]>) {
      steps.push({
        label,
        argv,
        cwd,
        env,
        ...(drop ? { uid: owner.uid, gid: owner.gid } : {}),
        // Generous. `npm ci` on a cold cache pulls a few hundred packages over
        // a proxied link, and a timeout that fires mid-install leaves a
        // node_modules/ that is neither the old one nor the new one — which is
        // precisely the half-built state the caller is being protected from.
        timeoutSeconds: config.limits.buildTimeoutSeconds,
      });
    }
  }
  return steps;
}

export type BuildOutcome = {
  ok: boolean;
  /** Prose for the journal. Always says which step failed and what it means. */
  detail: string;
  /** Labels of the steps actually attempted, in order. */
  ran: string[];
  owner: BuildOwner | null;
};

/**
 * Run the plan, stopping at the first failure.
 *
 * `run`, not `probe`, so `dryRun` suppresses it like every other mutating
 * command — a dry run that quietly reinstalled node_modules and rewrote dist/
 * would be the single most surprising thing this daemon could do, given the
 * whole promise of the mode is that it changes nothing.
 *
 * Suppressed steps still walk the plan and still log the exact argv, the cwd
 * and the uid they would have used, which is the point: it is how you read a
 * week of the journal and know that the build would have run as npurcell
 * before deciding to turn dry-run off.
 */
export async function runBuild(
  runner: Runner,
  config: OpsConfig,
  repo: RepoEntry,
): Promise<BuildOutcome> {
  const resolved = resolveOwner(repo.path);
  if (!resolved.ok) {
    return { ok: false, detail: resolved.reason, ran: [], owner: null };
  }

  const { owner, drop } = resolved;
  const steps = planBuild(config, repo, owner, drop);
  if (steps.length === 0) {
    return {
      ok: true,
      detail: `${repo.name} has no buildDirs configured, so there is nothing to build.`,
      ran: [],
      owner,
    };
  }

  const asWho = drop
    ? `dropping to ${owner.user} (uid ${owner.uid}, gid ${owner.gid})`
    : `already running as ${owner.user} (uid ${owner.uid}), nothing to drop`;

  // The checkout being root-owned is not an error — the owner is whoever the
  // owner is, and the executor does not get to have an opinion. It is said
  // loudly all the same, because on this host it means the services that run
  // as a person are already broken or about to be.
  const rootWarning =
    owner.uid === 0
      ? ' WARNING: the checkout is owned by root, so the build runs as root and everything ' +
        'it writes will be root-owned. Every unit that runs this code does so as an ' +
        'ordinary user; check that they can still start.'
      : '';

  const ran: string[] = [];
  for (const step of steps) {
    ran.push(step.label);
    const result: CommandResult = await runner.run(step.argv, {
      cwd: step.cwd,
      env: step.env,
      timeoutSeconds: step.timeoutSeconds,
      ...(step.uid === undefined ? {} : { uid: step.uid, gid: step.gid }),
    });
    if (!result.ok) {
      return {
        ok: false,
        owner,
        ran,
        detail:
          `${step.label} FAILED (${summarise(result)}), ${asWho}.\n` +
          'STOPPING HERE. Nothing will be restarted or recreated. A failed build leaves ' +
          'dist/ either stale or half-written, and restarting onto either is how a merged ' +
          'change silently does nothing — which is exactly the hour this step was added to ' +
          'stop happening again.' +
          (result.stderr.trim() ? `\nstderr: ${result.stderr.trim().slice(0, 2000)}` : '') +
          (result.stdout.trim() ? `\nstdout: ${result.stdout.trim().slice(0, 2000)}` : ''),
      };
    }
  }

  return {
    ok: true,
    owner,
    ran,
    detail:
      `built ${repo.name} (${repo.path}): ${ran.join(', ')} — ${asWho}.` +
      (runner.dryRun ? ' DRY RUN — the plan was logged, nothing was built.' : '') +
      rootWarning,
  };
}

export type DirtyResult =
  | { ok: true; files: string[] }
  | { ok: false; reason: string };

/**
 * Which files in the checkout are modified, added or untracked.
 *
 * ── The failure this exists for ──────────────────────────────────────────
 *
 * On 2026-08-09, on the host, a plain `git pull` in `/home/npurcell/clawcius`
 * stopped with:
 *
 *     error: Your local changes to the following files would be overwritten by merge:
 *             docker/run-container.sh
 *
 * Git was right, and it was right in the way that matters: those local edits
 * were real fixes someone had made in place during an incident and had not yet
 * committed. Every tempting way past that message — `reset --hard`, `checkout
 * -f`, `stash`, `clean -fd` — destroys or hides them, and the two that "keep"
 * the work (`stash`) hide it somewhere nobody will look before the next
 * incident.
 *
 * A human hitting this reads the filename and thinks. A daemon hitting it must
 * do exactly one thing: stop, name the files, and let the operation be reported
 * as failed. There is deliberately no force flag, no config key, no verb and no
 * code path in this repository that gets past a dirty tree — grep for `reset`,
 * `checkout`, `stash` and `clean` and you will find nothing, and that absence
 * is the feature.
 *
 * `--porcelain` rather than parsing `git status` prose, because the prose is
 * localised and reformatted between versions; `-z` is deliberately NOT used, so
 * that the output stays one record per line for the log, and paths with
 * newlines in them come back quoted by git rather than splitting a record.
 */
export async function readDirty(
  runner: Runner,
  config: OpsConfig,
  repo: RepoEntry,
): Promise<DirtyResult> {
  const status = await runner.probe(
    [config.gitPath, '-C', repo.path, 'status', '--porcelain'],
    { timeoutSeconds: 60 },
  );
  if (!status.ok) {
    return {
      ok: false,
      reason: `cannot read git status in ${repo.path}: ${status.stderr || summarise(status)}`,
    };
  }
  const files = status.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Porcelain v1 is `XY <path>`, and rename/copy entries are
    // `R  <old> -> <new>`. The status letters are dropped and the whole
    // remainder kept verbatim, including the arrow: this is text for a human
    // reading a journal at 3am, and abbreviating it would only lose the
    // information they need.
    .map((line) => line.slice(2).trim());

  return { ok: true, files };
}

/** The refusal text, kept in one place so pull and redeploy say the same thing. */
export function dirtyRefusal(repo: RepoEntry, files: string[]): string {
  return (
    `${repo.path} has ${files.length} uncommitted change(s). REFUSING, and not touching ` +
    'them:\n' +
    files
      .slice(0, 50)
      .map((file) => `  ${file}`)
      .join('\n') +
    (files.length > 50 ? `\n  …and ${files.length - 50} more` : '') +
    '\n\nThis executor will never reset --hard, checkout -f, stash or clean its way past ' +
    'this. On 2026-08-09 the local edits that blocked a pull on this host turned out to be ' +
    'real fixes made by hand during an incident, and every way of "getting the pull to go ' +
    'through" would have destroyed or hidden them. Commit them, or revert them, on the ' +
    'host, by a person who can look at what they are.'
  );
}
