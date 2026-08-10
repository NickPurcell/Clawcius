# ops

A host-side executor for a fixed list of privileged operations, requested by
the sandboxed agents by dropping JSON files in a directory.

The agents run in gVisor containers with no docker socket and no host socket —
deliberately, and `docker/run-container.sh` carries the note about why mounting
one would make the sandbox decorative. That leaves them unable to do anything
about their own deployment: they can write code and push it, and then someone
has to log in and restart a service. This is the narrow, enumerated hole through
that wall, so the agents can maintain their own deployments without the sandbox
becoming decorative after all.

```
  agent container                 host
  ┌───────────────┐               ┌──────────────────────────────────────┐
  │ writes JSON   │  bind mount   │ clawcius-ops.service (root)          │
  │ to run/ops/   │ ────────────► │  closed verb list, config allowlists │
  │               │               │  one operation at a time             │
  │ reads wakes   │ ◄──────────── │  waits for an idle turn              │
  │ from run/wake │  bind mount   │  arms a check-in deadline            │
  └───────────────┘               │  rolls back if nobody checks in      │
                                  └──────────────────────────────────────┘
```

## The verbs

Requests are JSON objects. Write to `<name>.tmp` and rename to `<name>.json` —
the executor only looks at `.json`, and a file written in place can be read
while it is still empty.

| Verb | Fields | What it does |
|---|---|---|
| `restart` | `unit` | `systemctl restart` an allowlisted unit |
| `pull` | `repo` | `git pull --ff-only`, **then `npm ci && npm run build`** |
| `redeploy` | `instance` | build, snapshot, then `docker/run-container.sh --recreate` |
| `snapshot` | `instance` | `docker/snapshot.sh` — commit the writable layer |
| `rollback` | `instance`, optional `tag` | restore a snapshot image and recreate |
| `checkin` | `instance` | "I came back up" — closes an armed deadline |
| `wake` | `channel`, `detail` | relay a wake into the waker's own spool |

`reason` is accepted on anything and is worth writing: it ends up in the
journal, and in the wake the executor sends you after a rebuild.

```sh
OPS=/var/lib/clawcius/run/ops
printf '%s' '{"verb":"restart","unit":"clawcius.service","reason":"picked up new dist/"}' \
  > $OPS/$(date +%s).tmp && mv $OPS/$(date +%s).tmp $OPS/$(date +%s).json
```

`wake` is a relay, not a new capability: the waker already accepts wake files
written by the agent, so this adds nothing it could not do directly. It exists
so the ops spool is genuinely one queue with a verb list rather than a second
queue beside the old one. **The existing wake spool is untouched** — same
directory, same format, same rate limit.

## `pull` builds. It has to.

Every service in this repository starts as `node dist/index.js`, and **not one
unit compiles anything.** The build was a thing a human did between the pull
and the restart, and it was never written down as a step because it was never a
step — it was a habit.

