# ops

A host-side supervisor for a **host agent**: a headless Claude Code session,
running on the host with a shell and sudo, that carries out tasks the sandboxed
agents describe in free text.

Until 2026-08-10 this was a closed list of seven verbs and this file said, in
several places, that there must never be a model in it. That is no longer true.
The rest of this document is about what changed, why, what was given up, and
what was put in its place — because the trust model changed and this is the
place that has to say so honestly.

```
  agent containers                          host
  ┌────────────────────────┐               ┌──────────────────────────────────────┐
  │ clawcius               │  bind mount   │ clawcius-ops.service (root)          │
  │  /var/lib/clawcius/run │ ────────────► │  one spool watched per instance      │
  │    ops/   wake/        │               │  the SPOOL names the requester       │
  ├────────────────────────┤               │  one task at a time                  │
  │ hamachi                │  bind mount   │  snapshot ▸ idle-wait ▸ SESSION ▸    │
  │  /var/lib/hamachi/run  │ ────────────► │    health check ▸ roll back if worse │
  │    ops/   wake/        │ ◄──────────── │  every command audited, in full      │
  └────────────────────────┘   wakes back  │  deadline armed on what it touched   │
                                           └───────────────┬──────────────────────┘
                                                           │ claude -p, as clawcius-ops,
                                                           │ with Bash and a short
                                                           │ enumerated sudoers file
                                                           ▼
                                            the machine, minus what that account
                                            is not allowed to reach — which is
                                            now a real sentence. See § The
                                            service account.
```

