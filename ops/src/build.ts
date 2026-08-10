/**
 * Who owns the checkout, and what state its tree is in.
 *
 * ── What this file was, and what is left of it ───────────────────────────
 *
 * Until 2026-08-10 this ran the build: `npm ci && npm run build` as a step
 * inside the `pull` and `redeploy` verbs. Those verbs are gone, and with them
 * the planner and the runner — the host agent runs npm itself, in a Bash
 * command that gets audited like every other.
 *
 * Two things stayed, and both are load-bearing for what replaced them:
 *
 *   - `resolveOwner`, which is how the executor decides who the host agent
 *     session runs as. The session is dropped to the checkout's owner for
 *     exactly the reason the build was, and the drop now covers everything the
 *     session does rather than two commands;
 *   - `readDirty`, which feeds the briefing. The prohibition on forcing past a
 *     dirty tree moved from a gate in this file to a standing rule in the host
 *     agent's system prompt, and a rule that arrives with the actual filenames
 *     attached is one the session can act on.
 *
 * The rest of this header is the record of why either of them exists. It is
 * kept in full, because the failures it describes have not stopped being
 * possible — they have stopped being prevented by a check and started being
 * prevented by an instruction, which is a weaker thing and worth knowing.
 *
 * ── Why the build mattered ───────────────────────────────────────────────
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
 * From 2026-08-10 the build is a habit again — the host agent's habit, stated
 * as a standing rule in its system prompt along with the date and the hour it
 * cost, and named per repository in the briefing with the exact directories.
 * That is a real reduction in strength and it is written down here rather than
 * glossed: an instruction can be forgotten in a way a step in a state machine
 * cannot. What is bought for it is that the same agent can also install a unit,
 * chown a directory and read a journal, which is what the operator actually
 * needed.
 *
 * ── Why the session drops privileges ─────────────────────────────────────
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
 * it was pointed at — and the host agent session runs as that uid/gid. If the
 * owner cannot be determined, or the drop cannot be performed, THE TASK IS
 * REFUSED. Running a session with a shell as root is a much larger version of
 * the failure this was written for: not two commands producing root-owned
 * files, but every command it chooses to run.
 *
 * The upside of dropping the whole session rather than two commands is that the
 * original failure becomes structurally impossible for anything the agent does
 * without `sudo`. It cannot leave a root-owned `node_modules/` behind by
 * accident, because it is not root.
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
import type { OpsConfig, RepoEntry } from './config.js';
import type { Runner } from './runner.js';
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