On 2026-08-09 the habit was skipped. The always-on-channels change was merged,
`agent-config.yaml` was correct, the checkout was pulled, `systemctl restart
clawcius` returned 0, and the feature did nothing at all for an hour. `dist/`
was still yesterday's. Nothing failed, nothing logged, the unit was `active
(running)` the whole time. The tell, eventually, was that even the *config
warning* about unreachable always-on channels never appeared — code that had
been merged was simply not on the machine.

That is one hour, from one human doing pull-then-restart once. The first draft
of this executor exposed `pull` and `restart` as separate verbs with no build
between them, which does not merely permit that mistake: it is a machine that
performs it, on request, in four seconds, as often as it is asked.

So `pull` now means *bring this checkout up to date and make it runnable*:

```
git rev-parse --abbrev-ref HEAD   # on the configured branch?
git status --porcelain            # clean?
git pull --ff-only
npm ci && npm run build           # in each of repo.buildDirs, as the owner
```

**A build failure aborts the operation.** Nothing is restarted, nothing is
recreated, and the journal says so under its own `build` kind. The state a
failed `tsc` leaves behind is not "unchanged" — it is *half-written*, four
files out of thirty, which starts cleanly and behaves wrongly.

`redeploy` builds too, before the pre-snapshot and long before the recreate,
because the cheapest thing that can say no should say it first. It does not
rebuild the container *image* — `run-container.sh --recreate` starts a
container from an image built separately — but it does build the checkout the
breaker identifies the deploy by and that `.claude/` and `discord-cli/` are
mounted from.

`ops/` itself is deliberately **not** in `buildDirs`. Rebuilding the executor's
`dist/` underneath the running executor would swap the code out from under a
process that already refuses to restart itself, for the same reason. Changes to
`ops/` are built and restarted by a person.

### The build runs as the checkout's owner, never as root

`clawcius-ops.service` is `User=root`. The checkout is
`/home/npurcell/clawcius`, and `clawcius.service`, `hamachi.service` and
`clawcius-status.service` all run as `User=npurcell`. A build run as root
leaves root-owned `node_modules/` and `dist/` behind, and every one of those
units then fails to start with an EACCES naming a file nobody edited.

That happened twice on the night of 2026-08-09 — the second time ten minutes
after a `chown -R` had fixed the first, because the fix was applied to the
symptom and the root `npm ci` was simply run again. It is a nasty failure
precisely because the build *succeeds*: exit code 0, `dist/` complete and
correct, and the damage entirely in file metadata.

The owner is discovered by `stat`ing the checkout — never hardcoded, because
this daemon is not entitled to an opinion about who owns a directory it was
pointed at — and the build runs as that uid/gid, with `HOME` and the npm cache
following. **If the owner cannot be determined, or the drop cannot be
performed, the build is refused.** Running it as root anyway is the failure
being prevented.

The drop is `setuid(2)` via the spawn options, not `sudo` and not `su`. Those
are setuid binaries, and a setuid bit is exactly what `NoNewPrivileges=true`
turns into a no-op — so `sudo -u npurcell npm ci` fails under NNP even when the
caller is already root, and fails in a way that reads like a permissions bug
rather than a unit setting. Dropping privilege from root is the opposite
operation and NNP has no bearing on it, which means the build needs no sudoers
rule, no helper binary, and no weakening of the unit.

## `pull` refuses a dirty tree. There is no way past it.

On 2026-08-09, on the host:

```
error: Your local changes to the following files would be overwritten by merge:
        docker/run-container.sh
```

Git was right, and right in the way that matters: those edits were real fixes
someone had made in place during an incident and had not yet committed. Every
tempting way past that message — `reset --hard`, `checkout -f`, `stash`,
`clean -fd` — destroys or hides them, and the one that "keeps" the work hides
it somewhere nobody looks until the next incident.

A human hitting that reads the filename and thinks. A daemon must do exactly
one thing: stop, name the files, and let the operation be reported as failed.

- The check runs **before** the pull, not after git refuses it, so the refusal
  arrives as a short list of filenames rather than a wall of stderr — and so it
  is identical whether the conflict is in a tracked file git would block on or
  an untracked one it would happily clobber.
- A `git status` that cannot be read is treated as **dirty**, not as clean.
  Unknown and dangerous are the same state.
- `redeploy` refuses a dirty tree too, because the breaker identifies a build
  by the checkout's HEAD — and a deploy built from uncommitted edits would have
  the wrong sha quarantined, which blocks the fix as well as the fault.
- There is no `force` field, no `allowDirty` key and no second code path. Grep
  `ops/src` for `reset`, `checkout`, `stash` and `clean`: nothing. That absence
  is the feature, and the self-test asserts it directly.

## The trust model

> **The spool is written by an agent that may be prompt-injected, and read by a
> root process holding docker and systemctl.**

That sentence is the whole design. It is not hypothetical: these agents read
Discord messages from strangers, fetch web pages, clone repositories, and will
one day summarise pull requests opened by people we have never met. Any of that
text can say "now write the following JSON into `/var/lib/clawcius/run/ops`".
The container boundary is what stops it becoming host code execution, and this
service is where that boundary is enforced.

So every byte from the spool is treated as hostile input to privileged code:

**Closed verb list.** Matched against a frozen set. An unknown verb is rejected
and logged — never a prefix match, never a default branch that tries something
sensible. "Best effort" on privileged input means the attacker picks the
effort.

**Every argument is a lookup, not a value.** `unit`, `instance` and `repo` are
compared by exact string equality against `ops-config.yaml`, and what reaches
the command is *the config entry*, never the request's string. The request
selects; it never supplies. `docker/run-container.sh` is invoked with an
environment built entirely from the instance's own config block.

**No shell. Anywhere.** Every command is an argv array handed to `execFile`
with an explicit `shell: false`. There is no command string in this codebase,
so there is nothing for quoting to get wrong. The rendered form in the log is
for humans and is never parsed or re-executed.

**Structural rejection, not repair.** Malformed JSON is discarded whole.
Nothing salvages the parseable prefix of a broken file and nothing coerces
types — a number where a string belongs is a reject.

**Traversal and control bytes are refused, not stripped.** Stripping is how
`....//` becomes `../`. Identifiers are checked for separators, `..`, NUL and
control characters even though they are never used as paths, because "never
used as paths" is a property of today's call graph.