> **2026-08-11.** The session used to run as `npurcell`, the operator, who is in
> the `docker` group. That made every control below decoration: `docker run -v
> /:/host` is root in one command with no sudo in the path. It now runs as its
> own unprivileged system account and the daemon refuses to start it otherwise.
> [§ The service account](#the-service-account-2026-08-11) is the whole story;
> [`MIGRATION.md`](../MIGRATION.md) is how to get there from here.

## Why the verbs went

The operator, on 2026-08-10, in his own words: he is **"sick of this whole verbs
game"**.

Standing up three services that evening took roughly a dozen ad-hoc shell
commands that he had to type himself — `chown`, `mkdir`, editing a config file,
installing units, and above all pasting `journalctl` output back to an agent
that could not read it. Not one of those is `restart`, `pull`, `redeploy`,
`snapshot` or `rollback`.

That is not a gap in the verb list. It is a property of verb lists. A closed set
can only ever contain what somebody imagined in advance, and every gap in it
turns the operator into the agent's hands: typing what the agent dictates,
pasting back what the machine says. That is exactly the labour this system
exists to remove, so a safety mechanism that reinstates it at every unforeseen
step is not a safety mechanism with a cost — it is one that is eating the
product.

## Ask by DM — the spool is no longer the way in

Since 2026-08-14 the host agent is an ordinary Clawsky participant with a
mailbox and a registry row. **A DM to `<crew>-host` runs it, immediately**, and
the answer comes back as a DM:

```sh
DROP=$CLAWCIUS_STATE_DIR/run/clawsky/$YOUR_AGENT_ID
printf '%s' '{"to":"clawcius-host","subject":"clawcius.service is flapping",
"body":"It has been restarting every 30s since the last deploy. Find out why
and fix it. Do not change anything outside the checkout without saying so."}' \
  > $DROP/$(date +%s%N).json
```

No queue, no waiting for every container to fall idle, no snapshot, no armed
rollback deadline, no check-in. That scheduling apparatus is what this replaced,
and it is worth being exact about the one thing that went with it: **there is
nothing to undo.** A task filed by mail takes no snapshot first, so a failure is
reported and not repaired. The reply says so.

**Only a coordinator may DM the host agent.** With the queue gone this is the
only remaining access control on running commands on this host, and it is
enforced in code twice — where the DM is delivered, and again here against the
author column of the row, immediately before anything runs. Engineers ask their
captain; the captain asks the host.

Everything below this line still holds: the account, the sudoers file, the
privilege drop, the tool deny-lists, the per-command audit and the freeze are
untouched, and every one of them is in the path of a task filed by mail.

The host agent has a mailbox on an instance only if that instance has a `board:`
block in `ops-config.yaml`. Without one, a coordinator DMing `<crew>-host` is
told there is no such recipient, which is the honest answer.

## The requests (the old spool — inert, still running)

Nothing files these any more. The directories are still watched and a request
found in one is still executed the old way, with the snapshot, the idle wait and
the deadline, because a rollback to the previous `dist/` must not find a request
format that nothing reads. Read this section for what a `task` still does; do
not use it for new work.

Write to `<name>.tmp` and rename to `<name>.json` — the executor only looks at
`.json`, and a file written in place can be read while it is still empty.

| Verb | Fields | What it does |
|---|---|---|
| `task` | `task`, optional `instance` | free text, handed to a host agent session |
| `checkin` | `instance` | "I came back up" — closes an armed deadline |
| `rollback` | `instance`, optional `tag` | restore a snapshot image and recreate |
| `wake` | `channel`, `detail` | relay a wake into the waker's own spool |

`reason` is accepted on anything and is worth writing: it ends up in the journal
and in the wake you get back.

```sh
# Your own spool. Clawcius: /var/lib/clawcius/run/ops.
#                 Hamachi: /var/lib/hamachi/run/ops.
OPS=$CLAWCIUS_STATE_DIR/run/ops
STAMP=$(date +%s)
printf '%s' '{"verb":"task","instance":"clawcius","task":"clawcius.service has been
restarting every 30s since the last deploy. Find out why and fix it. Do not
change anything outside the checkout without saying so."}' > $OPS/$STAMP.tmp \
  && mv $OPS/$STAMP.tmp $OPS/$STAMP.json
```

There is no `requester` field and there must never be one. **The spool you wrote
into is who you are** — see [Provenance](#provenance-is-the-directory-not-a-field).

### Which verbs were kept, and why

Deleted: `restart`, `pull`, `redeploy`, `snapshot`. Each of them is now a
sentence a task can say, and each was an argument allowlist to maintain.
`snapshot` is not gone as a *behaviour* — every task takes one before it starts,
which is strictly more than a verb somebody had to remember to call.

The three that were kept are plumbing, and each survived for its own reason:

- **`checkin` could not have been dropped.** It is the answer to a question the
  executor asked. A destructive task arms a deadline and rolls the instance back
  on silence, so the check-in has to work when the instance answering it has
  just been rebuilt and may be barely alive. It runs no command and is answered
  inline without taking the lock. Routing it through a model would make the
  recovery path depend on the thing being recovered.
- **`rollback` is deliberately not delegated.** It is the undo, and the undo is
  the safety property that replaced the verb list. "Whatever it does can be
  undone" is worth nothing if undoing is itself a free-text task carried out by
  the same machinery that just broke something. It is a fixed argv — retag an
  image, recreate a container — and the automatic deadline path calls the same
  code, so it exists whether or not it is exposed.
- **`wake` is not a privilege at all.** It relays a wake into the waker's own
  spool, which the agent can already write. It runs no command and grants
  nothing, so deleting it would remove a documented capability in exchange for
  nothing.

## What a task actually does

1. **Refuse early.** Disabled? Frozen? Out of scope for this requester? Service
   account missing, root-equivalent, or able to read a secret? Nothing starts —
   and, in the last case, nothing is spawned at all.
2. **Sample health.** `systemctl is-active` for every unit under `units:`,
   `docker container inspect` for every instance. This is the baseline, and
   having one is what makes "this was already broken" distinguishable from "this
   task broke it".
3. **Snapshot every instance in scope**, and record the tag to go back to. If
   the snapshot fails, the task is refused: a session with a shell and no
   rollback target is not a deployment, it is a coin toss.
4. **Wait for an idle turn** on every instance in scope. A task may recreate a
   container and every live agent session is a `docker exec` into one.
5. **Run the session**, auditing every Bash command as it is issued.
6. **Sample health again and compare.** Anything that was up and is now not is a
   regression.
7. **Roll back** if the agent reported failure, the audit came out incomplete,
   the report says "failed", or health regressed.
8. **Arm a check-in deadline** for each instance the task actually touched.
9. **Report back** into the requester's wake spool.

### Scope: naming an instance is how you buy a cheap task

A task may name an `instance`. If it does, that instance is what gets
snapshotted, idle-waited, health-checked and rolled back.

**If it names none, every configured instance is in scope.** That default is the
expensive one on purpose. "Which containers might this sentence disturb" has no
answer — it is prose, and the session has a shell — and the only safe reading of
"no answer" is the same one `readIdle` uses for a missing waker status file:
assume the dangerous case. So an unnamed task costs a `docker commit` per
instance and a wait for all of them to go idle.

An instance restricted by `mayRequest.instances` may not file an unnamed task at
all, because for it "unnamed" would be *wider* than what it is allowed rather
than narrower and slower. It is refused with the fix in the message.

## The audit is the accountability mechanism now

Every Bash invocation the session makes is written into
`/var/lib/clawcius-ops/journal.jsonl` as its own entry, with the **full command
string**, byte for byte, in the `command` field — not summarised, not re-quoted,
not shortened. Evidence that has been tidied up is not evidence.

```sh
sudo grep '"kind":"audit"' /var/lib/clawcius-ops/journal.jsonl | jq -r '.command'
```

Three properties matter more than the format:

- **It is written before the result is known.** Not collected and flushed at the
  end. A session killed by a timeout mid-`rm` still has that `rm` on disk; a
  buffer inside a process that just died is not a record.
- **An incomplete audit fails the task.** Every command arrives through the
  agent's stream-json output, so a line that could not be parsed is a command we
  cannot swear we logged. That fails the task on its own and triggers the
  rollback. A command that runs and is not logged is the one failure this design
  cannot tolerate, and the honest response to "we might have missed one" is to
  put the container back.
- **The sub-agent tool is denied.** A sub-agent's tool calls do not appear in
  this session's stream, so a Bash command run inside one would execute
  unaudited. Denying `Task` is what makes "one conversation" true, and "one
  conversation" is what makes the audit complete.

It reaches the status page through the existing contract and needed no new
plumbing: audit entries *are* journal entries, so they are already in the last
hundred events in `<stateDir>/ops-status.json`, which is the file `status/`
reads off local disk. `ops-status.json` also gained `hostAgent` (what this
daemon is now capable of), `auditedCommands` and `lastTask`. Nothing was
removed, so a reader written against the old shape still works.

## Snapshot before, roll back on failure

`redeploy` used to snapshot before recreating a container. Now every task does,
for every instance in scope, and the tag is captured at that moment rather than
looked up afterwards — because afterwards the newest snapshot could easily be
one taken of the broken state.

On failure the executor retags that exact snapshot and recreates the container,
without being asked and without waiting for an idle turn. The idle wait already
happened before the task; a container a failed task has just wedged may never
report idle again, and waiting for it would turn "roll back on failure" into
"roll back unless the failure was bad enough to matter".

**This is container-scoped, and that limit is the most important sentence in
this document.** `docker commit` captures an agent container's writable layer.
It does not capture `/etc`, the checkout, systemd units, or anything else on the
host. A task that breaks the host filesystem is undone by the VPS snapshot and
by git, by a person. The operator accepted that explicitly; it is written here so
that nobody has to discover it.

Because a snapshot is now taken per task rather than per night, `snapshotKeep`
raises `docker/snapshot.sh`'s retention from 8 to 24. The ring is shared with the
nightly timer and whoever runs last prunes to their own ceiling, so at 8 a busy
evening would evict the previous night's backup by morning. This costs disk.

## Dry run — on by default, and genuinely unable to act

`ops-config.yaml` ships with `dryRun: true`, **and it should stay that way until
you have read the log.**

The executor still makes every decision it would really make. The difference
from every other dry-run in this repository is that the session is not asked
nicely: **the Bash tool is removed from it by Claude Code's permission system**,
along with everything else that can change the machine. It investigates with
read-only tools and then writes out the exact list of commands it would have
run, and that list goes in the journal.

### What was learned by testing this, on 2026-08-10

Claude Code's permission semantics are not what they look like. Every line below
was established by running `claude -p` against real settings and reading the
stream, not by reasoning:

- `deny: ["Bash"]` **removes the tool from the session entirely.** The init
  message's tool list does not contain it and the model reports that it has no
  way to run anything.
- **Deny survives `--permission-mode bypassPermissions`.** With
  `deny: ["Bash(gh:*)"]` and that mode, `echo` ran and `gh --version` came back
  *"Permission to use Bash with command gh --version has been denied"*, recorded
  in the result message's `permission_denials`. The mode removes the questions
  nobody is there to answer; the deny rules are what actually bound the session.
- `Write(<path>)` **allow rules are inert** — only `Edit(path)` is matched
  against file paths — `deny: ["Write(*)"]` removes the Write tool rather than
  scoping it, and `deny: ["Edit(*)"]` does not restrict paths at all. Nothing
  here relies on any of that. Where a tool should be gone, the bare tool name is
  used.
- **Denying Bash alone does not stop execution.** The session still held `Task`,
  `Monitor`, `CronCreate`, `RemoteTrigger`, `Workflow`, `Skill`, `Write` and
  `Edit` — and the model, asked to run a command with Bash denied, pointed out
  unprompted that `Monitor` "does execute a shell command" and offered to use
  it. That is why `DRY_RUN_TOOL_DENY` in `src/host-agent.ts` is long and blunt.
  Naming a tool that does not exist in a given install is harmless; missing one
  is not.

With the shipped dry-run settings the session's tool list comes back as
`['Glob', 'Grep', 'Read']`, an attempt to `Write` is refused with *"No such tool
available"*, and the file it was asked to create does not exist afterwards.

## The trust model

> **The spool is written by an agent that may be prompt-injected, and read by a
> root process that starts a shell session with sudo.**

That sentence used to end "…and this service is where the container boundary is
enforced". It does not any more. **For this component the sandbox has stopped
being a security boundary.** The operator was warned twice and accepted the
trade in writing. What is offered in exchange is rollback, the audit log, the
fact that this is a personal VPS with snapshots — and, since 2026-08-11, an
OS-level boundary that is not a sandbox but is real: the session runs as an
account that cannot become root.

**The trust model has now changed three times in two days, so here is the
honest state of it in one place:**

| | 2026-08-09 | 2026-08-10 | 2026-08-11 | 2026-08-12 |
|---|---|---|---|---|
| What bounds the privileged work | a closed list of seven verbs with argument allowlists | nothing in front of prose; a snapshot, a rollback and an audit behind it | the same, **plus** an unprivileged account, an enumerated sudoers file, and no docker socket | the same, with the sudoers file's four holes closed and its false comments corrected |
| Who the privileged work runs as | root, for two build commands, dropped to the checkout's owner | the whole session, as the checkout's owner — i.e. the operator, i.e. the `docker` group, i.e. root | `clawcius-ops`, refused at start if it is root-equivalent | unchanged |
| Is the sudoers file a boundary | it was four rules for the waker | **no** — `docker run -v /:/host` went round it | it *claimed* "yes, mostly, one gap" — and that claim was **wrong**: `sudo install` was one command to full root | **yes** — the one remaining gap is unit-content plus restart, and it is now genuinely the only one |
| Is the audit tamper-proof | n/a | **no** — the session could become root and rewrite it | **no**, though nobody knew it: `rm -f` reached `journal.jsonl` and `journalctl --vacuum-time` erased the system journal | **hard, not impossible** — the remaining path is install-a-unit-and-restart, which is three obvious lines in the log |
| Can the session read the operator's credentials | yes | yes — `.env`, `~/.claude`, `~/.ssh` | **no** for `.env`/`~/.claude`/`~/.ssh` — but `sudo install /root/.ssh/id_ed25519 …/clawcius-x.service` copied any root-only file out, and `docker inspect` printed the other agents' API keys | **no**, and both of those are closed |

The 2026-08-11 column is written the way it is on purpose: it is what this
document *said* on 2026-08-11, next to what was actually true. Three of those
five rows were wrong, and they were wrong because they described the sudoers
file's comments rather than its rules. A trust model is not a summary of what a
config file says about itself.

Everything below is what is still true.

### The 2026-08-12 audit

`ops/clawcius-sudoers` was audited adversarially — six independent lenses, then
a two-of-three refutation round; nine findings survived. The mechanism behind
all four of the exploitable ones is one sentence:

> sudo joins the arguments into **one string** and `fnmatch`es it without
> `FNM_PATHNAME`, so a `*` in an argument position is not "one argument", it is
> **any number of arguments** — handed to a program that re-parses them as flags.

| Finding | What it actually granted | Fix |
|---|---|---|
| `install -m 0644 -o root -g root * /etc/systemd/system/clawcius*.service` | **Full root in one command.** `-t /etc/sudoers.d` redirects the write (GNU install applies flags last-wins), so an attacker-authored `clawcius-ops ALL=(ALL) NOPASSWD: ALL` lands in `/etc/sudoers.d` at 0644 root:root. Also `-m 4755 -t /tmp /bin/bash` for a setuid shell, and an absolute source to copy `/root/.ssh/id_ed25519` anywhere readable. | **Rule deleted.** Unit installs moved into `ops/src/units.ts`. |
| `rm -f /etc/systemd/system/clawcius*.service` | **Arbitrary root deletion.** Two project-prefixed names with anything between them matched, including `/var/lib/clawcius-ops/journal.jsonl` — the audit log, the breaker, the armed deadlines. | **Rule deleted.** Same replacement. |
| `..` in either destination | `/etc/systemd/system/clawcius/../ssh.service` matched both rules, so "namespaced" reached sshd and every other unit file. | Subsumed by the deletions; the code-side validator refuses `..` and separators outright. |
| `journalctl *`, documented "read-only" | `--vacuum-time=1s`, `--rotate`, `--flush`, `--relinquish-var`: erasing the host journal as root, in one command. | **Rule deleted.** Journal reading is `systemd-journal` group membership. |
| `docker inspect *` in a READ alias | Prints `Config.Env` for the sibling agent containers — the other agents' API keys — plus their mount table. Undisclosed, while the far smaller `systemctl show` leak was documented two sections up. | Enumerated `--format` invocations that cannot print an environment. |

The other four survivors were the file's own comments claiming things that were
not true. Those are corrected in place, with the date and the reason, which is
the part of this change most worth reading.

### The host agent must never ingest untrusted content

This is the security model now.

> **OJ reads hostile input and holds no credential.
> This agent holds everything and must read nothing hostile.**

Its inputs are task files from the agents and a briefing the executor assembled
itself out of read-only probes — unit states, container states, `git rev-parse`,
the list of uncommitted filenames. **Never a PR diff. Never repository files
from a branch under review. Never OJ's findings. Never a web page.**

Enforced three ways, in descending order of how much they are worth:

1. **Structurally.** The only text that reaches the prompt is the request's
   `task` field plus facts this daemon gathered. There is no code path in `ops/`
   that reads a diff, a pull request, or a file from a branch.
2. **By tool policy.** `WebFetch`, `WebSearch` and the sub-agent tool are denied
   outright; `Bash(gh:*)`, `Bash(curl:*)` and `Bash(wget:*)` are denied by rule.
3. **By instruction.** The standing system prompt says so in as many words, and
   tells the session that a task asking it to read untrusted content is either a
   mistake or an injection and gets the same answer either way.

The second and third are defence in depth over a shell, and neither is airtight:
`sh -c 'curl …'` is one layer of indirection away. The first is the one that
holds, and it holds only as long as nobody adds a feature to this directory that
reads something a stranger wrote. If someone wires this session up to summarise
a pull request, the trade the operator accepted has silently become a
prompt-injectable root shell — and it will look like a feature.

### It holds no Discord token, and that is asserted rather than assumed

The session reports its result back through the spool and the **sandboxed agent
does the talking**. A session with a shell, sudo and a chat credential is a
session that can be talked into impersonation.

Its environment is built from an allowlist, the same shape as `worker.ts` in the
OJ project and for the same reason: a denylist has to anticipate every name a
credential might be under and fails open on the one nobody thought of, while
starting from nothing fails closed. `assertNoSecrets()` then re-checks the built
environment and **refuses to spawn** — not warns — if any variable name looks
like a credential (`DISCORD*`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_API_KEY`)
or if any value contains the live Discord token as a substring. An operator can
override that per-name with `hostAgent.envPassthrough`, which is the point: it
makes "yes, I mean it" a diff somebody reviewed.

`clawcius-ops.service` has no `EnvironmentFile` at all and must never gain one.
The session authenticates with the **agent account's own** Claude Code OAuth
credentials under `/var/lib/clawcius-agent` — a second login, established once
by hand ([`MIGRATION.md` § 4](../MIGRATION.md)), deliberately not the
operator's.

### The service account (2026-08-11)

> **The session runs as `clawcius-ops`, an unprivileged system account that is
> not in the `docker` group — and the daemon refuses to start it if that ever
> stops being true.**

This is the change that makes everything else on this page mean something, so
it is worth being blunt about what it replaced.

Until 2026-08-11 the session was dropped to *"whoever owns the checkout"*,
discovered by `stat`, with a comment explaining that this daemon "is not
entitled to an opinion about who owns a directory it was pointed at". That
reasoning is right for a **build step** and exactly backwards for an
**identity**. On this host the checkout is owned by `npurcell`, and SETUP.md
adds `npurcell` to the `docker` group with the comment *"docker group is
effectively root on the host"*. So:

- **the sudoers file was not a boundary.** `docker run -v /:/host alpine chroot
  /host sh` is a root shell in one command, with no `sudo`, no rule and no
  audit entry in the path;
- **the audit was not tamper-proof.** `journal.jsonl` is 0750 and root-owned,
  and was one `docker run -v` away from being rewritten by the session it was
  recording;
- **"it holds no Discord token" was not true in any useful sense.** The session
  could `cat /home/npurcell/clawcius/.env`. Asserting the token is not in its
  *environment* bought nothing.

#### What is asserted, and where

`ops/src/agent-user.ts` refuses to start a session as an account that:

- **does not exist.** There is no fallback to the checkout's owner and no
  fallback to root. A missing account means every task is refused with the
  `useradd` line in the message;
- **has uid 0**, however it is spelled;
- **is in any root-equivalent group**: `docker`, `podman`, `lxd`, `sudo`,
  `wheel`, `root`, `disk`, `shadow`, or `adm`. Each has its own recorded reason
  in that file. `hostAgent.forbiddenGroups` can add to that list and there is
  deliberately no key that removes from it;
- **can read a configured secret.** `hostAgent.secretPaths` plus every
  instance's `envFile`, which is folded in automatically because those hold
  `DISCORD_TOKEN`. Judged from mode bits, walking the ancestor directories for
  the traverse bit before checking read on the target — `~/.ssh/id_ed25519` is
  0600 inside a 0700 directory, and a check that only looked at the file would
  be right by accident.

Three layers, and the order matters:

1. **at boot**, for the banner and `ops-status.json`. Visibility only;
2. **before every task**, in the executor, which refuses with the fix;
3. **immediately before `spawn`**, in `host-agent.ts`, in the same seat as
   `assertNoSecrets`. This one exists so no code path added later can reach a
   session start without it.

**It is checked per task rather than once at boot, and that is the important
design decision.** The membership this is guarding against —
`usermod -aG docker clawcius-ops`, typed to make something work — is added to a
**running** host. A boot-time check on a unit that stays up for weeks would
never see it.

**It does not `exit(1)`.** This unit is `Restart=always` with
`StartLimitIntervalSec=0`; refusing to boot would be a five-second restart loop
with every armed rollback deadline unhonoured, which is the shape of #7. The
daemon comes up, holds its deadlines, answers check-ins, performs rollbacks —
and refuses every task, loudly. That is exactly what `hostAgent.enabled: false`
already does, and this codebase already argues it is strictly better than
stopping the unit.

#### How the drop is performed

`setuid(2)`/`setgid(2)` by libuv in the forked child before `execve` — not
`sudo -u`, not `su`. It *drops* privilege rather than gaining it, so
`NoNewPrivileges` has no bearing on it (NNP still has to stay `false` for the
sake of the `sudo` the session itself runs; different argument, same file).

More precisely, since 2026-08-13: the `uid`/`gid` spawn options are **not used
at all**, and that is deliberate. libuv's `uv__process_child_init` runs

```c
if (options->flags & (UV_PROCESS_SETUID | UV_PROCESS_SETGID))
  SAVE_ERRNO(setgroups(0, NULL));      /* then setgid, then setuid */
```

in the forked child whenever either option is present. It **clears the
supplementary group list**. That is a sane default — it is there to stop a
child that is nominally unprivileged from still carrying root's groups — but it
means no arrangement of the *parent's* groups can ever reach the session, and
it is why #21 saw

```
uid=997(clawcius-ops) gid=988(clawcius-ops) groups=988(clawcius-ops)
```

from a session whose boot banner named three groups. The version between
2026-08-11 and 2026-08-13 (`withSupplementaryGroups`, which set this daemon's
own group list around the synchronous `spawn`) could never have worked.

What runs instead is a short `node -e` bootstrap, spawned as root with no
`uid`/`gid` options, which performs the whole transition itself and then
`process.execve`s the session:

```
setgroups(agent.gids) → setgid(agent.gid) → setuid(agent.uid)
  → read getuid/getgid/getgroups back and compare against the intent
  → execve(claude, argv, env)     # same pid, same process group, same pipes
```

`execve` rather than a nested spawn, so `child.pid`, `detached`, `killTree`, the
stdio pipes and the timeout all mean exactly what they meant before. The source
is the `PRIVILEGE_DROP_BOOTSTRAP` string in `src/host-agent.ts` — inline rather
than a second file in `dist/`, because a separate artifact is a second thing
that can be stale, and "stale build" was the first suspect in #21.

**The drop is now verified rather than announced.** The bootstrap compares what
the kernel gave it against what `/etc/group` said it should get, and if they
differ it prints why and exits `120` **without exec-ing anything** — no session
starts. On success it prints one line that the executor parses and writes to the
journal, so the record contains an *observed* credential:

```
[ops] host agent: privilege drop — uid=997(clawcius-ops) gid=988 groups=988(clawcius-ops),1500(clawcius-dev),999(systemd-journal)
  — read back from the kernel in the session process itself, not from /etc/group
```

That distinction is the lesson of #21. The boot banner, `describeAgentUser` and
the per-session log line were all correct and all useless, because every one of
them printed the *intent*: `resolveAgentUser` read `/etc/group`, and nothing in
the pipeline ever asked the kernel what the child actually got. **When checking
this, run `id` in a live session. Reading `/etc/group`, or the boot banner, only
tells you what was asked for.**

On a Node without `process.execve` (< 22.15) the launcher falls back to the old
`spawn({ uid, gid })` and says so loudly in the journal. That path still drops
uid and gid correctly and provably ends with an *empty* supplementary list: the
session loses journal access and the shared checkout, which is a loss of
capability rather than of containment. Degrading toward less privilege is the
right direction for a fallback; degrading silently is not.

#### Filesystem: a shared group, not shared ownership

The agent has to write the checkout (`git pull`, `npm ci`, `dist/`) and must not
read the operator's secrets. Those are only compatible through a group:
`clawcius-dev`, with both accounts in it, the checkout group-writable, and
**setgid on every directory** so files created later inherit the group instead
of the creator's. `.env*`, `~/.claude` and `~/.ssh` stay `npurcell`-owned and
`go-rwx`.

Two things that will cost an evening if they are skipped, both in
[`MIGRATION.md` § 2](../MIGRATION.md):

- `/home/npurcell` must be `o+x` or the checkout inside it is unreachable
  whatever its own mode says;
- **git refuses a checkout owned by another user** — `fatal: detected dubious
  ownership in repository` — until
  `sudo -u clawcius-ops git config --global --add safe.directory <path>`.

If the group is not set up, the executor **warns** rather than refusing: the
symptom (every build failing with `EACCES`) is loud on its own, and a `chmod`
nobody noticed should not take the whole ops mechanism offline.

#### Private repositories: a deploy key, never a token

`hostAgent.gitSshKey` is a **path**. There is deliberately no configuration key
anywhere in `ops/` that accepts a token: a PAT would have to reach the session
through its environment, where `assertNoSecrets` refuses `*_TOKEN` outright,
and a PAT in a session with a shell can push, open pull requests and read every
private repository the operator has. A read-only deploy key owned by the agent
account is scoped to one repository and revoked on its own. The executor turns
the path into `GIT_SSH_COMMAND=ssh -i … -o IdentitiesOnly=yes -o
StrictHostKeyChecking=yes -o BatchMode=yes` and warns at boot if the key is
missing, owned by somebody else, or group-readable.

#### What it still cannot do about the original 2026-08-09 failure

Nothing changed there and it is worth saying: a session that is not root cannot
leave a root-owned `node_modules/` behind by accident. The **new** failure in
that family is the mirror image — an agent that cannot write the tree at all —
and that is what the shared group and the boot warning are for.

### What still holds, unchanged

**Provenance.** The requester is the spool directory the file was found in, one
per instance, each bind-mounted into exactly one container. It is stamped on in
`src/spool.ts` where the file's contents cannot reach it, and a request that
writes `"requester": "clawcius"` into Hamachi's spool is logged as an ignored
unknown field and attributed to Hamachi.

**Structural rejection, not repair.** Malformed JSON is discarded whole. Nothing
salvages the parseable prefix of a broken file and nothing coerces types.

**Traversal and control bytes are refused, not stripped**, on every identifier —
`instance`, `tag`, `channel` — even though they are never used as paths.

**Every identifier is still a lookup, not a value.** `instance` is compared by
exact equality against config and what reaches a docker argv is the config
entry. That rule is intact everywhere the *executor* builds a command. It cannot
apply to a task, which is prose.

**No shell in the executor.** Every command this daemon runs is an argv array
handed to `execFile` with `shell: false`. The host agent obviously runs a shell —
that is what it is for — and every string it hands to it is in the audit.

**Caps everywhere.** Per-file size cap enforced by `stat` before the file is
opened; a cap on files per sweep; a ceiling on files present, past which the
spool is drained unread; a rolling-hour cap on accepted operations; a bounded
queue; a wall-clock timeout and a **dollar ceiling** per task.

**The state directory is out of reach of the containers.** The journal, the
breaker and any armed deadline live in `/var/lib/clawcius-ops`, which is not
bind-mounted anywhere and is 0750 root-owned. The loader refuses to start if it
is ever placed inside any spool, or inside the host agent's working directory.

**The host agent's working directory is not the checkout.** Claude Code
auto-discovers `CLAUDE.md` and project settings from its cwd, and the checkout
is a tree the agents can get commits merged into — so a session pointed at it
would take standing instructions from anything they could merge. It is
`/var/lib/clawcius-host-agent`, and the loader refuses a `workDir` inside any
repo path, any spool, or `stateDir`.

**The idle signal is out of reach too.** Each waker publishes
`/var/lib/<instance>/waker-status.json`, a sibling of the bind-mounted `run/`
directory rather than a child of it. The executor believes that file when it
decides whether recreating a container would kill a live turn; an agent that
could write "no turns in flight" could talk root into destroying a session
mid-conversation. Both config loaders — the waker's and this one's — refuse to
start if the path ends up inside a mount: its own wake spool, its own or any
other instance's ops spool, and (since 2026-08-11) *another instance's wake
spool*, which was the one pairing the first version of these checks missed.

**The spool's own directory is not trusted either.** It sits inside a mount the
agent owns, so the agent can delete it and put a symlink in its place. Nothing
in the executor follows one: see "What it will not do, and why" above. This is
the sharpest instance of the general rule, because the process on the other end
of the path is root and the operations are `chown`, `readdir` and `unlink`. A
spool that is a real directory but owned by the wrong uid is not followed
either, and — since the second review of PR #8 — is no longer *silent*: the
sweeper says so on the first sweep that sees it, with the `chown` to run.

### What this does *not* protect against

Honest list, and it is longer than it was.

- **The host agent can do a great deal on this host.** That is the feature. It
  is bounded by the account's permissions, the sudoers file, the rate limit, the
  timeout, the budget, the lock and the rollback. There is still no allowlist in
  front of prose and there cannot be — what changed on 2026-08-11 is that the
  *other* bounds became real rather than notional.
- **A task filed by mail has no rollback at all.** The snapshot went with the
  scheduling on 2026-08-14. The health sample either side survives and it
  reports; nothing restores. This is a deliberate reduction in what the executor
  will do for you, taken in exchange for a host agent you can actually talk to.
- **The rollback is containers only** — on the spool path, where it still
  exists. `/etc`, the checkout, unit files, packages: not covered. VPS snapshots
  and git are the recovery path, and a person is the one who invokes them.
- **The board is a file this daemon opens as root and reads rows out of.** It is
  outside every bind mount by construction — the config loader refuses a
  `board.db` inside any spool and `board.ts` refuses a path that is not a
  regular file — but the *contents* are written by the instance's waker, which
  is fed by files the container writes. What is trusted from it is exactly one
  thing: the `author` column, which the waker stamps from the drop directory and
  never reads from a body. The role that column resolves to is what decides
  whether the task runs.
- **The audit is much harder to tamper with than it was, and still not
  tamper-proof.** Until 2026-08-11 this entry read: *"the session runs as
  `npurcell`, and `npurcell` is in the `docker` group … anything that can become
  root can rewrite `journal.jsonl`"*. On 2026-08-11 it was rewritten to say that
  "no sudoers rule reaches `/var/lib/clawcius-ops`", which was **false** — `rm
  -f /etc/systemd/system/clawcius*.service` reached it, along with anything else
  on the disk, and `journalctl --vacuum-time=1s` erased the system journal
  beside it. Both rules are gone as of 2026-08-12 and the sentence is now true
  by inspection: no remaining rule names that directory, and no remaining rule
  takes a `*` in a writing position at all. The remaining path is the one named
  in § Sudoers — install a unit, reload, restart a named unit — which is root in
  three steps that are themselves in the journal, fsynced before they ran, the
  first of them as its own `"kind":"unit"` entry. It is a record against
  carelessness and confusion, and now also against a casual adversary; it is not
  a record against one who is willing to be obvious.
- **A single account holds both the deploy capability and the debugging
  capability.** The agent can get `clawcius.service` installed *and* restart it,
  which is the escalation above. The unit's *content* is still written by the
  session — moving the install into the executor pinned the destination, the
  mode and the owner, not the bytes. Splitting those across two accounts with a human
  between them is possible and has not been done, because the operator's whole
  complaint was about being the human between things.
- **`mayRequest` bounds what an instance may ASK for, not what the agent may
  DO.** A task scoped to `hamachi` is still carried out by a session with a
  shell, and nothing but the task text and the standing prompt points it at
  Hamachi rather than at anything else on the box. It is a statement of intent
  that the journal records.
- **`mayRequest.units` and `mayRequest.repos` are now inert.** No request carries
  a unit or a repo. The loader says so loudly at boot rather than failing to
  start, and anybody who wrote them believing they restricted something is now
  wrong.
- **A dirty tree no longer stops anything.** The check that refused a `pull` is
  gone; the filenames go into the briefing and the standing prompt forbids
  `reset --hard`, `checkout -f`, `stash` and `clean`. An instruction can be
  forgotten in a way a check cannot. This was a deliberate trade: sometimes the
  right answer during an incident *is* to work in a dirty tree, and a daemon
  that could not was a daemon the operator worked around by hand.
- **The build is an instruction again.** Nothing here compiles on start, and the
  hour that cost on 2026-08-09 is now prevented by a standing rule plus the
  per-repo `buildDirs` in the briefing rather than by a step that cannot be
  skipped.
- **A task that names no instance may still touch one.** Scope-by-omission takes
  everything, so the snapshot and the rollback do cover it — but nothing stops
  the session from touching a container the requester was not thinking about.
  The deadline machinery catches this after the fact by scanning the audit for
  container names, which is over-broad on purpose.
- **`task`, `reason` and `detail` are attacker-influenced text.** `task` now
  reaches a model's prompt, which is not safer than reaching a shell — it is the
  deal. The rest end up in the journal, in `ops-status.json`, and in wake
  prompts; anything rendering them owes them the same suspicion.
- **The symlink defence around the spool directory is a check, not a
  transaction.** Every sweep `lstat`s the spool and refuses anything that is
  not a real directory, and every request file is opened `O_NOFOLLOW |
  O_NONBLOCK`; but Node exposes no `unlinkat`, so the sweep re-resolves the
  directory by name for each file it removes. An agent swapping the directory
  for a symlink inside that window could in principle still get a `.json`
  removed elsewhere. The persistent case — plant a link and wait for the
  restart, which was the actual bug — is refused and reported. Fixing the
  residual race needs directory descriptors and `*at()` syscalls this runtime
  does not offer, so it is written down rather than half-done.
- **Root is root.** This service being small and readable is still the
  mitigation for the supervisor. It is not a mitigation for the session.

## Why a separate daemon

`restart clawcius.service` is one of the things a task will ask for. A process
cannot restart itself: systemd sends it SIGTERM, it dies, and whatever it was
doing dies with it — including the record of what it was doing and any deadline
it had just armed. The argument is stronger for a container recreate: every live
agent session *is* a `docker exec` into the container being recreated.

So it is a unit of its own, with no Discord connection and no GitHub token. It
now has a model, and `src/host-agent.ts` is where that decision is written down
in full.

## One task at a time

A lock, not a negotiation. Two host agent sessions with sudo running
concurrently on the same box is not a scenario anybody should have to reason
about, and it is much worse than the two overlapping docker operations this lock
was originally written to prevent. A second request queues; past
`limits.maxQueued` it is refused with a reason the agent can read.

Missing, stale, malformed or future-dated waker status all read as *busy*. The
stale case is the important one: a waker that crashed leaves a file saying
`liveCount: 0` forever, and a stale zero is the most dangerous value in this
system because it is the one that reads as permission.

## The deadline, and the revert

After a task that touched an instance, the executor:

1. files a wake to that instance carrying context — *a host task touched you
   because `<reason>`; here is what to check; check in within N minutes*;
2. waits `deadline.minutes` for a `checkin` request from it;
3. on silence, rolls back to the snapshot taken immediately **before** the task,
   and reports.

**The automatic rollback waits at most a minute for an idle turn, and then goes
ahead anyway.** A requested rollback waits `idle.maxWaitMinutes` and, if the
instance never reports idle, abandons itself rather than killing a live turn —
somebody asked for it, and somebody can be told no. A rollback after a missed
check-in is not a request, it is a recovery, and until 2026-08-11 (review of
PR #9) it took the requested path: an instance whose rebuild had wedged it
never reported idle, so the wait ran for the full half hour and then abandoned
the rollback — leaving the instance on the build that broke it, and, because
that return happened before the quarantine, leaving the breaker unaware that a
recovery had failed. A wedged container is exactly when the rollback matters
most. The minute is kept because a missed check-in can also mean an agent that
is alive and simply did not file one, and a lost turn is worth avoiding when it
is cheap; it is capped by `idle.maxWaitMinutes`, so `0` still means "never
wait". Going ahead is journalled, in those words. `#restoreAll` — the rollback
after a *failed task* — skips the wait entirely, for the same reason and with
one fewer doubt.

"Touched" is answered from the audit: the task named it, or its container name,
image or one of the deploy scripts appears in a command the session ran. That is
a substring match over shell text and is deliberately over-broad — a false
positive costs one wake and one check-in, a false negative is an instance
recreated with nobody waiting to hear whether it came back.

### Circuit breaker

- A build that has been rolled back once is **quarantined** and identified by the
  `buildRepo` checkout's HEAD, so a fix — which is a new commit — goes through on
  its own.
- After `breaker.maxConsecutiveFailedRecoveries` consecutive failed recoveries
  the executor **freezes** and refuses `task` and `rollback`. `checkin` and
  `wake` still work, so an instance that is alive can still say so — otherwise a
  freeze would guarantee the next deadline was missed too.
- A failed recovery is a missed check-in **or a task that actually had to be
  rolled back**. A task that failed harmlessly — a typo, a refusal, an agent that
  decided the request was unsafe — does not count, or two badly worded sentences
  in a row would take the whole mechanism offline.
- All of it is persisted. A breaker that clears when its process restarts is not
  a breaker, and the host agent can restart this process.

```sh
sudo ops/unfreeze.sh          # prints the reason, asks, then clears
sudo systemctl restart clawcius-ops
```

There is deliberately no `unfreeze` task-that-counts: a task *could* run
`unfreeze.sh`, and that is one more thing the audit is for.

## Sudoers

`ops/clawcius-sudoers` grants **`clawcius-ops`** — not `npurcell` — passwordless
sudo. It was rewritten on 2026-08-11 and every wildcard in it was removed,
because for the first time its contents are the actual bound on what the session
can do rather than a description of the polite route.

| Grant | Scope | Why |
|---|---|---|
| `systemctl restart` / `start` / `stop` / `enable` / `disable` / `reset-failed` | **Named units only**: `clawcius`, `hamachi`, `clawcius-status`, the two `*-container` units, `clawcius-netguard`, the snapshot service and timers, and `oj` / `oj-container` (which do not exist yet). | The old `restart *` permitted `sshd`, `systemd-journald` and the firewall. Naming them costs one line per new unit, which is the right price for the step that runs new code as root forever. |
| `systemctl daemon-reload` | Bare, no arguments | Makes an installed unit visible. Changes nothing on its own. |
| `systemctl status` / `is-active` / `is-enabled` / `is-failed` / `show` / `cat` / `list-units` / `list-timers` | **Any unit** | Reading state cannot break anything, and an agent debugging `clawcius.service` needs to look at what it depends on. |
| `docker ps` / `images` / `logs` / `stats --no-stream` / `version` / `info` | Read-only; `logs` restricted to the three agent containers | This section did not exist before — the previous grantee reached docker through group membership, so a rule "would add nothing except the false impression that docker access is being controlled here". |
| `docker inspect --format …` | **Enumerated**: six state formats × the three agent containers, plus `{{.Id}}` for the three images | Narrowed on 2026-08-12. The previous `docker inspect *` printed `Config.Env` — the sibling agents' API keys — from an alias called READ. No `*` on these lines: a trailing one re-admits a second `--format`, and docker takes the last. |
| `docker restart` / `stop` / `start` | `clawcius-agent`, `hamachi-agent`, `oj-agent` | "The agent container is wedged" is a real task. |
| `mkdir -p`, `chown`, `chmod` | **Exact paths** under `/var/lib/{clawcius,hamachi,oj}/run` | Repair, mostly: the executor creates and chowns every spool at boot. |

**Removed on 2026-08-12, and not replaced by a narrower rule:**

| Was | Why it is gone | What does the job now |
|---|---|---|
| `journalctl` (any argument) | It was not read-only. `--vacuum-time`/`--rotate`/`--flush` destroy the journal, and no sudoers pattern can exclude them — journalctl's getopt permutes, so any surviving `*` re-admits them. | `sudo usermod -aG systemd-journal clawcius-ops`. Plain `journalctl -u <unit>` with no sudo. `agentWarnings` nags on every task until the membership exists. |
| `install …`, `rm -f …` against `/etc/systemd/system` | One command to full root; see the audit table above. Unfixable in place. | `ops/src/units.ts` — the executor writes the file itself, as root. |

**Installing a unit, since 2026-08-12.** The session writes the content to
`<hostAgent.workDir>/units/<name>` and drops
`{"op":"install","unit":"<name>"}` into `<workDir>/unit-requests/`; the executor
serves it within a second, while the session is still running, and writes the
answer to `<workDir>/unit-results/`. It validates the NAME against
`^[a-z0-9][a-z0-9-]*\.(service|timer)$` — with separate refusals for separators,
`..`, whitespace and control bytes, so the message says which — requires one of
this project's prefixes, refuses `clawcius-ops.service` outright, reads the
content through an `O_NOFOLLOW` descriptor so a staged symlink cannot be
published, and writes to a path **it** computes at mode 0644 root:root set on
the descriptor. The request has two fields and neither is a path. Every
operation and every refusal is a `"kind":"unit"` journal entry naming the
destination.

**`clawcius-ops.service` is deliberately not on the restartable list.** It is
the process that starts the session; restarting it kills the task mid-flight,
loses the record and silently restarts a recovery window. Until 2026-08-11 that
was prevented by a sentence in the standing prompt; it is now prevented by a
missing line as well, and the prompt still explains *why* so the refusal is
understood rather than routed around. **`docker.service` is off the list too** —
restarting it takes both agents down at once.

Deliberately **not** granted: `docker run` / `create` / `exec` / `cp` / `build`
/ `commit` (the first is `-v /:/host`, i.e. root; the second is root inside a
container that bind-mounts a spool, i.e. forged provenance; the third is `sudo
cp` wearing a container), `apt`/`npm`/`pip` as root, `systemctl edit` (opens
`$EDITOR` as root), `visudo`/`usermod`/`gpasswd`/`passwd`/`su` — `usermod -aG
docker clawcius-ops` is now specifically the thing this account must not be able
to do to itself — `setfacl`/`chattr`/`mount` (each a way past the mode bits the
secret check reads), and any blanket interpreter: no `sudo sh`, `bash`,
`python3`, `env`, `tee`, `cp`, `dd`, `mv`, `ln` or `find` — and, since
2026-08-12, `install`, `rm` and `journalctl`, which belonged in that last list
from the beginning. `install` is `cp` that can also set the mode and the owner;
`rm` with a wildcard argument spec cannot be made to mean one file; `journalctl`
can delete the journal. Each was treated as a special case for two days because
the flags on the rule looked like a constraint.

**No rule may ever name a path inside the checkout.** The agent can write
`/home/npurcell/clawcius` (that is what the shared group is for), so
`sudo /home/npurcell/clawcius/docker/run-container.sh` would be "run this file I
can edit, as root" — i.e. `sudo ALL`. That is why there is no rule for
`run-container.sh` or `snapshot.sh` even though the agent obviously needs
containers recreated: **the executor runs those two itself, as root, with an
argv it builds.**

### Two things about sudo's matching that shaped the file

- **`*` matches `/` and spaces.** sudo joins the arguments into one string and
  `fnmatch`es it without `FNM_PATHNAME`. So the old `chown … /var/lib/clawcius*`
  matched `/var/lib/clawcius/../../etc`, and the old `restart *` matched any
  unit at all. That was documented and shrugged off on the grounds that the
  docker group made it moot. It is not moot any more, so the paths are
  enumerated.
- **A fixed prefix and a fixed suffix are not a constraint.** The 2026-08-11
  version of the file said a surviving `*` was safe if what it matched "cannot
  escape a fixed prefix AND a fixed suffix". That bounds the first and last
  token of the flattened string and nothing in between — not the number of
  arguments, not whether they are flags. It is the sentence the audit walked
  through four times. The rule now is narrower: **a `*` may appear only after a
  pinned, read-only subcommand, where the worst thing it can absorb is more
  read-only flags for that same subcommand.** When a capability cannot be
  expressed that way, it belongs in the executor — which is root already and can
  build an argv — and not in a cleverer pattern.
- **Unit names need their suffix.** `systemctl restart clawcius` and
  `… clawcius.service` are the same to systemd and different strings to sudo,
  and only the second is granted. A refusal on a unit you are sure is listed is
  almost always this. Both spellings are not listed, deliberately: the value of
  the file is that it can be read in one sitting.

### What it still does not buy, stated plainly

**Installing a unit file plus restarting a named unit is root, in two audited
steps.** Overwrite `clawcius.service`, `daemon-reload`, restart. There is no way
to remove that without also removing the ability to deploy this project's own
units, which is the capability the whole mechanism exists to provide. What it
costs the adversary is that both steps are in the journal, in full, fsynced
before they ran, and they look like exactly what they are.

It also **has still not been checked with `visudo -c`** — the machine it was
written on has no sudo. Do that before installing, from a second shell that
already holds root. [`MIGRATION.md` § 3](../MIGRATION.md) has the sequence.

## `pull` refused a dirty tree. Now the briefing names the files instead.

On 2026-08-09, on the host:

```
error: Your local changes to the following files would be overwritten by merge:
        docker/run-container.sh
```

Git was right, and right in the way that matters: those edits were real fixes
someone had made in place during an incident and had not yet committed. Every
tempting way past that message — `reset --hard`, `checkout -f`, `stash`,
`clean -fd` — destroys or hides them, and the one that "keeps" the work hides it
somewhere nobody looks until the next incident.

The executor no longer refuses on it, because there is no `pull` verb to refuse.
What it does instead:

- `readDirty` runs before every task and the **exact filenames** go into the
  briefing, with the sentence about 2026-08-09 attached;
- the standing system prompt forbids `reset`, `checkout -f`, `stash` and `clean`
  by name;
- a `git status` that cannot be read is reported as dirty, not as clean. Unknown
  and dangerous are the same state;
- and **this daemon still has no such command of its own**. Grep `ops/src` for
  `reset`, `stash` and `clean`: nothing. The self-test asserts that absence
  against the compiled output, which is the part that a refactor cannot quietly
  undo.

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
  adversary picks the target. That warning is emitted **on every sweep**, from
  the sweeper itself, and not only by `ensureSpoolDir` — because the second
  review of PR #8 pointed out that the daemon only ever called `ensureSpoolDir`
  when the spool was *missing*, so a spool that was already there with the
  wrong owner was swept happily and forever while the container got `EACCES` on
  every `mv` and nothing was logged at all. That state is reachable without an
  adversary: `run-container.sh`'s `mkdir -p "$OPS_DIR"` assumes it runs as
  `npurcell`, and the executor invokes that script itself, as root, on a
  `--recreate`. A warning that the running configuration cannot reach is not a
  warning. It is repeated at most once per state change rather than every five
  seconds, and it does not stop the sweep: a real directory is safe to read,
  and refusing here would turn a diagnostic into an outage;
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
      instances: [hamachi]        # task/rollback/checkin targets, and the
                                  # instance a `wake` channel routes to
      verbs: [task, checkin, wake]
```

`units:` and `repos:` used to be here too. **They are now inert** — no request
carries a unit or a repo — and the loader says so in the boot journal rather
than failing to start, on the same reasoning as the old `spoolDir` key: this
unit is `Restart=always` with no start limit, and refusing to boot on a stale
key turns a cosmetic problem into a restart loop with every deadline
unhonoured. Anybody who wrote them believing they restricted something is now
wrong, which is exactly why the notice exists.

- **No `mayRequest` block means unrestricted**, which is what every instance had
  before this existed. Upgrading changes nothing until somebody writes one.
- A key left out is unrestricted. A key present is an exact-match allowlist. A
  key present and empty (`instances: []`) means none at all, which is a
  legitimate thing to say and is not confused with absent.
- Every name is checked against the real lists at boot. A typo in
  `mayRequest.instances` would otherwise be a silent total denial of something
  the operator believed they had granted, and a restriction that fails closed by
  accident is indistinguishable from a broken executor.
- An **unnamed task** from a restricted instance is refused. Scope-by-omission
  takes every instance, so for a restricted one "unnamed" is wider than what it
  is allowed rather than narrower.
- Refusals are journalled with the requester and the reason, and are checked
  **before** the rate limit, so an agent looping on requests it may not make
  cannot starve the one doing real work.
- `wake` is checked twice: at intake for the verb, and again after routing,
  because a wake names a channel and the target instance is not known until it
  has been resolved. Waking somebody else's agent with attacker-influenced text
  is exactly what a restricted instance should not be able to do.

This is **not** a security boundary, and since 2026-08-10 it is even less of one
than it was: it bounds what an instance may *ask for*, not what the host agent
may *do*. A task scoped to `hamachi` is still carried out by a session with a
shell and sudo, and nothing but the task text and the standing prompt points it
at Hamachi rather than at anything else on the box. It is a statement of intent
that the journal records, which is genuinely useful. It is the narrower thing
that per-instance spools made expressible for the first time:
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

## Running it

```sh
cd ops
npm install
npm run build
npm start                      # reads ./ops-config.yaml
npm run selftest               # no docker, no systemd, no real claude required
```

Override the config path with `OPS_CONFIG_PATH`.

Installation and the systemd units are in [SETUP.md](../SETUP.md) § 7.

## Configuration

`ops-config.yaml` is **no longer the authorization model**, and reading it as
though it were is how somebody ends up believing they are protected by a list.
It now holds three different kinds of thing:

- a **health manifest** (`units:`, `repos:`) — what gets checked before and
  after every task and what the session is briefed about. Leaving something out
  does not make it safe, it makes it unwatched;
- **real invariants** — the containment assertions, unchanged and still
  load-bearing;
- **limits** — how often, how long, how much money. Never *what*.

`instances:` is the one list that still gates something: it decides what may be
named as a rollback or check-in target, and what gets snapshotted and rolled
back. Every key has a default in `src/config.ts` and the loader validates types
and cross-field invariants, so a typo fails the boot with the offending key
named rather than producing an executor that quietly does nothing.

The cross-field checks worth knowing about, because they are security
properties rather than tidiness:

- `stateDir` may not be inside any instance's `opsSpoolDir` or `wakeSpoolDir`;
- an instance's `wakerStatusFile` may not be inside its own wake spool or *any*
  instance's ops spool — the neighbour's counts, and on this host the two state
  directories are siblings under `/var/lib`, so a fat-fingered path lands in the
  neighbour rather than nowhere;
- no two instances may share an `opsSpoolDir`, and none may nest inside another;
- an `opsSpoolDir` may not contain or be contained by any `wakeSpoolDir`;
- `mayRequest` may only name instances and verbs that exist; `units` and `repos`
  are accepted, inert, and produce a deprecation notice in the boot journal
  rather than a boot failure;
- `hostAgent.workDir` may not be inside any spool, inside `stateDir`, or inside
  any checkout under `repos:` — a session that can write a spool can forge a
  request from whichever instance owns it, and a session whose cwd is a checkout
  takes standing instructions from anything the agents can get merged;
- `buildRepo` must name a real entry under `repos:`, or the breaker cannot
  identify a build;
- `repos[].buildDirs` must be relative and must resolve inside the checkout —
  it names a subdirectory of an already-authorised repo, not a second way to
  nominate a directory for a root process to run `npm` in;
- `snapshotVerify.instances` must name real instances, and `probe` may not be
  empty — an empty probe would report every restore as healthy;
- `hostAgent.user` must be a plain account name, and `hostAgent.secretPaths`
  and `hostAgent.gitSshKey` must be absolute — a relative "secret path" would
  resolve against whatever working directory systemd happened to give the unit,
  and a check silently pointing at the wrong file reads as a pass.

The keys added on 2026-08-11 are asymmetric on purpose:
`hostAgent.forbiddenGroups` and `hostAgent.secretPaths` can only make the
identity checks **stricter**. There is no key that takes `docker` off the
refusal list and there must never be one — a key that can widen a session with
sudo is a key somebody widens at 3am. `hostAgent.passwdPath` and
`hostAgent.groupPath` exist so the self-test can drive the real resolution path
against fixture files; on a real host there is no reason to touch them.

## Layout

```
ops/
  ops-config.yaml        the authorization model
  unfreeze.sh            human-only: clear the breaker's freeze
  clawcius-sudoers       what the host agent may do with sudo, and why
  src/
    index.ts             daemon entry, single-instance lock, signals
    config.ts            typed YAML loader, defaults, containment assertions
    agent-user.ts        WHO THE SESSION IS. Resolves the named service account
                         out of /etc/passwd + /etc/group and refuses to run as
                         one that is missing, is uid 0, is in a root-equivalent
                         group, or can read a configured secret. Read this
                         second, after host-agent.ts.
    build.ts             what state the checkout's tree is in (for the
                         briefing). It used to answer "who owns the checkout,
                         because that is who the session runs as"; that
                         question moved to agent-user.ts on 2026-08-11 and the
                         reversal is explained there.
    units.ts             INSTALLING AND REMOVING UNIT FILES, as root, with the
                         destination/mode/owner built in code. It exists
                         because the two sudo rules that used to do this were
                         one command to full root; the header records the
                         exploits. Read it with clawcius-sudoers open.
    request.ts           parsing and validating hostile spool content
    spool.ts             one directory-as-a-queue per instance; the caps, and
                         the stamp that says whose it was
    host-agent.ts        the session: env allowlist, tool policy, the standing
                         prompt, stream-json parsing and the audit. READ THIS
                         FILE FIRST — it is where the trust model lives.
    executor.ts          the lock, the task supervisor, snapshot/health/rollback,
                         deadline, breaker
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
diagnosed as a git problem.

Re-audited on 2026-08-10 with the host agent in mind, when the session's `HOME`
was `/home/npurcell` and that was where Claude Code kept the OAuth credentials
it authenticated with. **That particular argument expired on 2026-08-11**: HOME
is now `/var/lib/clawcius-agent`, which `ProtectHome` does not touch, and it
would be easy to conclude from that alone that `read-only` is safe to add now.
It is not — the checkout is still under `/home` and still has to be written, so
the original 2026-08-09 argument above is the live one. The unit file records
that its *justification* changed while its *verdict* did not, because losing
that distinction is exactly how a directive that is fatal for reason B gets
added because reason A was fixed. There is a near miss next to it: `ExecStart` is
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

`MemoryMax` went 512M → 2G → **6G**, and `TasksMax` 128 → 512 → **1024**. The
first raise was for the build; the second, on 2026-08-10, is for the host agent.
systemd's `MemoryMax` applies to the unit's whole cgroup, children included, and
the children are now this daemon *plus* a `claude` session holding a
conversation *plus* whatever that session runs, concurrently — which is expected
to include `npm ci` and `tsc` over three packages. Under 2G the failure mode is
the cgroup OOM-killing a build halfway through (a build failure with no compiler
error in it) or, worse, killing the session mid-task and leaving the host in
whatever state it had reached.

6G is not a measurement, it is headroom on a box that can spare it: too high
costs nothing until something runs away, too low costs a task that fails for a
reason appearing nowhere in its own logs. Measure with `systemd-cgtop` during a
real task before lowering it. The containers a task starts do *not* count
against this; docker puts them in their own slice.

`StateDirectory` gained `clawcius-host-agent`, a **sibling** of the executor's
state rather than a child. The session needs to write its working directory;
putting it inside a 0750 root-owned directory would mean either the session
cannot traverse to it or the journal and the breaker stop being 0750. Since
2026-08-11 the executor chowns it to `hostAgent.user` rather than to the
checkout's owner.

There is a name collision here worth knowing about before it bites somebody:
the executor's `StateDirectory` is `/var/lib/clawcius-ops` **and the service
account is also called `clawcius-ops`**. Those must not be the same tree — the
state directory holds the journal, the breaker and the armed deadlines, and an
account whose `$HOME` is there owns the breaker that quarantines it.
`MIGRATION.md § 1` therefore creates the account with
`--home-dir /var/lib/clawcius-agent`. The executor warns at boot if it ever
finds otherwise.

`RestrictSUIDSGID=true` was re-checked on 2026-08-11 and nearly broke: the
shared-group scheme puts the **setgid bit on every directory in the checkout**,
and `chmod g+s` on a directory is precisely what that filter blocks. It survives
because those chmods are run by the operator from their own shell during the
migration, not by a task, and therefore not inside this unit's cgroup. A future
task that needs to create a setgid directory will fail here with an `EPERM` on
`chmod` that looks nothing like a systemd setting; the answer is that the
operator runs that one command.

Checked and deliberately still absent, each with the reason recorded in the
unit itself:

| Directive | Verdict |
|---|---|
| `MemoryDenyWriteExecute` | Never. Any Node process dies at startup. |
| `NoNewPrivileges` | Stays `false`, and since 2026-08-10 that is **mandatory** rather than cautious. `sudo` is a setuid binary and NNP makes the setuid bit a no-op, so under it every sudo call the host agent makes fails — with a message about the effective uid that reads like a broken sudoers file rather than a unit setting. Note the asymmetry that used to be the whole entry: *dropping* privilege via `setuid(2)` is unaffected by NNP, so the session's own privilege drop would work fine. It is the sudo inside the session that would not. Re-checked 2026-08-11 and now *more* load-bearing: sudo is the session's only privileged path, where before it also had the docker group. |
| `SystemCallFilter` | No. `@system-service` would probably cover docker, systemctl, git, npm and node — including `@setuid` for the drop — and "would probably cover" is the phrase that preceded the SIGTRAP loop. It now also has to cover *whatever a task chooses to run*, which is not a set anybody can enumerate. A filter one syscall short kills a task *halfway through*. |
| `IPAddressDeny` | No, and not close. `git pull` reaches GitHub and `npm ci` reaches the registry; denial surfaces as timeouts, not refusals. |
| `PrivateTmp` | No. npm stages tarballs through `TMPDIR`, and a private `/tmp` also hides it from the operator debugging this at 3am. |
| `ProtectSystem` | `strict` breaks the docker socket (a read-only `/run` denies the write permission a unix socket connect needs). `full` is likely fine and likewise untested. |
| `RestrictSUIDSGID` | Kept. It restricts *creating* setuid files; it does not touch `setuid(2)` and does not stop *executing* an existing setuid binary — checked deliberately, because if it did it would break `sudo` and therefore the host agent, exactly as NNP would. Re-checked 2026-08-11: it **does** block `chmod g+s` on a directory, which the shared-group scheme needs. Survives only because those chmods are the operator's, run outside this cgroup. |
| `SupplementaryGroups=` | Not added, and it would do nothing: it applies to the unit's own `User=`, which is root. The session's supplementary groups are set by the privilege-drop bootstrap in `src/host-agent.ts`, in the child, because they have to be the *agent's* and systemd has no directive for "the groups of a process this unit forks with a different uid". Setting them on the unit would in fact be worse than useless — libuv discards the inherited list in any child spawned with the `uid`/`gid` options, which is #21. |
| `User=` the agent instead of root | Rejected. The executor itself needs the docker socket for snapshots, rollbacks and the health sample, and giving the agent account that means putting it in the `docker` group — which is precisely what this whole rework forbids. The split is the design: a small readable root supervisor, and an unprivileged session that is neither. |

`clawcius-snapshot-verify.service` carried no hardening block at all, which is
the only reason it had nothing fatal in it. It now carries the same reasoning
written down, plus a `MemoryMax` sized for a node process driving a docker
client — the 2 GB container it starts lives in docker's cgroup, not the unit's.

## What has and has not been tested

`npm run selftest` runs with no docker, no systemd and no npm, and no real
`claude`. It covers request validation against hostile inputs (traversal,
separators, NUL and control bytes, shell metacharacters, unknown verbs, wrong
types, malformed JSON, oversized files), the spool's caps and flood handling,
the config loader's containment assertions, the lock and queue, the idle logic
against synthetic waker status files including the stale-zero case, breaker
persistence across a fresh `StateStore`, deadline expiry driving an automatic
rollback and quarantine, and deadlines restored after a restart.

The privileged binaries are replaced with stand-ins that record their argv one
element per line, which is what proves no shell string is being built by the
executor. `claude` is replaced by a stand-in that emits genuine stream-json and
**honours the deny list it is handed** — a denied Bash is a Bash tool that does
not exist in that session, exactly as the real CLI was observed to behave — so
the dry-run assertions test the whole chain rather than a flag.

The tests added for the host agent on 2026-08-10:

- a task reaches a session with the task text in the prompt, `--setting-sources
  user`, `--strict-mcp-config`, `--disable-slash-commands`, a fresh
  `--session-id` and never `--resume`, and a working directory that is **not**
  the checkout;
- **every** Bash command in the stream reaches the journal, in order, byte for
  byte — including one with spaces, quotes and a semicolon in it — and the first
  audit entry is written before the `finished` entry rather than flushed with it;
- an unparseable line in the stream fails the task **on its own** and triggers
  the rollback, and the auditor says so at the time as well as in the summary;
- a task snapshots before the session starts and, when the agent reports
  failure, restores that exact tag by name — not "the newest", which after a
  failed task could easily be one taken of the broken state;
- a health regression rolls the task back **even though the agent said it
  succeeded**, and `compareHealth` reports only things that got worse (fixing
  something is not a regression, and a service that was already dead is not
  blamed on the task);
- dry-run: the settings actually sent deny `Bash`, `Task`, `Monitor`, `Write`,
  `Edit` and `WebFetch`, the tool list is exactly `Read, Glob, Grep`, and — the
  assertion that matters — a task told to `touch` a file leaves no file;
- `assertNoSecrets` throws on `DISCORD_TOKEN` **and** on `GITHUB_TOKEN`,
  `ANTHROPIC_API_KEY`, `DB_PASSWORD`, `MY_SECRET` and `DISCORD_WEBHOOK`, passes
  ordinary variables, and honours an explicit `envPassthrough` exemption;
- the built environment inherits nothing by accident, carries the checkout
  owner's `HOME` rather than root's, and contains no token;
- a clean exit with `is_error: true` is a failure, not a success — the CLI does
  exactly that when the model's own turn ends badly, and reading the exit code
  alone would arm a deadline off a task that failed;
- an unnamed task snapshots **every** instance, and a restricted instance may
  not file one;
- a deadline is armed for an instance the task never named, because a command in
  the audit mentioned its container;
- the result is reported back into the requester's wake spool, with the command
  count, rather than spoken by the host agent;
- tasks can be switched off (`hostAgent.enabled: false`) while check-ins and
  rollbacks keep working, and a freeze refuses tasks while still letting an
  instance check in;
- the compiled output of `ops/src` contains no `reset`, `stash`, `clean` or
  `checkout -f` — asserted against `dist/`, which is the part a refactor cannot
  quietly undo.

The tests added for the service account on 2026-08-11 — all of which run with
no root, no docker, no systemd and no `clawcius-ops` account on the machine,
because `/etc/passwd` and `/etc/group` are text files and the fixture writes
text files:

- the named account is resolved with **both** its primary group (by gid) and
  its supplementary ones (by member list) — a check that read only the member
  lists would miss an account whose *primary* group is `docker`, which is
  exactly how somebody would set this up without thinking about it, and there
  is a separate test for that case;
- a **missing** account refuses the task, with the `useradd` line in the
  message, and **no session is spawned** — there is no fallback to the
  checkout's owner and that is asserted rather than assumed;
- an account **in the docker group** refuses the task, names the group, prints
  the `gpasswd -d`, spawns nothing, is reported as `identity.ok: false` in
  `ops-status.json`, and **`assertAgentIdentity` throws on its own** —
  independently of the executor, so a future code path that reaches `spawn`
  without going through `#doTask` still cannot start;
- every group in the built-in list is refused, not just `docker`, and
  `hostAgent.forbiddenGroups` only ever adds to it;
- an account with **uid 0** is refused however it is spelled (the fixture calls
  it `toor`);
- an **unreadable `/etc/group` is a refusal, not a pass** — the assertion the
  rest of the design rests on must not fail open;
- a **secret the account can read** refuses the task, names the file, prints
  the `chmod` — and tightening the mode lets the same task through with **no
  restart**, which is the per-task evaluation being tested rather than
  described;
- the readability check **walks the ancestor directories** for the traverse bit
  before checking read on the target (the `~/.ssh` shape: 0600 files inside a
  0700 directory), and a path that does not exist is reported with the reason
  rather than as "safe";
- a checkout the account cannot write is a **warning**, not a refusal: the
  session still starts, and the warning — with the `chgrp` in it — is in the
  durable record;
- the environment carries the **service account's** `HOME`, not the operator's,
  which is the line that decides whose Claude Code login the session uses;
- the standing prompt tells the session which account it holds, that it is not
  in the docker group, and that `clawcius-ops.service` is not on the
  restartable list.

The per-instance-spool tests from earlier the same day are unchanged in intent
and were rewritten onto `task`: two spools drained concurrently with each
request attributed to its own directory, a request claiming
`"requester": "clawcius"` inside Hamachi's spool still attributed to Hamachi,
"hamachi acting on hamachi" and "hamachi acting on clawcius" producing different
journal lines, an automatic rollback attributed to `(executor)`, the
`mayRequest` refusals, the containment assertions across several spools, the
deprecated `spoolDir` migration, and the check-in instructions naming the
instance's *own* spool.

The spool-directory tests from PR #8's two reviews came in with that branch and
are the sharpest ones in the file, because every failure they describe is
silent and privileged:

- a symlink where the spool should be is refused rather than chowned: the link
  is still a link afterwards, the directory it points at still has every file
  it had, and nothing behind it was read as a request or unlinked by the root
  sweep. A non-directory of any kind gets the same treatment, and so does a
  symlinked `.json` *inside* a real spool;
- a fresh host — state directory present, nothing under it — ends up with
  `run/` **and** `run/ops` existing, owned like the state directory, mode 0770
  and not the umask's 0750; a *missing* state directory creates nothing at all,
  and the spool appears by itself on a later sweep;
- an already-existing spool whose owner does not match the state directory
  produces the WARNING **from the sweeper**, carrying the exact `chown` — once,
  not once per sweep — while the directory is left exactly as it was found and
  requests filed in it still arrive;
- a **FIFO** named like a request (`mkfifo 1.json`, which the agent owns the
  directory to do) is discarded, and the request behind it is still delivered.
  It runs in a child process with a deadline, because the regression it guards
  against is a *hang*: without `O_NONBLOCK` the sweep blocks in `open(2)` until
  a writer appears, and a test that hangs cannot report from inside the thread
  that is hung.

The two added for the second review of PR #9 are both about the automatic
rollback, which is the least-exercised path in the daemon and the one that runs
when everything else has already gone wrong:

- a deadline rollback that has to **queue behind a busy operation** still
  quarantines the build it rolled back, is still attributed to `(executor)`,
  and still counts towards the breaker. There is one way into `#doRollback` and
  the origin travels on the job, so the idle path and the queued path cannot
  drift apart again;
- an instance that **never reports idle again** — a status file that keeps
  saying a turn is in flight, which is what a wedged rebuild looks like — is
  rolled back anyway, within the bounded wait, and quarantined. The same test
  asserts that a *requested* rollback still gives up rather than interrupting a
  live turn, because that difference is the whole decision.

### Verified by hand, against the real CLI

Everything in [Dry run](#dry-run--on-by-default-and-genuinely-unable-to-act)
was established by running `claude -p` on 2026-08-10 and reading the stream.
None of it is inferable from a stand-in and none of it matches what the
documentation would lead you to expect, which is exactly why it was tested. The
most useful finding was the one nobody was looking for: with only `Bash` denied,
the model itself pointed out that `Monitor` runs a shell command and offered to
use it.

### Not tested, and it needs a real host

- **No task has ever been run for real.** No `claude` session has been started
  by this daemon on the host, no snapshot has been committed or restored, no
  container has been recreated, no unit has been restarted.
- **Nothing in `MIGRATION.md` has been executed.** No `useradd`, no `groupadd`,
  no `chgrp`/`chmod`/`find` on the checkout, no `claude auth` as another
  account, no `ssh-keygen` deploy key, no `git pull` as `clawcius-ops` in a tree
  owned by `npurcell`. The document says so at the top.
- **The privilege drop itself is only half exercised.** The self-test's fixture
  account carries the test process's own uid — it has to, because dropping to
  another uid needs root — so the `setgroups`/`setgid`/`setuid` transition is
  never actually performed here. What *is* executed, since 2026-08-13, is the
  bootstrap itself: handed the credentials the test process already holds it
  verifies them against the kernel and execs, and handed anybody else's — a
  group *name* where a gid belongs, a uid it cannot take, uid 0 — it refuses
  with a message and execs nothing. That plus an assertion that the spawn
  options carry no `uid`/`gid` key is as close as an unprivileged suite can get
  to #21. Check `id` inside a task's own report for the rest, and read the
  `host agent: privilege drop —` line in the journal, which is the observed
  credential rather than the intended one.
- **The sudoers file has never been parsed by `visudo -c`.** Do that first, from
  a shell that already has root. Still true on 2026-08-12, and re-checked rather
  than copied forward: the machine it is edited on has no `sudo` and no `visudo`
  binary at all. Two things in it are new syntax as of that date and are what to
  look at if it does not parse — the `{{.State.Status}}` format strings on the
  `docker inspect` lines, and the escaped colon in `clawcius-agent\:latest`.
- **No unit has been installed through `ops/src/units.ts` on a real host.** The
  self-test drives it against a temporary directory (`unitDir`), which proves
  the validation, the `O_NOFOLLOW` refusals, the computed destination, the mode
  and the atomic replace — but not the `fchown(0, 0)`, which is skipped when
  the process is not root, and not that systemd picks the file up. First install
  on the host: check `ls -l /etc/systemd/system/clawcius-*` for `root root` and
  `-rw-r--r--`, and `systemctl cat` the unit.
- **No unit in `systemd/` has been loaded since the audit below** — which is
  exactly the condition that produced the two units that shipped unable to run
  at all.
- `ensureSpoolDir`'s `fchown` and `ensureDirOwnedBy`'s `chown` have never run
  as root here, because the self-test does not run as root and cannot. What
  *is* tested without root is everything that decides whether the chown happens
  at all: the refusals, the `O_NOFOLLOW` open, which levels get created, and
  the mode. Check with `ls -ld /var/lib/*/run/ops /var/lib/clawcius-host-agent`
  after the first start — and if that ever shows a symlink, read the executor's
  log rather than fixing it quietly.
- The wake the executor files after a task has never been picked up by a live
  waker.

Run it with `dryRun: true` first and read the log. In that mode the session
cannot execute anything, and what lands in the journal is the list of commands
it would have run — which is the single most useful week of reading available
before turning this on.
