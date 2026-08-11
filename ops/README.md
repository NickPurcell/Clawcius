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
  agent containers                          host
  ┌────────────────────────┐               ┌──────────────────────────────────────┐
  │ clawcius               │  bind mount   │ clawcius-ops.service (root)          │
  │  /var/lib/clawcius/run │ ────────────► │  one spool watched per instance      │
  │    ops/   wake/        │               │  the SPOOL names the requester       │
  ├────────────────────────┤               │  closed verb list, config allowlists │
  │ hamachi                │  bind mount   │  one operation at a time             │
  │  /var/lib/hamachi/run  │ ────────────► │  waits for an idle turn              │
  │    ops/   wake/        │ ◄──────────── │  arms a check-in deadline            │
  └────────────────────────┘   wakes back  │  rolls back if nobody checks in      │
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
# Your own spool. Clawcius: /var/lib/clawcius/run/ops.
#                 Hamachi: /var/lib/hamachi/run/ops.
OPS=$CLAWCIUS_STATE_DIR/run/ops        # or just the literal path for your instance
printf '%s' '{"verb":"restart","unit":"clawcius.service","reason":"picked up new dist/"}' \
  > $OPS/$(date +%s).tmp && mv $OPS/$(date +%s).tmp $OPS/$(date +%s).json