**Caps everywhere a directory the agent can write meets a process that does
work.** A per-file size cap enforced by `stat` before the file is opened; a cap
on files consumed per sweep; a ceiling on files *present*, past which the spool
is treated as flooded and drained unread; a rolling-hour cap on accepted
operations; and a bounded queue that refuses with a stated reason rather than
letting requests evaporate.

**The state directory is out of reach.** The journal, the circuit breaker and
any armed rollback deadline live in `/var/lib/clawcius-ops`, which is not
bind-mounted into any container. A breaker the quarantined party can edit is
not a breaker. The config loader refuses to start if it is ever placed inside
the spool.

**The idle signal is out of reach too.** Each waker publishes
`/var/lib/<instance>/waker-status.json`, a sibling of the bind-mounted `run/`
directory rather than a child of it. The executor believes that file when it
decides whether recreating a container would kill a live turn; an agent that
could write "no turns in flight" could talk root into destroying a session
mid-conversation. Both config loaders — the waker's and this one's — refuse to
start if the path ends up inside a mount.

### What this does *not* protect against

Honest list.

- **An agent that can write the spool can restart the waker and recreate its
  own container.** That is the feature. It is bounded by the allowlists, the
  rate limit and the deadline, not prevented.
- **`pull` fetches from the configured remote, and now builds it.** Anything the
  agent can get merged into `main` on GitHub is code this host will run — and
  since 2026-08-10 it is also code this host will *execute at build time*, via
  `npm ci` running whatever `package.json` lifecycle scripts the lockfile's
  dependencies declare. That is not a new capability (the built output was
  always going to run) but it moves the moment of execution earlier and off the
  agent's uid onto the checkout owner's. The breaker limits the blast radius of
  a bad build; it does not review it.
- **The build's privilege drop sets the uid and gid but not the supplementary
  groups.** `setgroups(2)` is not called, so the build inherits root's group
  list — in practice just `root`. Files it creates are owned
  `npurcell:npurcell`, which is the property that matters here, but the process
  is not as thoroughly unprivileged as a real login. Fixing it properly means
  `setpriv --clear-groups`, which is another binary to depend on and another
  thing never run on this host; noted rather than half-done.
- **`reason` and `detail` are attacker-influenced text** that ends up in the
  journal, in `ops-status.json`, and in a wake prompt. They never reach a
  command, but anything rendering them owes them the same suspicion.
- **Root is root.** This service being small and readable is the mitigation.
  There is no second sandbox under it.

## Why a separate daemon

`restart clawcius.service` is one of the operations. A process cannot restart
itself: systemd sends it SIGTERM, it dies, and whatever it was doing dies with
it — including the record of what it was doing and any deadline it had just
armed. Folding this into the waker would make the single most useful operation
the one that cannot be performed reliably.

The argument is stronger for `redeploy`. Every live agent session *is* a
`docker exec` into the container being recreated, so a waker running its own
redeploy would be tearing down the processes it is made of.

The executor has to outlive the things it restarts. So it is a unit of its own,
with no Discord connection, no GitHub token, no Anthropic credential and — this
one matters most — **no model**.

### No model. Ever.

There is no LLM in this service and there must never be one. It runs as root
with docker and systemctl, and its entire safety argument is that the set of
things it can do is finite, enumerated and readable in one sitting. A model
here would make that set "whatever the model was talked into", and the party
doing the talking is on the far side of the boundary this exists to defend.

## One operation at a time

A lock, not a negotiation. Not a semaphore, not per-instance, not "these two
are independent so they can overlap". A second request queues; past
`limits.maxQueued` it is refused with a reason the agent can read, because a
refusal beats a request that silently evaporates.

Anything destructive — `redeploy`, `rollback` — first waits for the target
instance to report no turns in flight. If it does not go idle within
`idle.maxWaitMinutes`, the operation is **abandoned**, not deferred and not
forced. The agent can ask again.

