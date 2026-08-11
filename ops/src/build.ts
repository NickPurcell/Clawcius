/**
 * What state the checkout's tree is in.
 *
 * ── What this file was, and what is left of it ───────────────────────────
 *
 * Until 2026-08-10 this ran the build: `npm ci && npm run build` as a step
 * inside the `pull` and `redeploy` verbs. Those verbs are gone, and with them
 * the planner and the runner — the host agent runs npm itself, in a Bash
 * command that gets audited like every other.
 *
 * On 2026-08-10 two things survived that cull: `readDirty`, and `resolveOwner`,
 * which was how the executor decided who the host agent session ran as — the
 * checkout's owner, discovered by `stat`, on the reasoning that "this daemon is
 * not entitled to an opinion about who owns a directory it was pointed at".
 *
 * ── `resolveOwner` is gone, 2026-08-11, and that reversal is the point ───
 *
 * That reasoning was right for a BUILD STEP and exactly backwards for an
 * IDENTITY. On this host the checkout is owned by `npurcell`; `npurcell` is in
 * the `docker` group; SETUP.md's own words for the docker group are
 * "effectively root on the host". So discovering the session's identity from
 * the filesystem is precisely how the session ended up running as a
 * root-equivalent account, and the sudoers scoping, the root-owned journal and
 * every other control in `ops/` were decoration on top of it.
 *
 * The session now runs as a named, unprivileged service account that the
 * daemon refuses to start without — see `ops/src/agent-user.ts`, which also
 * holds the passwd parsing that used to live here. What is left in this file is
 * `readDirty`, which feeds the briefing: the prohibition on forcing past a
 * dirty tree moved from a gate here to a standing rule in the host agent's
 * system prompt, and a rule that arrives with the actual filenames attached is
 * one the session can act on.
 *
 * The rest of this header is the record of why any of it exists. It is kept in
 * full, because the failures it describes have not stopped being possible —
 * they have stopped being prevented by a check and started being prevented by
 * an instruction, which is a weaker thing and worth knowing. The root-owned
 * `node_modules` failure in particular has a NEW shape now and it is in the
 * same family: the session is no longer the checkout's owner, so the way it
 * breaks a build is by not being able to write the tree at all. That is what
 * the shared group in MIGRATION.md § 2 is for, and `agentWarnings` checks it.
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
 * ── Why the session drops privileges at all ──────────────────────────────
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
 * So the session is dropped, and if the drop cannot be performed THE TASK IS
 * REFUSED. Running a session with a shell as root is a much larger version of
 * the failure this was written for: not two commands producing root-owned
 * files, but every command it chooses to run.
 *
 * ── Why the drop is setuid(2) and not sudo or su ─────────────────────────
 *
 * `sudo` and `su` are setuid binaries, and a setuid bit is exactly what
 * `NoNewPrivileges=true` turns into a no-op. Under NNP the kernel refuses to
 * grant the privilege transition at `execve`, so `sudo -u clawcius-ops npm ci`
 * fails with a message about being unable to set the effective uid — and it
 * fails whether or not the caller is already root, which makes it look like a
 * permissions bug rather than a unit setting.
 *
 * A `setuid(2)` performed by an already-root process is a different operation:
 * it *drops* privilege, it happens before `execve`, and `NoNewPrivileges` has
 * no bearing on it. So the drop is done with the `uid`/`gid` spawn options and
 * needs no setuid helper, no sudoers rule and no shell. The unit does not have
 * to weaken `NoNewPrivileges` for the drop's sake; it has to leave it false for
 * the sake of the `sudo` the SESSION runs, which is a different argument and is
 * written out in `systemd/clawcius-ops.service`.
 *
 * The honest limitation that used to be recorded here — that the spawn options
 * do not call `setgroups(2)`, so the child inherits root's supplementary group
 * list — was fixed on 2026-08-11 in `host-agent.ts`, because it stopped being
 * cosmetic the moment the containment argument became "this account is in no
 * root-equivalent group". See `withSupplementaryGroups` there.
 */

import type { OpsConfig, RepoEntry } from './config.js';
import type { Runner } from './runner.js';
import { summarise } from './runner.js';

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
