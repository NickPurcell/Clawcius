# ops

A host-side supervisor for a **host agent**: a headless Claude Code session,
running on the host with a shell and sudo, that carries out tasks the sandboxed
agents describe in free text.

Until 2026-08-10 this was a closed list of seven verbs and this file said, in
several places, that there must never be a model in it. That is no longer true.
Until 2026-08-16 the way in was a directory-as-a-queue that each container could
write, with a snapshot, an idle wait, a check-in deadline, an automatic rollback
and a circuit breaker built around it. That is gone too. The rest of this
document is about what changed, why, what was given up, and what was put in its
place — because the trust model has changed twice and this is the place that has
to say so honestly.

**The shortest honest summary: a coordinator DMs the host agent, the session
runs with sudo, every command it issues is written down before it is known to
have worked, and nothing undoes any of it.**

```
  agent containers                          host
  ┌────────────────────────┐               ┌──────────────────────────────────────┐
  │ clawcius               │   a DM, in    │ clawcius-ops.service (root)          │
  │  coordinator ──────────┼──────────────►│  one mailbox per crew, on that       │
  │    sendMail(           │   board.db,   │    crew's board                      │
  │      "clawcius-host")  │◄──────────────┤  the AUTHOR COLUMN names the asker   │
  ├────────────────────────┤   the reply   │  one task at a time — a second is    │
  │ hamachi                │               │    REFUSED, not queued               │
  │  coordinator ──────────┼──────────────►│  health sample ▸ SESSION ▸ health    │
  └────────────────────────┘               │    sample again ▸ REPORT             │
                                           │  every command audited, in full      │
   the boards live OUTSIDE every           │  nothing is rolled back              │
   bind mount; this daemon opens           └───────────────┬──────────────────────┘
   them as root and reads rows                             │ claude -p, as clawcius-ops,
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

## Ask by DM — and, since 2026-08-16, there is no other way in

Since 2026-08-14 the host agent is an ordinary Clawsky participant with a
mailbox and a registry row. **A DM to `<crew>-host` runs it, immediately**, and
the answer comes back as a DM:

```
sendMail(
  to:      "clawcius-host",
  subject: "clawcius.service is flapping",
  body:    "It has been restarting every 30s since the last deploy. Find out
            why and fix it. Do not change anything outside the checkout
            without saying so."
)
```

`sendMail` is one of the tools the waker builds per session, alongside
`checkMail` and the armed conditions that replaced the wake spool. It has no
`from` argument — the sender is the id the tool closes over — and it returns
what happened, so a coordinator that is refused is told in the same turn.

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

Most of what is below this line still holds: the account, the sudoers file, the
privilege drop, the tool deny-lists and the per-command audit are untouched, and
every one of them is in the path of a task filed by mail. The freeze is the
exception and it is the honest one — the flag is still read and still refuses
every task, but **nothing sets it any more**; see
[§ The freeze has no writer](#the-freeze-has-no-writer).

The host agent has a mailbox on an instance only if that instance has a `board:`
block in `ops-config.yaml`. Without one, a coordinator DMing `<crew>-host` is
told there is no such recipient, which is the honest answer — and since
2026-08-16 it is also the last answer, because there is no other door.

### Ask the host, not the operator (2026-08-17)

The verb list went because it turned the operator into the agent's hands. A
coordinator that asks the operator to run something is doing that again by
habit, with nothing in the way this time — so **DM the host agent by default,
and treat asking the operator as the exception that needs a reason.**

This is written down because it went wrong the ordinary way rather than the
interesting way. Across one incident on 2026-08-17 the operator copy-pasted
**seven** command outputs into Discord — `journalctl` for two units, a cgroup's
`memory.events`, `free`, `ps`, `systemctl --failed`, `ls /etc/systemd/system` —
and **the host agent could have produced every one of them.** Two other things
were asked of him that night and those two were genuine: a `docker inspect` with
a field outside the whitelist, and a `curl`. All nine were handed to the host
agent afterwards to check, and **the only two it could not serve were those same
two.** Nothing had refused the seven; nobody had asked. Some of that was at 04:00
local, which is the real cost of the habit.

The reasons that genuinely stand:

- **it needs `docker exec`, or a `docker inspect` field *or container* outside
  the enumerated set.** Both are deliberately ungranted rather than overlooked —
  `exec` is a session running as another crew with that crew's credentials
  (`ops/clawcius-sudoers:557`), and the `inspect` formats were enumerated on
  2026-08-12 because the wildcard printed the sibling agents' API keys. Note that
  those lines enumerate the **container** too, not only the format
  (`ops/clawcius-sudoers:614-634`): every one of them names `clawcius-agent`,
  `hamachi-agent` or `oj-agent`, so a refusal on any other container is not a
  wrong format and no format will fix it. See [§ Sudoers](#sudoers);
- **it needs an address neither of you can reach.** `curl`, `wget` and `gh` are
  in `LIVE_TOOL_DENY` (`ops/src/host-agent.ts:584`) **by design, not by
  oversight.** This session holds every credential on the box and is not
  sandboxed; the entire reason that is tolerable is that its input surface is
  task text a coordinator wrote and a briefing this daemon assembled. A fetch is
  how a stranger's words get into it. Filed as a capability gap in Clawcius #91
  and **closed as not planned** — this is not a limitation waiting to be lifted,
  so read that issue before proposing it a third time.

  **Do not widen that into "HTTP goes to the operator".** A coordinator's own
  container fetches the public internet perfectly well, and sending it a URL to
  paste back is the habit this whole section exists to break. What a container
  cannot reach is the host's loopback and the private ranges, which Squid denies
  as *resolved* destinations — so DNS rebinding does not get around it either —
  and refuses with a clean 403 rather than a timeout
  (`squid/squid.conf:82-87`). Measured from inside an agent container on
  2026-08-18: `https://api.github.com/rate_limit` → **200**,
  `http://127.0.0.1:8477/healthz` → **000** (no route at all),
  `http://172.17.0.1:8477/healthz` → **403** (Squid, refusing an RFC1918
  destination). The exception is the *intersection* — unreachable from the
  container and unfetchable by this session — and "is the status page answering
  on 127.0.0.1?" is what it looks like in practice;
- **it needs a decision and not a fact.** The host reports; it does not choose.
  That one was never the host agent's to answer and never will be.

Everything else — reading a journal, a unit's state, a cgroup counter, what is
in `/etc/systemd/system`, how much memory is left — is a DM.

## The spools, and what went with them (2026-08-16)