Missing, stale, malformed or future-dated status all read as *busy*. The stale
case is the important one: a waker that crashed leaves a file saying
`liveCount: 0` and keeps saying it forever, and a stale zero is the most
dangerous value in this system because it is the one that reads as permission.

## The deadline, and the revert

After a destructive operation the executor:

1. files a wake to the instance carrying context — *you were rebuilt from
   `<sha>` because `<reason>`; here is what to check; check in within N
   minutes*;
2. waits `deadline.minutes` for a `checkin` request from that instance;
3. on silence, rolls back to the snapshot taken immediately **before** the
   operation, and reports.

The rollback target is captured before anything is destroyed, on purpose:
afterwards, the newest snapshot could easily be one taken of the broken build.

### Circuit breaker

- A build that has been rolled back once is **quarantined** and never deployed
  again. A build is identified by the `buildRepo` checkout's HEAD, so a fix —
  which is a new commit — goes through on its own. Retrying the same build is
  refused permanently, not backed off.
- After `breaker.maxConsecutiveFailedRecoveries` consecutive missed check-ins
  the executor **freezes**: it refuses every destructive verb and says so.
  Non-destructive work still runs; a freeze is about not rebuilding, not about
  refusing to take a backup.
- All of it is persisted. `restart` is a verb the agent can ask for, and a
  breaker that clears when its process restarts is not a breaker.

Clearing a freeze is a human decision made after looking at why it froze:

```sh
sudo ops/unfreeze.sh          # prints the reason, asks, then clears
sudo systemctl restart clawcius-ops
```

There is deliberately no `unfreeze` verb. The quarantine list is not cleared by
it either.

## Snapshot restore verification

`clawcius-snapshot-verify.timer` restores the newest snapshot for each
configured instance into a throwaway container, waits for it to reach
`running`, runs a probe inside it, and removes it. It exits non-zero on any
failure so the unit shows up in `systemctl --failed`.

The reason is in SETUP.md's known gaps, which carried this for weeks:

> **Snapshots are untested as a restore path.** `docker/snapshot.sh` produces
> images (~2 GB each, 8 retained), but restoring from one has never been done.

The usual cause of a failed rollback is a restore path nobody ever ran. A
nightly job producing images that have never been booted is not a backup, it is
2 GB of optimism — and now that a missed check-in triggers an *automatic*
rollback, that untested path is in the recovery path.

`docker run -d` succeeding proves almost nothing: it returns as soon as the
container is created, and an image whose entrypoint dies immediately satisfies
it. So the check is start → wait for `running` → `docker exec` the configured
probe. The throwaway container gets no env file, no bind mounts and no restart
policy, so it holds no credential and cannot reach the spools, the workspaces
or Discord; and it is removed in a `finally` on every path, because a verifier
that leaks 2 GB containers turns a broken snapshot into a full disk.

## Dry run — on by default

`ops-config.yaml` ships with `dryRun: true`, **and it should stay that way
until you have read the log.**

In this mode the executor makes every decision it would really make — allowlist
checks, the idle wait, the deadline, the breaker — and logs the exact argv it
would have executed, and executes none of it. Read-only probes (`docker
inspect`, `docker images`, `git rev-parse`) still run, because a dry run that
cannot see the machine reports fiction rather than a prediction.

A dry run also arms no deadline and files no wake: nothing was rebuilt, so
there is nothing to verify and nobody to check in, and arming one would
schedule a rollback of a container that was never touched.

```
[ops] started [dry-run]: redeploy hamachi — waited 0.0s in the queue. DRY RUN.
[ops] DRY-RUN would run: /home/npurcell/clawcius/docker/snapshot.sh (env CLAWCIUS_CONTAINER=hamachi-agent …)
[ops] idle-wait: redeploy hamachi — waiting for an idle turn: 1 turn(s) in flight as of 3s ago
[ops] DRY-RUN would run: /home/npurcell/clawcius/docker/run-container.sh --recreate (env …)
[ops] deadline-armed [dry-run]: checkin hamachi — DRY RUN — would have armed a 15-minute deadline. Nothing armed.
```

Turn it off when a week of `journalctl -u clawcius-ops` contains nothing that
surprises you. This is a root process holding docker and systemctl; the first
deploy should be observable before it is trusted.

## Running it

```sh
cd ops
npm install
npm run build
npm start                      # reads ./ops-config.yaml
npm run selftest               # 64 tests, no docker required
```

Override the config path with `OPS_CONFIG_PATH`.