```

There is no `requester` field and there must never be one. **The spool you
wrote into is who you are** — see the next section.

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

## One spool per instance, and why that turned out to matter twice

Until 2026-08-10 there was a single `spoolDir: /var/lib/clawcius/run/ops` for
the whole executor. That one line was two bugs, and only one of them was
visible.

**The visible one: Hamachi could not file a request at all.**
`docker/run-container.sh` gives each instance its own state directory and
bind-mounts only that:

```sh
CLAWCIUS_STATE=${CLAWCIUS_STATE_DIR:-/var/lib/clawcius}
WAKE_DIR=$CLAWCIUS_STATE/run
-v "$WAKE_DIR:$WAKE_DIR:rw"
```

`systemd/hamachi-container.service` sets `CLAWCIUS_STATE_DIR=/var/lib/hamachi`,
so Hamachi's container has `/var/lib/hamachi/run` and nothing else. The shared
spool at `/var/lib/clawcius/run/ops` **does not exist inside it** — verified
from inside the container. The agent the operator talks to most was the one
agent locked out of the mechanism built for both of them, and it was silent
from every angle: the agent's `mv` failed into a shell nobody reads, and the
executor saw an empty directory, which is exactly what a quiet night looks
like. The mount asymmetry had been there since the second instance shipped on
2026-08-08; the spool was written against the first instance's paths and read
as correct because for the first instance it was.

**The invisible one, which matters more: nothing recorded who asked.** A shared
directory carries no evidence of its writer. `redeploy hamachi` filed by
Hamachi and `redeploy hamachi` filed by Clawcius are the same forty bytes, and
the journal said the same thing about both — because it could not tell. One of
those is an agent maintaining itself. The other is an agent reaching across the
boundary at its neighbour, and those should never have been indistinguishable
after the fact on a root process holding docker.

### Provenance is the directory, not a field

Every request now carries a `requester`, and it comes from the spool it was
found in. It is stamped on in `src/spool.ts`, where the file's contents cannot
reach it, and it is never read out of the JSON.

That is the whole security property, and it is inherited from the mount rather
than invented here: a container can write into exactly one of these
directories, no matter what its prompt says, because that is the only one bind
-mounted into it. A request that writes `"requester": "clawcius"` into
Hamachi's spool is logged as an ignored unknown field and attributed to
Hamachi. The self-test asserts precisely that, because "the attacker supplies
their own identity" is the obvious way to get this wrong and it would look
correct in every log until the day it mattered.

It shows up in three places:

- every journal entry gains a `requester`, alongside the existing `instance`
  (which is the *target* — the two are different questions);
- every prose log line: `[ops] started: redeploy hamachi (from clawcius) — …`,
  so `journalctl -u clawcius-ops | grep 'from hamachi'` is now a question with
  an answer;
- `ops-status.json` lists the spools being watched, so the status page can show
  at a glance that every agent has a reachable queue — the failure this
  replaced was one agent silently having none.

The executor's own actions are attributed to `(executor)`, not to the instance
they happen to. An automatic rollback after a missed check-in is not a request
and must not read like one.

### Where the spools live, and who creates them

`instances[].opsSpoolDir`, defaulting to `<stateDir>/run/ops`. Leave it unset.
The default is the only value that is right by construction — it is inside the
mount `run-container.sh` already gives that container — and it means a new
instance can talk to this daemon without anyone remembering a second setting.

**`docker/run-container.sh` creates them**, with `mkdir -p "$OPS_DIR"` directly
beside the existing `mkdir -p "$WAKE_DIR"`, and for the same reason: that
script runs as `npurcell` (the container units are `User=npurcell`) and the
Dockerfile builds the agent user with `AGENT_UID=1000` to match, so the
directory lands owned by the uid the container runs as without a `chown`
anywhere.

**The executor also creates them at startup**, because it must not depend on a
container having ever been started. `ensureSpoolDir()` walks down from the
instance's state directory creating each missing level, and chowns and chmods
each level *it creates* to match that state directory — the same rule as
`build.ts`, where the owner is discovered rather than configured, because this
daemon is not entitled to an opinion about who owns a directory it was pointed
at. A failure there is logged loudly with the exact `chown` to run, and is
never fatal.

The alternative — letting root `mkdir -p` it and leaving it at that — produces
a root-owned tree the container cannot write, and the symptom is an agent whose
requests are never seen. That is the same silent shape as the bug this whole
section is about, so it is not left to chance. Note that "the levels it
creates", plural, and the explicit `fchmod` are both load-bearing: `mkdir -p`
as root creates the intermediate `run/` root-owned too, and `mkdir`'s mode
argument is masked by the umask, so `0770` arrives as `0750` and the
container's group silently loses write.

#### What it will **not** do, and why (rewritten 2026-08-11)

**It never follows a symlink, and it never chowns anything it did not just
create.**

The first version of this function did both, and it was a privilege escalation
out of the sandbox — in the change written to let agents file requests safely.
Review of PR #8 caught it before it ran anywhere.

The mechanism: the spool's *parent*, `<stateDir>/run`, is bind-mounted
read-write into the container and is owned by the uid the agent runs as. The
agent therefore owns the directory entry called `ops` and can replace it:

```sh
rm -rf run/ops && ln -s /root/.ssh run/ops    # from inside the container
```

Restarts are routine — a pull, a redeploy, a reboot — so the next executor
start ran, as root, `mkdirSync(recursive)` (which returns quietly on an
existing symlink-to-directory), then `statSync` and `chownSync`, both of which
follow the terminal symlink. Result: root chowns any path on the host the agent
chose to `1000:1000`. `/etc`, the checkout, or `/var/lib/clawcius-ops` itself —
the state directory whose unreachability is the entire argument for why the
circuit breaker cannot be edited by the instance it has quarantined.

`lchown` alone would have been the small fix. The rule is stricter than that,
because the real question is whether a root process should be repairing paths
whose parent directory is owned by the adversary:

- every level is `lstat`ed, and anything that is not a real directory —
  symlink, file, socket — is **refused, reported and left exactly where it
  is**. It is not repaired, and it is not deleted either: deleting as root
  inside a directory the agent owns is another primitive, and the agent can
  remove its own link. The instance's requests stop arriving until a human
  looks, which is correct — the only party who can put a symlink there is the
  one whose requests those would have been;
- the chown and chmod go through a descriptor opened `O_NOFOLLOW |
  O_DIRECTORY`, whose `fstat` is compared by device and inode against the
  `lstat`. Whatever is chowned is the object that was checked, or nothing is;
- an **existing** directory with the wrong owner is a loud warning with the
  exact `chown` to run, and nothing else. The old "repair" bought the case
  where a previous root `mkdir` left a bad owner; it cost the case where the
  adversary picks the target;
- if the state directory does not exist yet, **nothing is created at all**.
  There is no correct owner to copy, and a root-owned tree is worse than an
  absent one — the absent one is fixed by the instance unit starting, and this
  is retried on every sweep, so a first-boot ordering race heals itself without
  a restart.

The same rule runs on **every sweep**, not just at startup: `drain()` does
`readdir` and `unlink` as root, and the agent can swap the directory for a
symlink at any moment of the process's life, not only before it starts. Files
inside the spool get it too — they are opened `O_NOFOLLOW | O_NONBLOCK` and
sized with `fstat` on the descriptor, so a `req.json` that is really a symlink
to a host file is discarded rather than read into the journal, and one that is
really a FIFO cannot park the daemon that holds every rollback deadline.

### Optional: restricting an instance. Off by default.

`instances[].mayRequest` narrows what one instance may ask for:

```yaml
  - name: hamachi
    # …
    mayRequest:
      instances: [hamachi]        # redeploy/snapshot/rollback/checkin targets,
                                  # and the instance a `wake` channel routes to
      units: [hamachi.service]    # restart
      repos: [clawcius]           # pull
      verbs: [restart, pull, redeploy, snapshot, checkin]