There used to be two directory-as-a-queue spools, one pair per instance inside
the container's own bind mount:

- `<stateDir>/run/wake` — the agent dropped a JSON file naming a channel and a
  prompt, to ask its own waker to start a turn. Replaced by `remindMe` and
  `watchPr`, armed conditions in the waker (`src/armed.ts`, `src/armed-tool.ts`,
  `src/armed-wake.ts`) that are built per session and closed over that session's
  agent id, so "an agent may only schedule itself" is the absence of an argument
  rather than the rejection of one. The file it replaced named the channel, and
  nothing validated that name (Clawcius #39);
- `<stateDir>/run/ops` — the agent dropped a JSON request that this daemon
  parsed against a verb list and executed. Replaced by the DM above, which had
  already been in production for two days when the spool was removed.

Around that second directory stood a verb parser, a request schema, a bounded
queue, a rolling-hour rate limit, per-file and per-sweep and per-directory caps,
a per-instance `mayRequest:` restriction, a snapshot of every container in
scope, a wait for every container in scope to fall idle, a check-in deadline, an
automatic rollback on silence, a quarantine, and a circuit breaker counting the
rollbacks. **All of it is gone**, and the deletions are recorded here rather
than erased, because an in-place rollback to an older `dist/` brings the code
back and somebody will need to know what they are looking at.

It went because the input went. Nothing files a spool request, so every one of
those stages had no way to be reached, and code that cannot be reached is not a
safety property — it is a decoration that reads as one. The two things that
actually stood between a request and the machine were never the queue: they are
the unprivileged account with its narrow sudoers file, and the audit written
before each command's result is known.

**What was genuinely lost, and is not coming back with a different spelling:**

- **the undo.** No snapshot is taken before a task, so there is nothing to
  restore to. The reply says so in as many words;
- **the idle wait.** Nothing asks whether a container is mid-turn before a task
  runs that might recreate it;
- **the breaker's writer.** `frozen` still refuses every task and nothing sets
  it;
- **the per-instance restriction.** `mayRequest:` bounded what one instance
  could ask for. There is no equivalent; what stands in its place is the coarser
  and stronger rule that only a coordinator may ask at all.

The directories themselves are **not deleted from disk**, and `<stateDir>/run`
is still bind-mounted read-write into each container. Nothing on either side
reads or writes any of it. That mount is a change to what the agent can do
rather than to what the daemons read, so it wants its own diff; until then it is
a writable window onto the host that nothing uses.

## What a task actually does

1. **Refuse early.** Disabled (`hostAgent.enabled: false`)? Frozen? Already
   busy? Service account missing, root-equivalent, or able to read a secret?
   Nothing starts — and, in the last case, nothing is spawned at all. A refusal
   is a reply, in the same turn, to the coordinator that asked.
2. **Sample health.** `systemctl is-active` for every unit under `units:`,
   `docker container inspect` for every instance. This is the baseline, and
   having one is what makes "this was already broken" distinguishable from "this
   task broke it".
3. **Run the session**, auditing every Bash command as it is issued, and serving
   the unit desk every second while it runs.
4. **Sample health again and compare.** Anything that was up and is now not is a
   regression.
5. **Report.** The task is failed if the agent reported failure, if the audit
   came out incomplete, if the report says "failed", or if health regressed —
   and the reply says which. **Failing a task does not undo it.** Whatever it
   did is still done.

Steps 3 and 5 used to have a snapshot in front of them and a rollback behind
them. They do not. The health sample survived the removal because reporting a
regression is worth having on its own; what it can no longer do is trigger a
repair.

### Scope: a DM names no instance, and every instance is in the briefing

A spool request could carry an `instance` and buy a cheaper task with it. A DM
carries no such field, so the briefing covers every configured instance: every
unit under `units:`, every container, every repo's dirty state.

That is the **briefing's** scope, not a permission. It decides what facts the
session is handed and what the health sample watches — never what the session
may touch, which is unbounded by construction because the session has a shell.
An unscoped task used to cost a `docker commit` per instance and a wait for all
of them to go idle; now it costs two health samples, which is the honest measure
of how much less is being done for you.

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
  cannot swear we logged. That fails the task on its own. A command that runs
  and is not logged is the one failure this design cannot tolerate. Until
  2026-08-16 the response to "we might have missed one" was to put the container
  back; now it is to say so, in the journal and in the reply, and leave the
  decision to a person — which is weaker, and is the trade.
- **The sub-agent tool is denied.** A sub-agent's tool calls do not appear in
  this session's stream, so a Bash command run inside one would execute
  unaudited. Denying `Task` is what makes "one conversation" true, and "one
  conversation" is what makes the audit complete.

It reaches the status page through the existing contract and needed no new
plumbing: audit entries *are* journal entries, so they are already in the last
hundred events in `<stateDir>/ops-status.json`, which is the file `status/`
reads off local disk. `ops-status.json` also carries `hostAgent` (what this
daemon is now capable of), `auditedCommands` and `lastTask`. Two fields **were**
removed on 2026-08-16 — `queued`, because there is no queue, and `spools`,
because there are no spools. Both went from the `OpsStatusSnapshot` type *and*
from every writer of it, which is two: `Executor.snapshot()` in
`ops/src/executor.ts`, and the oneshot behind `clawcius-snapshot-verify.timer`
(`ops/src/verify-main.ts`), which publishes a stub snapshot of its own while it
runs and would otherwise have kept both keys alive in the published file after
the type stopped declaring them. Neither key is written by anything now, so a
reader built against the older shape has to tolerate their absence rather than
find a `queued: 0` and a `spools: []` still going out of habit. Everything else
is where it was.

## Nothing is rolled back, and that is the whole of it

There used to be a section here explaining that every task snapshotted every
instance in scope first, captured the tag at that moment rather than looking it
up afterwards, and retagged and recreated on failure. **All of that went with
the spools on 2026-08-16.** A task filed by DM takes no snapshot, so there is
nothing to restore to, and the reply says so rather than leaving a coordinator
to find out.

The sentence that used to be the most important one in this document was that
the rollback was container-scoped: `docker commit` captures an agent container's
writable layer, and not `/etc`, the checkout, systemd units, or anything else on
the host. It is worth keeping, inverted. **The scope is now nothing.** A task
that breaks a container is in exactly the same position as one that breaks the
host filesystem: the VPS snapshot and git are the undo, and a person operates
both. The operator accepted the smaller version of this trade explicitly on
2026-08-10 and the larger one on 2026-08-14; it is written here so that nobody
has to discover it.

`docker/snapshot.sh` and `clawcius-snapshot.timer` are untouched and still take
a nightly image per container. What no longer happens is a snapshot per task —
so `snapshotKeep: 24` in `ops-config.yaml` is now **inert**. It was there to
raise the shared retention ring from 8 because a busy evening of per-task
snapshots would otherwise evict the previous night's backup by morning; nothing
passes it to the script any more, `clawcius-snapshot.service` passes no `KEEP`,
and the script's own default of 8 is what is in force. The key still parses. It
does nothing.

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

> **A task is written by an agent that may be prompt-injected, and read by a
> root process that starts a shell session with sudo.**

That sentence used to name the spool, and used to end "…and this service is
where the container boundary is enforced". Neither clause is true any more.
**For this component the sandbox has stopped being a security boundary.** The
operator was warned twice and accepted the trade in writing. What was offered in
exchange was rollback, the audit log, the fact that this is a personal VPS with
snapshots — and, since 2026-08-11, an OS-level boundary that is not a sandbox
but is real: the session runs as an account that cannot become root. Since
2026-08-16 the rollback is not part of that exchange. What is left is the
account, the sudoers file, the audit, and the VPS snapshot a person restores.

**The trust model has now changed four times, so here is the honest state of it
in one place:**

| | 2026-08-09 | 2026-08-10 | 2026-08-11 | 2026-08-12 | 2026-08-16 |
|---|---|---|---|---|---|
| What bounds the privileged work | a closed list of seven verbs with argument allowlists | nothing in front of prose; a snapshot, a rollback and an audit behind it | the same, **plus** an unprivileged account, an enumerated sudoers file, and no docker socket | the same, with the sudoers file's four holes closed and its false comments corrected | the account, the sudoers file and the audit. **The snapshot and the rollback are gone**, and so is the queue in front of them |
| Who may ask | any process in any agent container, by writing a file | the same | the same | the same | **a crew's coordinator, by DM**, checked twice in two processes against the mail row's author column |
| Who the privileged work runs as | root, for two build commands, dropped to the checkout's owner | the whole session, as the checkout's owner — i.e. the operator, i.e. the `docker` group, i.e. root | `clawcius-ops`, refused at start if it is root-equivalent | unchanged | unchanged |
| Is the sudoers file a boundary | it was four rules for the waker | **no** — `docker run -v /:/host` went round it | it *claimed* "yes, mostly, one gap" — and that claim was **wrong**: `sudo install` was one command to full root | **yes** — the one remaining gap is unit-content plus restart, and it is now genuinely the only one | unchanged, and it is now carrying more of the weight than it was |
| Is the audit tamper-proof | n/a | **no** — the session could become root and rewrite it | **no**, though nobody knew it: `rm -f` reached `journal.jsonl` and `journalctl --vacuum-time` erased the system journal | **hard, not impossible** — the remaining path is install-a-unit-and-restart, which is three obvious lines in the log | unchanged |
| Can a bad task be undone by this daemon | `redeploy` snapshotted first | yes, per container, automatically | yes | yes | **no.** Nothing here undoes anything |
| Can the session read the operator's credentials | yes | yes — `.env`, `~/.claude`, `~/.ssh` | **no** for `.env`/`~/.claude`/`~/.ssh` — but `sudo install /root/.ssh/id_ed25519 …/clawcius-x.service` copied any root-only file out, and `docker inspect` printed the other agents' API keys | **no**, and both of those are closed | unchanged |

The 2026-08-11 column is written the way it is on purpose: it is what this
document *said* on 2026-08-11, next to what was actually true. Three of those
five rows were wrong, and they were wrong because they described the sudoers
file's comments rather than its rules. A trust model is not a summary of what a
config file says about itself. The 2026-08-16 column exists for the same reason
in the other direction: the temptation on a day when a lot of code is deleted is
to leave the paragraphs describing what it did, and a protection this file
claims and the code does not have is this codebase's worst recurring defect.

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

Its inputs are the body of a coordinator's DM and a briefing the executor
assembled itself out of read-only probes — unit states, container states, `git
rev-parse`, the list of uncommitted filenames. **Never a PR diff. Never
repository files from a branch under review. Never OJ's findings. Never a web
page.**

Enforced three ways, in descending order of how much they are worth:

1. **Structurally.** The only text that reaches the prompt is the message body,
   capped and stripped of control characters by `sanitiseTask`, plus facts this
   daemon gathered. There is no code path in `ops/` that reads a diff, a pull
   request, or a file from a branch.
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

The session's result is handed back to the executor, which writes it as a mail
row on the crew's board, and the **sandboxed agent does the talking**. A session
with a shell, sudo and a chat credential is a session that can be talked into
impersonation. The DM path did not change that: `ops/src/board.ts` writes a row
into SQLite as root and stops there — nothing in `ops/` opens a socket to
Discord, and there is still no Discord token anywhere in this unit's
environment.

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
`StartLimitIntervalSec=0`; refusing to boot would be a five-second restart loop,
which is the shape of #7. The daemon comes up, holds its mailboxes, answers the
coordinator that asked — and refuses every task, loudly, with the fix in the
reply. That is exactly what `hostAgent.enabled: false` already does, and this
codebase already argues it is strictly better than stopping the unit. The older
version of this paragraph added "and holds its deadlines, answers check-ins,
performs rollbacks", which was the stronger half of the argument and is no
longer available: there are no deadlines to hold. What is left is that a daemon
which is up can *say* why it is refusing, and one that is in a restart loop
cannot.

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

### What still holds

**Provenance.** The requester is the **author column** of the mail row, which
the instance's waker writes from the agent id that sending session's own
`sendMail` tool closes over — a variable in the waker's process that no argument
reaches. It is never read from a message body, and there is no field a message
can carry that gets near it. This is the same property the per-instance spools
bought, arrived at a different way: it used to be inherited from the mount (a
container can write exactly one directory), and it is now inherited from the
tool closure (a session can only send as itself). `ops/src/host-mailbox.ts`
re-reads that column and looks the role up again immediately before running
anything, in a second process from the one that accepted the DM.

**Structural rejection, not repair.** What arrives is a message, not a document
to be parsed, so most of the old surface is simply absent. What is left is
`sanitiseTask`: one cap on length, control characters stripped, and truncation
**reported** rather than silent — a coordinator whose last two paragraphs, the
ones saying what not to touch, were dropped without being told would be the
worst version of this.

**Every identifier is still a lookup, not a value.** Everywhere the *executor*
builds a command, the strings come from config, compared by exact equality. That
rule is intact. It cannot apply to a task, which is prose.

**No shell in the executor.** Every command this daemon runs is an argv array
handed to `execFile` with `shell: false`. The host agent obviously runs a shell —
that is what it is for — and every string it hands to it is in the audit.

**Two caps, where there used to be seven.** A wall-clock timeout and a **dollar
ceiling** per task, plus the lock. The rest — per-file size, files per sweep,
files present, operations per rolling hour, queue depth — bounded a directory an
agent could write, and went with the directory. There is no rate limit now:
nothing is counted, nothing is delayed, and a coordinator that asks twice in a
minute gets one task and one refusal.

**The state directory is out of reach of the containers.** The journal and the
audit live in `/var/lib/clawcius-ops`, which is not bind-mounted anywhere and is
0750 root-owned. A record of what was done to this host, writable by the party
it was done on behalf of, is not a record.

**The board is out of reach too.** `board.db` is what decides who is a
coordinator, and a coordinator is the only agent that may run commands here, so
a board inside a mount would be the access control being written by the party it
restrains. The loader refuses one, and `ops/src/board.ts` separately refuses a
path that is not a regular file.

**The host agent's working directory is not the checkout.** Claude Code
auto-discovers `CLAUDE.md` and project settings from its cwd, and the checkout
is a tree the agents can get commits merged into — so a session pointed at it
would take standing instructions from anything they could merge. It is
`/var/lib/clawcius-host-agent`, and the loader refuses a `workDir` inside any
repo path, inside `stateDir`, or overlapping any container's mount in either
direction.

**The containment checks are now written against the mount itself.** Until
2026-08-16 they named `opsSpoolDir` and `wakeSpoolDir` — two directories *inside*
the mount — which meant a path that was agent-writable but in neither of them
passed. They are now written against `join(instance.stateDir, 'run')`, which is
exactly what `docker/run-container.sh` bind-mounts read-write into that
instance's container, and it is derived rather than configured because the script
derives it too. Simpler, and strictly wider than what it replaced. Each check is
asked of **every** instance's mount rather than only the file's own: the two
state directories are siblings under `/var/lib`, so a fat-fingered path lands in
the neighbour rather than nowhere, and instance A's status file under B's mount
would mean B can declare A idle whenever it likes.

**The idle signal is still out of reach — and nothing reads it.** Each waker
publishes `/var/lib/<instance>/waker-status.json`, a sibling of the bind-mounted
`run/` directory rather than a child of it, and both config loaders still refuse
to start if that path lands inside a mount. `ops/src/idle.ts` still exists, still
fails safe in every ambiguous case, and is still under test. But **the executor
no longer consults it**: the idle wait was part of the spool apparatus, so
nothing in `ops/` now asks whether a container is mid-turn before running a task
that might recreate it. The `idle:` config block still parses and is still
validated. Do not read any of that as the executor waiting for an idle turn. It
does not.

### What this does *not* protect against

Honest list, and it is longer than it was.

- **The host agent can do a great deal on this host.** That is the feature. It
  is bounded by the account's permissions, the sudoers file, the timeout, the
  budget and the lock. It used to also say "the rate limit and the rollback",
  and both of those went on 2026-08-16. There is still no allowlist in front of
  prose and there cannot be — what changed on 2026-08-11 is that the *other*
  bounds became real rather than notional, and what changed on 2026-08-16 is
  that there are fewer of them.
- **Nothing undoes a task.** No snapshot is taken, so there is nothing to
  restore to; there is no check-in deadline, so a container that never comes
  back up is not noticed by anything here; and there is no automatic rollback,
  so a task that wedges an agent leaves it wedged. The health sample either side
  survives and it **reports**. This is a deliberate reduction in what the
  executor will do for you, taken in exchange for a host agent you can actually
  talk to, and it is the single most important line in this list.
- **`/etc`, the checkout, unit files and packages were never covered** by the
  rollback that existed, and now nothing is. VPS snapshots and git are the
  recovery path, and a person is the one who invokes them.
- **Nothing waits for an idle turn.** A task can recreate a container while a
  live agent session is a `docker exec` into it, and the turn dies with the
  container. The waker status file that would answer "is anything in flight" is
  still published and still validated; the executor stopped reading it.
- **The board is a file this daemon opens as root and reads rows out of.** It is
  outside every bind mount by construction — the config loader refuses a
  `board.db` inside `<stateDir>/run` for any instance, and `board.ts` refuses a
  path that is not a regular file — but the *contents* are written by the
  instance's waker, which is fed by tool calls the container's agents make. What
  is trusted from it is exactly one thing: the `author` column, which the waker
  writes from the id the sending session's own `sendMail` tool closes over, and
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
- **There is no per-instance restriction of any kind.** `mayRequest:` narrowed
  what one instance could ask for — which targets, which verbs — and it went with
  the spools on 2026-08-16. Nothing replaced it at that grain. The loader ignores
  the key and names it in the boot journal, so anybody who wrote one believing it
  restricted something is told. What stands in its place is coarser and, on its
  own terms, stronger: only a **coordinator** may ask at all, and there is
  exactly one thing that can be asked for. What is lost is the narrower
  statement — "Hamachi may look after itself and nothing else" — which is no
  longer expressible. It was never a boundary either: a task scoped to `hamachi`
  was always carried out by a session with a shell, and nothing but the task text
  and the standing prompt pointed it at Hamachi rather than at anything else on
  the box.
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
- **A task may touch a container nobody was thinking about**, and nothing
  notices. Every task is unscoped now, and the machinery that used to answer
  "which instance did this actually touch" by scanning the audit for container
  names existed to arm a check-in deadline. There are no deadlines, so nothing
  scans, and an instance recreated by a task nobody expected to recreate it is
  visible only in the audit, to a person reading it.
- **The task text and the subject are attacker-influenced text.** The task
  reaches a model's prompt, which is not safer than reaching a shell — it is the
  deal. Both end up in the journal, in `ops-status.json` and in the reply DM;
  anything rendering them owes them the same suspicion.
- **`<stateDir>/run` is still bind-mounted read-write into every container**,
  and nothing on either side uses it. It is a writable window onto the host that
  exists for no current reason, and the honest reading is that it is a mount
  waiting to be removed rather than a control. The old spool directories are
  still sitting inside it, inert.
- **Root is root.** This service being small and readable is still the
  mitigation for the supervisor. It is not a mitigation for the session.

## Why a separate daemon

`restart clawcius.service` is one of the things a task will ask for. A process
cannot restart itself: systemd sends it SIGTERM, it dies, and whatever it was
doing dies with it — including the record of what it was doing. The argument is
stronger for a container recreate: every live agent session *is* a `docker exec`
into the container being recreated. (It used to be stronger still — a restart
also lost any deadline the daemon had just armed — and that half of it expired
on 2026-08-16 with the deadlines.)

So it is a unit of its own, with no Discord connection and no GitHub token. It
now has a model, and `src/host-agent.ts` is where that decision is written down
in full.

## One task at a time

A lock, not a negotiation. Two host agent sessions with sudo running
concurrently on the same box is not a scenario anybody should have to reason
about, and it is much worse than the two overlapping docker operations this lock
was originally written to prevent.

**A second task is refused, not queued.** The queue and `limits.maxQueued` went
with the spools, and the refusal is the better answer for the way in that
replaced them: "no" arriving in the turn that asked beats a session that starts
twenty minutes later, next to work it knows nothing about, answering a
coordinator who has stopped waiting. The refusal names what the executor is busy
with, so asking again is an informed decision rather than a retry loop.

There used to be a second paragraph here about the waker status file — missing,
stale, malformed or future-dated all reading as *busy*, and a stale zero being
the most dangerous value in this system because it is the one that reads as
permission. That logic is still in `ops/src/idle.ts` and still under test, and
this daemon no longer calls it. It is kept because the waker uses the same file
and the reasoning has not stopped being true; it is moved out of this section
because the executor does not wait for anything but its own lock.

## The deadline and the revert are gone

This section used to describe a recovery loop. After a task that touched an
instance, the executor filed a wake to it — *a host task touched you because
`<reason>`; here is what to check; check in within N minutes* — waited
`deadline.minutes` for a `checkin` request, and on silence rolled the instance
back to the snapshot taken immediately before the task. "Touched" was answered
from the audit by substring match over the shell text, deliberately over-broad,
because a false positive cost one wake and a false negative was an instance
recreated with nobody waiting to hear whether it came back. The automatic
rollback waited at most a minute for an idle turn and then went ahead anyway,
which was the fix from the second review of PR #9: a wedged container is exactly
when a rollback matters most and exactly when it will never report idle.

**All of it went on 2026-08-16.** The wake it filed needed the wake spool, the
check-in needed the ops spool, and the rollback needed a snapshot nothing takes.
It is written down here rather than deleted because a rollback to an older
`dist/` brings the whole apparatus back, and because a reader who half-remembers
it should be able to find out in one place that it is not running.

What a host upgrading into this build gets instead: `reportRetiredDeadlines()`
runs once at boot, finds any check-in deadline the previous build left armed in
`state.json`, writes each one into the journal by name — with its instance, when
it was armed, why, and the tag nothing will restore it to — and **clears it**. A
pending deadline that nothing can honour and nothing can close is worse than
none, because a status page showing one reads as a recovery in progress.

### The freeze has no writer

`frozen` still means what it always meant: the executor refuses every task and
says so, loudly, in the journal, in the boot banner, and in the reply to whoever
asked. It is still persisted, because a breaker that clears when its process
restarts is not a breaker and the host agent can restart this process. It is
still cleared only by a human:

```sh
sudo ops/unfreeze.sh          # prints the reason, asks, then clears
sudo systemctl restart clawcius-ops
```

**Nothing sets it any more.** The circuit breaker that did counted *failed
recoveries* — a missed check-in, or a task that actually had to be rolled back —
and quarantined the build (identified by the `buildRepo` checkout's HEAD) so that
a fix, being a new commit, would go through on its own. Every input to that
counter was on the spool task path, and that path is gone. So:

- a freeze you are looking at **predates 2026-08-16**. Read it as history, not
  as something that just happened;
- `breaker.maxConsecutiveFailedRecoveries` and `breaker.maxQuarantined` still
  parse. Nothing acts on either. `maxQuarantined` still bounds the ring in
  `state.json`, which nothing writes to;
- **a bad build now repeats indefinitely.** The mechanism that stopped a
  known-bad deploy being reinstalled every fifteen minutes was this breaker, and
  the thing it was protecting against — an automatic recovery loop — went with
  it, so the immediate danger is gone too. What is not covered is a coordinator
  asking for the same broken thing over and over. Nothing counts that.

There was never an `unfreeze` verb, and there is no way to ask for one by DM
either. A task *could* run `unfreeze.sh`, and that is one more thing the audit is
for.

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
| `mkdir -p`, `chown`, `chmod` | **Exact paths, no wildcard**: `mkdir -p` on `/var/lib/{clawcius,hamachi,oj}` and on `/var/lib/{clawcius,hamachi,oj}/run`; `chown npurcell:npurcell` and `chmod 0770` on `/var/lib/{clawcius,hamachi,oj}/run` | A first start on a fresh instance still has to create the state directory and the `run/` inside it, because `docker/run-container.sh` bind-mounts `<stateDir>/run` read-write and it has to exist, owned by the uid the container runs as. Until 2026-08-16 this alias also named `run/ops` and `run/wake` — six lines each — and those twelve went with the spools they served. That is a narrowing, not tidying: `run/ops` and `run/wake` are *inside* the bind mount, so the container owned their parent directory and could replace either entry with a symlink before root arrived to `mkdir`/`chown` it — the CWE-59 shape this file spends pages on below. `run` itself has its parent, `/var/lib/<instance>`, outside every mount, which is the property that makes the surviving lines safe. The directories are still on disk and inert; nothing creates, chowns or reads them any more. **The operator has to reinstall this file for the removal to take effect, and run `visudo -c` on it first** — the grants on the host are whatever was last installed, not what is in the repo. |

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
/ `commit` (the first is `-v /:/host`, i.e. root; the second is root inside an
agent's container, which is a session running as that crew with that crew's
credentials — it used to be phrased as "forged provenance", back when the
provenance was a bind-mounted directory, and the point survives the rewording;
the third is `sudo cp` wearing a container), `apt`/`npm`/`pip` as root, `systemctl edit` (opens
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

### Things about sudo's matching that shaped the file

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
- **`sudo: a password is required` means "not on the grant list", not "the
  credentials are wrong".** There is no password to get right — the account is
  `NOPASSWD` for everything this file names, and sudo falls through to its
  ordinary password prompt for everything it does not. So that message is the
  refusal, arriving in the least helpful available wording, and the fix is a
  line in this file rather than anything to do with authentication.
  `Defaults:CLAWCIUS_AGENT !requiretty` is why you see it in a second instead of
  watching the task hang to its timeout. It was read as a credentials problem
  several times on 2026-08-17 before anyone checked.

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

## The spool history, kept because the lessons outlived the code

Two directories were deleted on 2026-08-16. Four things were learned around
them that are still load-bearing somewhere else, and one that is not learned
anywhere any more. This section is the record; none of it describes running
code.

### One spool per instance, and why that turned out to matter twice

Until 2026-08-10 there was a single `spoolDir: /var/lib/clawcius/run/ops` for
the whole executor. That one line was two bugs, and only one of them was
visible.

**The visible one: Hamachi could not file a request at all.**
`docker/run-container.sh` gives each instance its own state directory and
bind-mounts only that — `systemd/hamachi-container.service` sets
`CLAWCIUS_STATE_DIR=/var/lib/hamachi`, so Hamachi's container has
`/var/lib/hamachi/run` and nothing else, and the shared spool at
`/var/lib/clawcius/run/ops` **did not exist inside it**, verified from inside
the container. The agent the operator talks to most was the one agent locked out
of the mechanism built for both of them, and it was silent from every angle: the
agent's `mv` failed into a shell nobody reads, and the executor saw an empty
directory, which is exactly what a quiet night looks like. The mount asymmetry
had been there since the second instance shipped on 2026-08-08; the spool was
written against the first instance's paths and read as correct because for the
first instance it was.

**The invisible one, which matters more: nothing recorded who asked.** A shared
directory carries no evidence of its writer. `redeploy hamachi` filed by Hamachi
and `redeploy hamachi` filed by Clawcius were the same forty bytes, and the
journal said the same thing about both — because it could not tell. One of those
is an agent maintaining itself. The other is an agent reaching across the
boundary at its neighbour, and those should never have been indistinguishable
after the fact on a root process holding docker.

The fix was one spool per instance, and provenance was **the directory, not a
field**: it was stamped on in `spool.ts` where the file's contents could not
reach it, and a request writing `"requester": "clawcius"` into Hamachi's spool
was logged as an ignored unknown field and attributed to Hamachi. That property
is the one thing from this whole section that is still running, in a different
substrate — the author column of a mail row, written by the waker from the id
the sending session's own `sendMail` closes over. Both are the same idea: **the
identity comes from the channel, never from the payload.** The self-test still
asserts the modern half of it, because "the attacker supplies their own
identity" is the obvious way to get this wrong and it would look correct in every
log until the day it mattered.

The mount asymmetry that caused the visible bug is *also* still load-bearing,
now as the basis of the containment checks: `join(instance.stateDir, 'run')` is
the one directory each container can write, and `stateDir`, every `board.db` and
every `wakerStatusFile` must be outside all of them.

### What `ensureSpoolDir` was, and why `ensureDirOwnedBy` is not it

The spool's *parent*, `<stateDir>/run`, was bind-mounted read-write into the
container and owned by the uid the agent ran as. The agent therefore owned the
directory entry called `ops` and could replace it:

```sh
rm -rf run/ops && ln -s /root/.ssh run/ops    # from inside the container
```

Restarts are routine, so the next executor start ran, as root,
`mkdirSync(recursive)` — which returns quietly on an existing
symlink-to-directory — then `statSync` and `chownSync`, both of which follow the
terminal symlink. Result: root chowns any path on the host the agent chose to
`1000:1000`. Review of PR #8 caught it before it ran anywhere. The rule that came
out of it was stricter than `lchown`, because the real question was whether a
root process should be repairing paths whose parent directory is owned by the
adversary: every level `lstat`ed and anything that is not a real directory
refused, reported and **left exactly where it is**; the chown and chmod through
an `O_NOFOLLOW | O_DIRECTORY` descriptor whose `fstat` is compared by device and
inode against the `lstat`; an existing directory with the wrong owner a loud
warning with the exact `chown` to run and nothing else; and nothing created at
all if the state directory did not exist, because there was no correct owner to
copy and a root-owned tree is worse than an absent one.

**`ensureSpoolDir()` is gone with the spools.** What survives is
`ensureDirOwnedBy()`, which moved out of `spool.ts` into its own file,
`ops/src/dirs.ts`, precisely so that it is not read as the relaxed version of a
rule that no longer exists. It is `mkdir -p` plus `chown` **by name**, with no
symlink checks at all, and that is safe for exactly one reason: it is only ever
pointed at the host agent's working directory and the three unit-desk
directories under it, none of which is inside any bind mount and none of which
has any part of its path owned by a container. The header of that file says so in
capitals. **Do not point it at anything an agent can write** — the moment
somebody does, the CWE-59 above is back, and it will not look like a mistake.

One reversal in it is deliberate and worth knowing: the owner is **passed in**
rather than discovered by `stat`. The spool followed the opposite rule — "the
owner is discovered, never configured", because this daemon is not entitled to an
opinion about who owns a directory it was pointed at — and that rule is right for
a build step and exactly backwards for an identity. Discovering the session's
identity from the filesystem is how it ended up running as the operator, who is
in the `docker` group. See [§ The service account](#the-service-account-2026-08-11).

### The retired config keys, and why a stale one does not fail the boot

`spoolDir` at the top level, and `opsSpoolDir`, `wakeSpoolDir`, `wakeChannelId`
and `mayRequest` per instance, are **retired**. The loader ignores each of them
and writes one deprecation entry per key into `journal.jsonl` — not just to
stdout — naming the key, the instance, and what stands in its place. Delete them
once you have read the notice. Nothing on disk was touched on their account.

**It is not a boot failure, and that decision is older than these keys.** It was
first made on 2026-08-10 for the legacy top-level `spoolDir`, and the reasoning
transfers unchanged: `clawcius-ops.service` is `Restart=always` with
`StartLimitIntervalSec=0` and `StartLimitBurst=0` — never give up. A rejected
config does not produce one loud failure; it produces a root daemon in a
five-second restart loop. That is the shape of #7, and this repository has
already agreed not to ship it again. `git pull` also updates `ops-config.yaml`
under a running process that will not re-read it until somebody restarts it, so
the new file routinely lands under the old code and the old file under the new.

The `spoolDir` migration that this replaced was more elaborate — it *attributed*
the old path to the one instance whose `stateDir` contained it, refused the boot
if no instance owned it or two did, and tracked whether `opsSpoolDir` was
*written in the file* separately from whether it *differed from the default*,
because conflating those two questions silently replaced an operator's
hand-written value. All of that machinery is deleted. Attribution is meaningless
when there is nothing to attribute a directory to.

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
2 GB of optimism. That argument was written when a missed check-in triggered an
*automatic* rollback, which put the untested path inside the recovery path.
**Since 2026-08-16 nothing here restores a snapshot automatically**, so the
verifier's job has changed rather than gone: the snapshots are now purely a
person's recovery tool, and the timer is what stops them being a person's
recovery tool that has never been tried. It is arguably worth more than it was,
because a human restoring at 3am has no fallback behind them.

`docker run -d` succeeding proves almost nothing: it returns as soon as the
container is created, and an image whose entrypoint dies immediately satisfies
it. So the check is start → wait for `running` → `docker exec` the configured
probe. The throwaway container gets no env file, no bind mounts and no restart
policy, so it holds no credential and cannot reach any instance's `run/`
directory, the workspaces or Discord; and it is removed in a `finally` on every
path, because a verifier that leaks 2 GB containers turns a broken snapshot into
a full disk.

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
- **limits** — how long and how much money. It used to say "how often" too, and
  there is no longer anything that answers that: the rolling-hour cap went with
  the spools, and `limits:` is now two timeouts.

`instances:` no longer gates anything at all. It used to decide what could be
named as a rollback or check-in target and what got snapshotted; none of those
exist. What it decides now is what gets health-sampled, what appears in the
briefing, which boards get a mailbox, and — through `stateDir` — where the
containment checks say the mounts are. Every key has a default in `src/config.ts`
and the loader validates types and cross-field invariants, so a typo fails the
boot with the offending key named rather than producing an executor that quietly
does nothing.

The cross-field checks worth knowing about, because they are security properties
rather than tidiness. Every one of the containment checks is asked against
`join(instance.stateDir, 'run')` — the single directory
`docker/run-container.sh` bind-mounts read-write into that instance's container —
for **every** instance, not just the one the file belongs to:

- `stateDir` may not be inside any instance's mount. It holds the journal and the
  audit, and a record written by the party it is about is not a record;
- an instance's `wakerStatusFile` may not be inside any instance's mount. A's
  status file under B's mount means B can declare A idle whenever it likes —
  which matters less than it did, since this daemon no longer reads the verdict,
  but the waker still does;
- an instance's `board.db` may not be inside any instance's mount. It decides who
  is a coordinator, and a coordinator is the only agent that may run commands on
  this host;
- `hostAgent.workDir` may not contain or be contained by any mount, may not
  contain or be contained by `stateDir`, and may not be inside any checkout under
  `repos:` — the session writes freely in its own working directory, and a
  container sharing it can put anything it likes in front of a process with
  sudo; a session whose cwd is a checkout takes standing instructions from
  anything the agents can get merged;
- `unitDir` may not be inside `hostAgent.workDir`, `stateDir`, any checkout, or
  any instance's `stateDir` — the whole value of installing units in code is that
  root computes the destination, and a `unitDir` the agent account can already
  write hands that back with root ownership attached;
- retired keys (`spoolDir`, `opsSpoolDir`, `wakeSpoolDir`, `wakeChannelId`,
  `mayRequest`) are ignored, named in a deprecation notice, and are **not** a
  boot failure;
- `buildRepo` must name a real entry under `repos:`. It used to be so the breaker
  could identify a build; the breaker has no writer now, so this validates a key
  nothing consumes;
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

**Keys that still parse and are consumed by nothing.** `idle:` (all three
fields), `deadline:` (both), `breaker:` (both) and `snapshotKeep`. They are
validated on the way in and then no code reads the result. They are left in place
rather than removed because deleting a key is a boot failure for anyone whose
file still has it, and the loader's tolerance is spent on the five keys that had
to go; a second wave can take these. Do not read their presence as evidence of a
behaviour. There is no idle wait, no deadline, no breaker, and no per-task
snapshot.

## Layout

```
ops/
  ops-config.yaml        health manifest, invariants and limits — NOT an
                         authorization model, and it has not been one since
                         2026-08-10
  unfreeze.sh            human-only: clear the freeze. Still the only way to
                         clear it, and nothing sets it any more
  clawcius-sudoers       what the host agent may do with sudo, and why
  src/
    index.ts             daemon entry, single-instance lock, signals, one
                         mailbox per board
    config.ts            typed YAML loader, defaults, containment assertions
                         against each container's bind mount
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
    dirs.ts              ensureDirOwnedBy: mkdir -p + chown BY NAME, for the
                         host agent's working directory and the unit desk only.
                         It is a file of its own so that it is not mistaken for
                         the careful spool version it replaced; the header says
                         why, and says not to point it at anything an agent can
                         write.
    board.ts             opening a crew's board.db as root and reading and
                         writing mail rows. Refuses a path that is not a
                         regular file, and creates nothing.
    host-mailbox.ts      THE WAY IN. One mailbox per crew, the coordinator
                         check re-done against the author column immediately
                         before anything runs, and the reply.
    host-agent.ts        the session: env allowlist, tool policy, the standing
                         prompt, stream-json parsing, the audit, and
                         sanitiseTask. READ THIS FILE FIRST — it is where the
                         trust model lives.
    executor.ts          the lock, the task supervisor, the health sample
                         either side, the unit desk. No snapshot, no rollback,
                         no queue; the header records what went and when.
    runner.ts            argv-array exec, no shell; dry-run
    idle.ts              reading the waker status file; fails safe. Still
                         correct, still tested, and consumed by nothing in this
                         package since the idle wait was removed.
    state.ts             persisted freeze, quarantine ring and deadline rows.
                         Only the freeze is still read; the boot reports and
                         clears whatever deadlines it finds.
    journal.ts           append-only jsonl + ops-status.json
    verify.ts            snapshot restore test
    verify-main.ts       oneshot entry for the verify timer
    selftest.ts          `npm run selftest` — 58 tests
```

## The status page

The executor writes `<stateDir>/ops-status.json`, rewritten atomically on every
event and again whenever the lock is released. That is the whole integration
with `status/` — no socket, no API, no shared library. It holds the current
operation, the freeze, the host agent's configuration and identity verdict, the
audited-command count, the last task, and the last hundred journal entries —
each of which names its requester. `status/` can grow a panel for it whenever
someone wants one. Until then it is the file you `cat` when the journal is too
long.

Two fields went on 2026-08-16: `queued`, because a second task is refused rather
than queued, and `spools`, because there are none. `pendingCheckins` and
`quarantined` are still in the shape and are **always empty** on a host that has
booted this build once — nothing arms either, and the first boot reports and
clears whatever the previous build left behind. They are kept so that a reader
written against the old shape does not have to handle their absence as well as
their emptiness.

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

`npm run selftest` is **58 tests** and runs with no docker, no systemd, no npm
and no real `claude`. It was 129 before 2026-08-16; the seventy-one that went
tested request parsing, the spool's caps and flood handling, the queue, the
`mayRequest` refusals, the deprecated `spoolDir` migration, the idle wait, the
snapshot-before/rollback-after ordering, the deadline, the automatic rollback and
the breaker. They did not start failing. **The code they covered was deleted**,
and a test suite that shrinks by that much is worth being explicit about,
because the alternative reading — that coverage was dropped — is the one a
reader should be able to rule out here rather than by reading the diff.

What is covered now:

- **`sanitiseTask`**: a task is capped and stripped of control characters, and
  says nothing more than it was given;
- **the containment assertions**, which are the things standing between "the
  agent writes its mount" and "the agent writes the record of what was done to
  the host": a `wakerStatusFile` inside a container mount is refused, a
  `board.db` inside one is refused, a board outside every mount loads and
  neither of its fields is guessed, and a **near-miss prefix is not treated as
  containment** — `/var/lib/clawcius-ops` is not inside `/var/lib/clawcius`, and
  a string comparison that got that wrong would refuse every valid config on
  this host;
- **a config still carrying the retired keys boots**, and the notices name each
  one. That is the whole of the migration promise and it is asserted rather than
  described;
- **the board**: it is opened or refused, never created, and the host agent takes
  its own row and will not take anybody else's;
- **the lock**: a second task is refused while one is running, and the refusal
  reaches the sender. Refused, not queued — the test asserts the reply, because
  a refusal nobody is told about is indistinguishable from a request that
  evaporated;
- **the retired deadlines**: one armed by the previous build is reported and
  cleared at boot, not left pending forever in `ops-status.json`;
- **the unit desk**, which is the sharpest surface left: a name with a separator,
  a `..`, a space or the wrong suffix is refused with the reason; an install
  lands at the path the executor computed, 0644, and nowhere else; a staged
  symlink is refused rather than published into `/etc/systemd/system`; an empty,
  oversized or non-unit staged file is not installed; a dry run stages nothing;
  a request carries a name and nothing else — no path, no mode, no owner; the
  desk serves a request, answers it, and never serves it twice; and a task can
  install a unit without sudo, landing in the journal as its own `"kind":"unit"`
  entry;
- **the session**: a task reaches it with the task text and nothing else, and a
  working directory that is not the checkout;
- **the audit**: every Bash command in the stream reaches the journal, in full,
  in order, including one with spaces, quotes and a semicolon in it;
- **`compareHealth` only reports things that got worse** — fixing something is
  not a regression, and a service that was already dead is not blamed on the
  task;
- **dry-run removes the ability to act rather than asking it not to**, the deny
  list is a superset of everything that can execute, and a task told to `touch`
  a file leaves no file;
- **`assertNoSecrets`** throws on a Discord token and on the other credential
  shapes, the environment is built from nothing and carries no token, and a
  `NODE_*` variable is refused — that last one because the privilege drop now
  runs `node` as root first, so a `NODE_OPTIONS` inherited from anywhere would
  execute before the drop;
- **the service account**, all of it without root: resolution with both primary
  and supplementary groups, a primary group that is `docker`, a missing account
  that never falls back, the docker-group refusal with the `gpasswd` to run,
  every root-equivalent group rather than just `docker`, uid 0 however it is
  spelled, an unreadable group file as a refusal rather than a pass, a secret the
  account can read, the readability check walking the directory rather than only
  the file, a checkout it cannot write as a warning rather than a refusal, and
  the standing prompt telling the session which account it holds;
- **the privilege drop**: the gid list handed to `setgroups` is numbers and never
  group names, the session is never spawned with the `uid`/`gid` options (that is
  what clears the groups — #21), the bootstrap verifies against the kernel and
  then execs, refuses to exec anything when the credentials would be wrong, and
  `credentialComplaint` names the difference between what was asked for and what
  happened;
- **a clean exit with `is_error: true` is a failure, not a success** — the CLI
  does exactly that when the model's own turn ends badly;
- **no code path in `ops/src` forces past a dirty tree**, asserted against the
  compiled `dist/`, which is the part a refactor cannot quietly undo;
- **`ops-status.json` is valid and describes the current state**;
- **the verifier** restores the newest snapshot, probes it and always removes it,
  and a verify dry run says plainly that it proves nothing;
- **`idle.ts` still has its own tests** — every ambiguous case reads as busy, and
  an implausibly large status file reads as busy — even though nothing in `ops/`
  consults the verdict any more. They are kept because the logic is still correct
  and the waker still depends on the same file; they are not evidence that this
  daemon waits for anything.

The privileged binaries are replaced with stand-ins that record their argv one
element per line, which is what proves no shell string is being built by the
executor. `claude` is replaced by a stand-in that emits genuine stream-json and
**honours the deny list it is handed** — a denied Bash is a Bash tool that does
not exist in that session, exactly as the real CLI was observed to behave — so
the dry-run assertions test the whole chain rather than a flag.

What that stand-in **cannot** prove is that the real CLI honours those settings.
That was established by experiment on 2026-08-10 and is in the next section.

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
- **No task has ever arrived by DM on a real host either.** The mailbox path is
  covered by the self-test against a real SQLite board, and has never run against
  a live waker writing rows on the other side.
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
  a shell that already has root. Still true on 2026-08-16, and re-checked rather
  than copied forward: the machine it is edited on has no `sudo` and no `visudo`
  binary at all. Two things in it are new syntax as of 2026-08-12 and are what to
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
- **`ensureDirOwnedBy`'s `chown` has never run as root here**, because the
  self-test does not run as root and cannot. Check with
  `ls -ld /var/lib/clawcius-host-agent` after the first start. The same sentence
  used to name `ensureSpoolDir`'s `fchown` alongside it, and used to say to read
  the executor's log rather than fixing it quietly if a symlink ever turned up
  there. That function is gone, and so is the reason for the warning:
  `ensureDirOwnedBy` is only pointed at paths no container owns any part of.
  **If that ever stops being true, the warning is needed again and this file is
  wrong.**
- The old note here said the post-task wake had never been picked up by a live
  waker. It never will be. Nothing files one.

Run it with `dryRun: true` first and read the log. In that mode the session
cannot execute anything, and what lands in the journal is the list of commands
it would have run — which is the single most useful week of reading available
before turning this on.