Installation and the systemd units are in [SETUP.md](../SETUP.md) § 7.

## Configuration

`ops-config.yaml` is not settings — it is the authorization model. Every unit,
repo and instance this daemon may touch is named there by exact string, and
nothing in a request can add to those lists. Every key has a default in
`src/config.ts` and the loader validates types and cross-field invariants, so a
typo fails the boot with the offending key named rather than producing an
executor that quietly does nothing.

The cross-field checks worth knowing about, because they are security
properties rather than tidiness:

- `stateDir` may not be inside `spoolDir` or any instance's `wakeSpoolDir`;
- an instance's `wakerStatusFile` may not be inside either spool;
- `buildRepo` must name a real entry under `repos:`, or the breaker cannot
  identify a build;
- `repos[].buildDirs` must be relative and must resolve inside the checkout —
  it names a subdirectory of an already-authorised repo, not a second way to
  nominate a directory for a root process to run `npm` in;
- `snapshotVerify.instances` must name real instances, and `probe` may not be
  empty — an empty probe would report every restore as healthy.

## Layout

```
ops/
  ops-config.yaml        the authorization model
  unfreeze.sh            human-only: clear the breaker's freeze
  clawcius-sudoers       the pre-existing narrow sudo rule for the waker
  src/
    index.ts             daemon entry, single-instance lock, signals
    config.ts            typed YAML loader, defaults, containment assertions
    build.ts             npm ci/build as the checkout's owner; the dirty check
    request.ts           parsing and validating hostile spool content
    spool.ts             the directory-as-a-queue, with its structural caps
    executor.ts          the lock, verb dispatch, deadline, breaker
    runner.ts            argv-array exec, no shell; dry-run
    idle.ts              reading the waker status file; fails safe
    state.ts             persisted breaker, quarantine and deadlines
    journal.ts           append-only jsonl + ops-status.json
    verify.ts            snapshot restore test
    verify-main.ts       oneshot entry for the verify timer
    selftest.ts          `npm run selftest`
```

## The status page

The executor writes `<stateDir>/ops-status.json`, rewritten atomically on every
event and again whenever the lock is released. That is the whole integration
with `status/` — no socket, no API, no shared library. It holds the current
operation, the queue depth, the freeze, pending check-ins, the quarantine list
and the last hundred journal entries, and `status/` can grow a panel for it
whenever someone wants one. Until then it is the file you `cat` when the
journal is too long.

The durable record is `<stateDir>/journal.jsonl`, appended and fsynced before
each step proceeds. The systemd journal gets the same lines in prose. Both are
outside every container mount.

## The systemd units, audited

After `MemoryDenyWriteExecute=true` shipped in `clawcius-status.service` and
made it impossible for Node to start at all — V8's JIT maps pages writable and
then executable, which is precisely the transition the option forbids; it
core-dumped on SIGTRAP in a restart loop on first load, fixed in #7 — every
unit in this directory was read line by line on 2026-08-10 looking for
directives with the same character: things that read as sensible hardening and
are incompatible with what the process actually does.

**`clawcius-ops.service` had one, and it was the same kind of mistake.**
`ProtectHome=read-only`. It reads like obvious hygiene for a root daemon. The
checkout is `/home/npurcell/clawcius`: `git pull` writes `.git/`, `npm ci`
writes `node_modules/`, `npm run build` writes `dist/`. All three get EROFS on
a filesystem that is demonstrably read-write from a shell, so the journal fills
with permission errors against paths whose `ls -l` says they are fine. **The
`pull` verb could never have worked as shipped**, and it would have been
diagnosed as a git problem. There is a near miss next to it: `ExecStart` is
`/home/npurcell/.local/share/node/bin/node`, so `ProtectHome=yes` or `=tmpfs`
would have hidden the interpreter and the unit would not have started at all —
which would have been the *better* failure, caught on the first restart instead
of the first pull.

It is gone rather than patched. `ReadWritePaths=/home/npurcell/clawcius` on top
of `ProtectHome=read-only` is the tidier fix and it is a real one, but it has
never been loaded on this host, and shipping reasoned-but-unloaded hardening
into this exact file is what #7 *was*. The honest accounting is that
`ProtectHome` bought nothing here anyway: this unit holds the docker socket, so
anything it wanted to do to a home directory it can still do with
`docker run -v /home:/host`, one argument away, with no namespace in the path.