```

- **No `mayRequest` block means unrestricted**, which is what every instance had
  before this existed. Upgrading changes nothing until somebody writes one.
- A key left out is unrestricted. A key present is an exact-match allowlist. A
  key present and empty (`instances: []`) means none at all, which is a
  legitimate thing to say and is not confused with absent.
- Every name is checked against the real allowlists at boot. A typo in
  `mayRequest.units` would otherwise be a silent total denial of something the
  operator believed they had granted, and a restriction that fails closed by
  accident is indistinguishable from a broken executor.
- Refusals are journalled with the requester and the reason, and are checked
  **before** the rate limit, so an agent looping on requests it may not make
  cannot starve the one doing real work.
- `wake` is checked twice: at intake for the verb, and again after routing,
  because a wake names a channel and the target instance is not known until it
  has been resolved. Waking somebody else's agent with attacker-influenced text
  is exactly what a restricted instance should not be able to do.

This is **not** a new security boundary. An agent that can write its spool can
still restart its waker and recreate its own container; that is the feature,
bounded by the allowlists, the rate limit and the deadline. This is the
narrower thing that per-instance spools made expressible for the first time:
keeping an instance out of its neighbour's business, deliberately, with the
refusal in the journal. It could not have existed before, because "this
instance" was not a thing the executor knew.

### Migration: the old `spoolDir` is a deprecated alias, not an error

**Decision: accept it, attribute it, say so loudly. Refuse only if it cannot be
attributed.**

The executor is running right now, as root, in dry-run, with the old key on
disk. `pull` updates the checkout — including `ops-config.yaml` — without
restarting this daemon, so the new file lands under a process that will not
read it until a person restarts it.

The alternative was to fail the boot with a message saying exactly what to
write. That is tempting and it is wrong here, because of what failure means for
*this* unit: `clawcius-ops.service` is `Restart=always` with
`StartLimitIntervalSec=0` and `StartLimitBurst=0` — never give up — since it
holds the rollback deadlines and a dead executor is how a broken rebuild
becomes a permanent outage. A rejected config does not produce one loud
failure; it produces a root daemon in a five-second restart loop with every
armed deadline unhonoured. That is the shape of #7, and this repository has
already agreed not to ship it again.

So on boot, a top-level `spoolDir:`:

- is **attributed** to the one instance whose `stateDir` contains it. That
  instance carries on watching exactly the directory it watched before the
  upgrade — no behaviour change for it — and every other instance gets its own
  spool at the default. On this host that means Clawcius keeps
  `/var/lib/clawcius/run/ops` and Hamachi finally has
  `/var/lib/hamachi/run/ops`;
- writes a **deprecation entry into `journal.jsonl`**, not just to stdout,
  naming the instance it was attributed to and the lines to replace it with.
  The whole argument for tolerating the key is that the operator gets a durable
  record saying it was tolerated;
- **fails the boot** if no instance owns it, if two do, or if it disagrees with
  an explicit `opsSpoolDir` — with the exact YAML to write. An unattributable
  spool is the precise thing this change abolishes; guessing at provenance
  would be worse than the shared spool was.

"Explicit" means *written in the file*, not *different from the default*. Those
are different questions and the loader used to ask the wrong one: because
`opsSpoolDir` is resolved against its default before this check, an operator
who spelled the default out by hand — `opsSpoolDir: /var/lib/clawcius/run/ops`,
an ordinary thing to write while migrating off the old key — looked identical
to one who had written nothing, so a stale `spoolDir` pointing somewhere else
in the same `stateDir` silently replaced their value instead of failing. The
executor would then watch a directory no container writes, because
`run-container.sh` hard-codes the container's spool to `<stateDir>/run/ops` and
that path is not in the config at all. Fixed 2026-08-11, after review of PR #8;
the loader now tracks presence separately, the same distinction `strListOrNull`
exists to preserve for `mayRequest`.

Delete the key once you have read the notice.

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
*any* instance's spool — every spool, not just the first, which is a check that
had to grow teeth when there stopped being only one.

**And the spools are out of each other's reach.** The loader refuses two
instances sharing a spool (provenance would not be blurred, it would be
invented), one spool nested inside another (forgery with extra steps), and an
ops spool that would swallow a wake spool — the ops spool unlinks every file it
sweeps before parsing it, so that arrangement would silently eat the waker's
queue.

**The idle signal is out of reach too.** Each waker publishes
`/var/lib/<instance>/waker-status.json`, a sibling of the bind-mounted `run/`
directory rather than a child of it. The executor believes that file when it
decides whether recreating a container would kill a live turn; an agent that
could write "no turns in flight" could talk root into destroying a session
mid-conversation. Both config loaders — the waker's and this one's — refuse to
start if the path ends up inside a mount: its own wake spool, its own or any
other instance's ops spool, and (since 2026-08-11) *another instance's wake
spool*, which was the one pairing the first version of these checks missed. A
neighbour's wake spool is bind-mounted read-write into the neighbour's
container exactly like its ops spool is, so a status file misplaced there would
have let one agent declare the other idle.

**The spool's own directory is not trusted either.** It sits inside a mount the
agent owns, so the agent can delete it and put a symlink in its place. Nothing
in the executor follows one: see "What it will not do, and why" above. This is
the sharpest instance of the general rule, because the process on the other end
of the path is root and the operations are `chown`, `readdir` and `unlink`.

### What this does *not* protect against

Honest list.

- **An agent that can write the spool can restart the waker and recreate its
  own container.** That is the feature. It is bounded by the allowlists, the
  rate limit and the deadline, not prevented.
- **By default an agent can also recreate the *other* agent's container.** The
  allowlists are per-executor, not per-instance, unless somebody writes a
  `mayRequest` block. What changed on 2026-08-10 is that this is now *visible*
  — the journal says which agent asked — and *restrictable*. It is not
  restricted by default, deliberately: this shipped as a mechanism, and a
  privileged daemon that silently starts refusing requests on upgrade is an
  outage with a changelog.
- **Provenance is as good as the bind mounts, and no better.** It is a strong
  property — a container can write into exactly one spool no matter what its
  prompt says — but it rests entirely on `docker/run-container.sh` mounting one
  per instance. Anyone who adds a second mount, or points two instances at one
  directory in config (the loader refuses that one), has removed it. Root on
  the host can of course write into any spool it likes and be recorded as
  whichever agent it chose.
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
- **The symlink defence around the spool directory is a check, not a
  transaction.** Every sweep `lstat`s the spool and refuses anything that is
  not a real directory, and every request file is opened `O_NOFOLLOW`; but Node
  exposes no `unlinkat`, so the sweep re-resolves the directory by name for
  each file it removes. An agent swapping the directory for a symlink inside
  that window could in principle still get a `.json` removed elsewhere. The
  persistent case — plant a link and wait for the restart, which was the actual
  bug — is refused and reported. Fixing the residual race needs directory
  descriptors and `*at()` syscalls this runtime does not offer, so it is
  written down rather than half-done.
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
npm run selftest               # 82 tests, no docker required
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

- `stateDir` may not be inside any instance's `opsSpoolDir` or `wakeSpoolDir`;
- an instance's `wakerStatusFile` may not be inside its own wake spool or *any*
  instance's ops spool — the neighbour's counts, and on this host the two state
  directories are siblings under `/var/lib`, so a fat-fingered path lands in the
  neighbour rather than nowhere;
- no two instances may share an `opsSpoolDir`, and none may nest inside another;
- an `opsSpoolDir` may not contain or be contained by any `wakeSpoolDir`;
- `mayRequest` may only name units, repos, instances and verbs that exist;
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
    spool.ts             one directory-as-a-queue per instance; the caps, and
                         the stamp that says whose it was
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
operation, the queue depth, the freeze, pending check-ins, the quarantine list,
the spools being watched (one per instance, and whether each is restricted) and
the last hundred journal entries — each of which now names its requester as
well as its target. `status/` can grow a panel for it
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

`npm run selftest` runs 91 tests with no docker, no systemd and no npm. It
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

The eighteen added later on 2026-08-10, for per-instance spools, needed the
fixture to grow a second instance first — and that is the point rather than an
aside. The old suite had one instance and one spool, which is exactly the world
in which a shared spool looks correct, and no test could have caught the
Hamachi bug without first being able to represent two agents:

- each instance's spool defaults inside its own state directory, and no
  instance's spool lives under another's;
- two spools are drained concurrently and each request is attributed to the
  directory it arrived in — asserted with the *same verb on the same target*
  filed into both, which is the pair that was indistinguishable before;
- a request claiming `"requester": "clawcius"` inside Hamachi's spool is still
  attributed to Hamachi, and the claim is reported as an ignored unknown field;
- "hamachi asked to snapshot hamachi" and "hamachi asked to snapshot clawcius"
  produce different journal lines;
- an automatic rollback is attributed to `(executor)`, not to the instance it
  is performed on;
- a `mayRequest` restriction refuses an out-of-scope target, names why, leaves
  the unrestricted instance alone, does not consume the hourly budget, and
  blocks a `wake` at the point the channel routes to a forbidden instance;
- a `mayRequest` naming a unit, instance or verb that does not exist fails the
  boot rather than denying everything quietly;
- the containment assertions hold across several spools: shared, nested,
  swallowing a wake spool, and a state directory inside the *second* instance's
  spool (which a check written against one spool passes and is wrong about);
- the deprecated `spoolDir` is attributed to its owning instance, leaves that
  instance watching the same directory as before, gives the other one its own,
  and fails the boot when it belongs to nobody or disagrees with an explicit
  `opsSpoolDir`;
- the post-rebuild wake tells the instance to check in via *its own* spool.

The nine added on 2026-08-11 are the review findings on PR #8, one test each,
and they are written as **absences** for the same reason as the batch above —
every failure here is silent, and three of them are silent *and* privileged:

- a symlink where the spool should be is refused rather than chowned: the link
  is still a link afterwards, the directory it points at still has every file
  it had, and nothing behind it was read as a request or unlinked by the root
  sweep. A non-directory of any kind gets the same treatment, and so does a
  symlinked `.json` *inside* a real spool;
- a fresh host — state directory present, nothing under it — ends up with
  `run/` **and** `run/ops` existing, owned like the state directory, mode 0770
  and not the umask's 0750. The intermediate level and the explicit `fchmod`
  are each asserted, because each was separately wrong;
- a *missing* state directory creates nothing at all, and the spool appears by
  itself on a later sweep once the instance unit has made one — no restart;
- an explicitly written `opsSpoolDir` is never replaced by the legacy
  `spoolDir`, **including when its value is the default spelled out by hand**,
  which is the case that used to slip through; the agreeing and absent cases
  still migrate as before;
- an instance's `wakerStatusFile` inside another instance's *wake* spool fails
  the boot, and the default arrangement still loads;
- `mayRequest.units` and `mayRequest.repos` are enforced, asserted against
  names that are in the *global* allowlist — so the refusal can only have come
  from the per-instance rule — while the unrestricted instance still gets
  through, and present-and-empty stays distinguishable from absent;
- a deadline rollback that has to **queue behind a busy operation** still
  quarantines the build it rolled back, is still attributed to `(executor)`,
  and still counts towards the breaker. The idle path did all of that already;
  the queued path silently did none of it, which is the path an incident
  actually takes, since `#waitForIdle` can hold the lock for half an hour.

**Not tested, and it needs a real host:** everything on the far side of the
exec, and one thing on this side of it — `ensureSpoolDir`'s `fchown` has never
run as root here, because the self-test does not run as root and cannot. What
*is* tested without root is everything that decides whether the chown happens
at all: the refusals, the O_NOFOLLOW open, which levels get created, and the
mode. That the spool ends up owned by the container's uid is asserted by
construction on the host, via `run-container.sh` creating it as `npurcell`.
Check it with `ls -ld /var/lib/*/run/ops` after the first start — and if that
ever shows a symlink, read the executor's log rather than fixing it quietly.
No `systemctl restart` has been run, no container has been recreated, no
snapshot has been committed or restored, no real `npm ci` has been dropped to
another uid, and the wake the executor files after a rebuild has never been
picked up by a live waker. Nor has any unit in `systemd/` been loaded since the
audit above — which is exactly the condition that produced the bug the audit
was looking for, and is why the `ProtectHome` fix removes a directive rather
than adding a cleverer one. Run it with `dryRun: true` first and read the log:
the build's argv, cwd and uid are all in there.
