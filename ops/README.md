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
| `pull` | `repo` | `git pull --ff-only` in an allowlisted checkout |
| `redeploy` | `instance` | snapshot, then `docker/run-container.sh --recreate` |
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
- **`pull` fetches from the configured remote.** Anything the agent can get
  merged into `main` on GitHub is code this host will run. The breaker limits
  the blast radius of a bad build; it does not review it.
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
npm run selftest               # 53 tests, no docker required
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

## What has and has not been tested

`npm run selftest` runs 53 tests with no docker and no systemd. It covers
request validation against hostile inputs (traversal, separators, NUL and
control bytes, shell metacharacters, unknown verbs, wrong types, malformed
JSON, oversized files), the spool's caps and flood handling, the config
loader's containment assertions, the operation lock and queue, the idle logic
against synthetic waker status files including the stale-zero case, dry-run
suppression, breaker persistence across a fresh `StateStore`, deadline expiry
driving an automatic rollback and quarantine, and deadlines restored after a
restart. The privileged binaries are replaced with stand-ins that record their
argv one element per line, which is what proves no shell string is being built.

**Not tested, and it needs a real host:** everything on the far side of the
exec. No `systemctl restart` has been run, no container has been recreated, no
snapshot has been committed or restored, and the wake the executor files after
a rebuild has never been picked up by a live waker. Run it with `dryRun: true`
first and read the log — that is exactly what the default is for.