`MemoryMax` was raised from 512M to 2G and `TasksMax` from 128 to 512. The old
numbers were sized for "parses small JSON and waits on children", which stopped
being true when the build became a step. systemd's `MemoryMax` applies to the
unit's whole cgroup, children included, so `npm ci` plus `tsc` over three
packages would have been OOM-killed by the cgroup — a build failure with no
compiler error in it. The container a redeploy starts does *not* count against
this; docker puts it in its own slice.

Checked and deliberately still absent, each with the reason recorded in the
unit itself:

| Directive | Verdict |
|---|---|
| `MemoryDenyWriteExecute` | Never. Any Node process dies at startup. |
| `NoNewPrivileges` | Stays `false`. Not because of the build — a root process dropping via `setuid(2)` is unaffected by NNP; it is `sudo`/`su` that NNP breaks, and neither is used. It is untested here against `docker run` and `systemctl`, and that is the whole reason. |
| `SystemCallFilter` | No. `@system-service` would probably cover docker, systemctl, git, npm and node — including `@setuid` for the drop — and "would probably cover" is the phrase that preceded the SIGTRAP loop. A filter one syscall short kills a redeploy *halfway through*, container already destroyed. |
| `IPAddressDeny` | No, and not close. `git pull` reaches GitHub and `npm ci` reaches the registry; denial surfaces as timeouts, not refusals. |
| `PrivateTmp` | No. npm stages tarballs through `TMPDIR`, and a private `/tmp` also hides it from the operator debugging this at 3am. |
| `ProtectSystem` | `strict` breaks the docker socket (a read-only `/run` denies the write permission a unix socket connect needs). `full` is likely fine and likewise untested. |
| `RestrictSUIDSGID` | Kept. It restricts *creating* setuid files; it does not touch `setuid(2)`, so the build's drop is unaffected. |

`clawcius-snapshot-verify.service` carried no hardening block at all, which is
the only reason it had nothing fatal in it. It now carries the same reasoning
written down, plus a `MemoryMax` sized for a node process driving a docker
client — the 2 GB container it starts lives in docker's cgroup, not the unit's.

## What has and has not been tested

`npm run selftest` runs 64 tests with no docker, no systemd and no npm. It
covers request validation against hostile inputs (traversal, separators, NUL
and control bytes, shell metacharacters, unknown verbs, wrong types, malformed
JSON, oversized files), the spool's caps and flood handling, the config
loader's containment assertions, the operation lock and queue, the idle logic
against synthetic waker status files including the stale-zero case, dry-run
suppression, breaker persistence across a fresh `StateStore`, deadline expiry
driving an automatic rollback and quarantine, and deadlines restored after a
restart. The privileged binaries are replaced with stand-ins that record their
argv one element per line, which is what proves no shell string is being built.

The eleven added on 2026-08-10 assert the four corrections as **orderings and
absences** rather than as log lines, because every one of the failures they
describe was silent on the host — exit 0, no stderr, unit `active (running)`:

- `pull` runs `npm ci && npm run build`, *after* the pull and in each
  `buildDir`, and never `npm install` (which rewrites the lockfile unattended);
- `redeploy` builds *before* the pre-snapshot and *before* the recreate;
- a failed build stops everything: no `systemctl`, no `run-container.sh`, no
  snapshot, no armed deadline;
- a dirty tree refuses `pull` and `redeploy`, names the files, and — the
  assertion that matters most — no `git reset`, `checkout`, `stash`, `clean`,
  `restore`, `--force` or `-f` appears in any recorded argv;
- an unreadable `git status` reads as dirty, not as clean;
- every planned build step carries the checkout owner's uid/gid, `HOME` and npm
  cache, and none carries uid 0; when the executor already is the owner, no uid
  is set at all;
- the owner is refused, loudly, when the directory cannot be stat'd or the uid
  has no passwd entry;
- `buildDirs` may not be absolute or climb out of the checkout.

**Not tested, and it needs a real host:** everything on the far side of the
exec. No `systemctl restart` has been run, no container has been recreated, no
snapshot has been committed or restored, no real `npm ci` has been dropped to
another uid, and the wake the executor files after a rebuild has never been
picked up by a live waker. Nor has any unit in `systemd/` been loaded since the
audit above — which is exactly the condition that produced the bug the audit
was looking for, and is why the `ProtectHome` fix removes a directive rather
than adding a cleverer one. Run it with `dryRun: true` first and read the log:
the build's argv, cwd and uid are all in there.
