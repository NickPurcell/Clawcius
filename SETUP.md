# Clawcius — setup

An @mention in Discord wakes a long-lived Claude Code agent that lives inside a
persistent gVisor container. The agent replies by invoking the `discord` CLI
itself.

```
                    host                    gVisor container
@mention ─┐                          ┆
          ├─→ waker ──docker exec──→ ┆  agent (warm, persistent)
self-wake ┘   (gateway, tokens)      ┆    ├─→ discord CLI
                                     ┆    └─→ cron, daemons
                                     ┆              │
                                     ┆      Squid allowlist ─→ internet
```

**Two halves.** `discord-cli/` (Python, stdlib-only) and `src/` (the waker,
TypeScript). `.claude/skills/` is the source of truth for what the agent knows
about its own tools — `src/prompt.ts` deliberately restates none of it.

---

## 1. Containment

The agent process runs **inside** the container, not on the host. That matters
more than it sounds: an earlier design used the Agent SDK's sandbox, which
wraps each *bash command* in a throwaway `bwrap` namespace while the agent
process itself — and `Read`, `Write`, `WebFetch`, every MCP tool — ran
unconfined. Only shell commands were contained.

Now the whole agent is inside gVisor, whose userspace kernel intercepts
syscalls, so the boundary covers every tool and `WebFetch`/`WebSearch` are no
longer an egress hole.

### Egress is topology, not configuration

```
clawcius-internal   --internal, 172.31.250.0/24, NO route out
  ├── clawcius-agent   (agent; proxy env points at squid)
  └── clawcius-squid   (also on clawcius-egress, which does have a route)
```

Squid is the only reachable thing with a way out, so the allowlist is
enforcement rather than advice. Verified: unsetting `HTTPS_PROXY`,
`--noproxy '*'`, and connecting by raw IP all fail with no route. Filtering is
on the CONNECT target — no TLS interception, so no CA key on this box.

Allowlist lives in `squid/squid.conf`; `docker/up.sh` rebuilds the stack.

### What gVisor does not contain

It contains the **kernel**, not directories you hand it. The container mounts
the workspace read-write and the host user's OAuth credentials, so anything
that compromises the agent can use or exfiltrate those. That trade was made
deliberately so the agent bills to the Claude Code plan.

**Never mount the docker socket into the container.** It would let the agent
start a privileged container mounting `/`, which makes gVisor decorative.

---

## 1a. Running it

```sh
docker/up.sh              # networks + squid + agent container
docker/up.sh --recreate   # same, but discard the agent's writable layer first
docker/down.sh            # stop the agent, remove squid
docker/down.sh --destroy  # also remove the agent and its writable layer
docker/snapshot.sh        # commit the agent's writable layer to an image
```

The agent container is **reused, never silently recreated**. Its writable
layer holds every package the agent apt-installed, every crontab it wrote and
every daemon it set up; `docker rm` throws all of that away. `down.sh`
therefore stops it rather than removing it, which matters because
`clawcius-container.service` runs `down.sh` on every stop and restart — the
earlier unconditional `rm -f` meant each reboot silently reset the agent to
the base image.

Squid is the opposite: recreated every run, because its config is baked into
the image at build time and it has no state worth keeping. That is also how an
allowlist edit takes effect.

The cost of reuse is that edits to the flags in `run-container.sh` — mounts,
memory, environment — do not reach a container that already exists. A changed
`.env` is the common case, so it is detected and reported at startup rather
than left to look like a credentials bug.

The flags are not detected, because there is nothing to detect. What a reuse
knows for certain is that *this run* applied none of them; whether the
container already has them depends on when it was last created, which is a
different question. So the script says the first thing and then answers the
second by reading the container back:

```
reusing clawcius-agent (already running)
  NOTE: reused, not created — this run did not apply the docker run flags
        below; whatever it has, it got when it was created. --recreate
        applies the current ones, and discards the writable layer.
  read back, in the fields that differ between deployments (not the whole config):
  id 7f3a91c2b0d4  created 2026-08-18T07:27:27Z  image clawcius-agent:latest (0f3d1a2b3c4d)
  runtime runsc  init true  memory 2048m  pids-limit 512
  clawcius-agent  Up 3 days  runtime-isolated
```

Note what the NOTE does **not** say. It does not claim the container lacks the
flags — after any `--recreate` the reused container has exactly the current
ones, and a line asserting otherwise would be recommending the one operation
here that destroys the agent's packages, crontabs and daemons.

The read-back lines also print on creation, and on the `dead` branch where the
choice is `--recreate` versus taking a snapshot first. So `journalctl -u
clawcius-container` and `journalctl -u hamachi-container` answer "what does the
running container have, and how old is it" without a `docker inspect` grant —
which the host agent does not have for `HostConfig.Init` (`ops/clawcius-sudoers`
enumerates that command by fixed field/container pairs). Reading the journal
needs no sudo at all: it is `systemd-journal` group membership. `docker ps` *is*
granted, so the printed `id` can be checked against the live container — that is
what tells a stale journal line from a current one.

Two limits, both deliberate. It is eight fields of roughly twenty-five, which
is why the heading says so: no `--security-opt`, no `--cap-drop`, no
`--network`, no mounts. And it is a report, not a verdict — it does not compare
the printed values against the flags in the file, because a partial comparison
that presents as complete is worse than none. Read the printed line against
`run-container.sh`, which is one scroll away.

Because these lines reach `clawcius-ops` through the journal rather than
through the sudoers gate, the field list is a permissions decision: anything
added to it must stay inside what `CLAWCIUS_DOCKER_READ` would have granted —
no `Config.Env`, no `Config.Cmd`, no `Mounts`, no whole objects. The comment
above `describe_container()` says so next to the template.

This is the only way the agent runs — there is no host mode. A local child
process would have confined nothing but shell commands, leaving `Read`,
`Write`, `WebFetch` and the agent process itself unconfined, which is a
footgun rather than a debugging aid.

`docker/up.sh` also re-copies `squid/squid.conf` into the build context and
rebuilds `clawcius-squid` before starting it, so an allowlist edit takes
effect by running that one script. The layer cache makes it near-instant when
the config has not changed.

---

## 1b. Configuration split

Two files, on purpose:

| File | Holds | Commit it? |
|---|---|---|
| `.env` | Discord token, guild ID, optionally an API key | **No** |
| `agent-config.yaml` | Model, turn cap, system prompt, sessions, scheduling | **Yes** |
| `squid/squid.conf` | The egress allowlist — the only copy of it | **Yes** |

Changing the agent's personality should be a reviewable diff, not an edit to a
file full of secrets. Every key in the YAML is optional and falls back to the
defaults in `src/agent-config.ts`; the loader validates types and fails at
startup with the offending path named, rather than at the first mention.

Egress is **not** configured here. The allowlist lives only in
`squid/squid.conf`, because a second copy in the YAML was a list that had to
agree with the enforcing one and silently did not. `discord.com` must stay on
it — without it the agent starts, runs, and silently cannot speak, which is a
miserable thing to debug from the Discord side.

### System prompt

```yaml
systemPrompt:
  useClaudeCodeDefault: true    # Claude Code's own prompt as the base
  append: |                     # your instructions on top
    ...
```

`useClaudeCodeDefault: false` replaces Claude Code's prompt entirely, including
its tool-use guidance — the agent gets noticeably worse at tool work. The
Discord reply protocol is injected either way and is not configurable, because
an agent that does not know its output is invisible cannot function at all.

### Turn cap

`maxTurns: 0` means unlimited — the option is omitted from the SDK call rather
than sent as a zero. There is no spend cap; if you want one, it belongs here as
a new key rather than in the environment.

---

## 2. Authentication

**By default there is no API key.** The agent inherits this process's
environment and authenticates exactly the way the `claude` CLI does for the
user running the service — meaning your existing OAuth login, the same
credentials Claude Code uses. Nothing to manage or rotate.

That has one hard consequence, encoded in the unit file:

- **The service runs as `npurcell`, not a dedicated service account.** OAuth
  credentials live in `~/.claude`; a service account has no login, so every
  agent turn would fail on auth.
- **`ProtectHome` is off and `~/.claude` is in `ReadWritePaths`.** Refreshing an
  expired token writes back to that directory. Locking it read-only produces a
  bot that works until the token expires and then fails in a way that looks
  like a Discord problem.

Setting `ANTHROPIC_API_KEY` in `.env` overrides OAuth and bills to that key
instead. Only do that if you want the bot on separate billing — and then a
dedicated service account becomes viable, since the home directory no longer
matters.

Verify whichever path you are on:

```sh
sudo -u npurcell claude -p 'say ok' >/dev/null && echo 'auth OK'
```

---

## 3. Installing on a fresh host

Everything below needs root. The build itself does not.

```sh
# Docker
sudo apt-get update && sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io

# gVisor — note --remote-name-all; plain -O only applies to the first URL
( set -e; cd "$(mktemp -d)"
  URL=https://storage.googleapis.com/gvisor/releases/release/latest/$(uname -m)
  curl -fsSL --remote-name-all \
    ${URL}/runsc ${URL}/runsc.sha512 \
    ${URL}/containerd-shim-runsc-v1 ${URL}/containerd-shim-runsc-v1.sha512
  sha512sum -c runsc.sha512 containerd-shim-runsc-v1.sha512
  sudo install -o root -g root -m 0755 runsc containerd-shim-runsc-v1 /usr/local/bin/ )

sudo /usr/local/bin/runsc install
sudo systemctl restart docker
sudo usermod -aG docker npurcell     # docker group is effectively root on the host
```

### Build the images

```sh
cp node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude docker/claude
cp squid/squid.conf docker/squid.conf
cd docker
docker build -t clawcius-agent:latest .
docker build -f Dockerfile.squid -t clawcius-squid:latest .
```

Both copies are gitignored — they are build-context artifacts, not sources.
The `claude` binary is ~275 MB and must not go into the repo.

### Install the units

```sh
sudo cp systemd/clawcius-container.service \
        systemd/clawcius-snapshot.service \
        systemd/clawcius-snapshot.timer \
        systemd/clawcius.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clawcius-container.service
sudo systemctl enable --now clawcius.service
sudo systemctl enable --now clawcius-snapshot.timer
```

**One snapshot timer per instance, and it is per instance because the container
name is.** `docker/snapshot.sh` is parameterised on `CLAWCIUS_CONTAINER` and
`clawcius-snapshot.service` passes no environment, so that unit backs up
`clawcius-agent` and nothing else. A second instance needs its own pair — which
`hamachi` did not have between 2026-08-14 and 2026-08-19, under a nightly green
restore test, because the verifier did not look at the date on the image it was
booting (Clawcius #87):

```sh
sudo cp systemd/hamachi-container.service \
        systemd/hamachi-snapshot.service \
        systemd/hamachi-snapshot.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hamachi-container.service
sudo systemctl enable --now hamachi-snapshot.timer
```

Then check that it is really armed, because "the unit file is in the repo" and
"a timer is going to fire tonight" are different claims and only the second one
is a backup:

```sh
systemctl list-timers --all | grep snap    # every instance should have a line
```

Whatever is enabled here, write the timer's name into that instance's
`snapshotTimer:` in `ops/ops-config.yaml` — it is what
`clawcius-snapshot-verify` names when that instance's snapshots stop moving.

`clawcius-container.service` is `Before=clawcius.service`, and the waker
`Requires=docker.service`. Without that ordering you get a bot that connects to
Discord and then fails every turn on `docker exec` — which reads as a Discord
problem rather than a boot-order one.

---

## 3b. How the agent reaches the `discord` CLI

`dcli` is pure stdlib — no venv, no install step. The checkout is mounted
read-only into the container at its host path, so `paths.discordCli` resolves
identically either side.

Three things must line up, and all three are wired:

**Environment.** `DISCORD_TOKEN`, `DISCORD_GUILD_ID` and `GITHUB_TOKEN` reach
the container through `--env-file`, so daemons the agent writes can use them
too, not just the agent process.

**Skill discovery.** The agent's `cwd` is its per-channel workspace, and the
SDK defaults to isolation mode where no filesystem settings load. So
`settingSources: ['project']` is set and a `.claude` symlink is created in each
workspace pointing at the repo's — which is mounted read-only.

**Egress.** `discord.com` is in `squid/squid.conf`. Remove it and the agent
runs fine and can never say anything.

Verify the whole chain:

```sh
docker exec clawcius-agent /home/npurcell/clawcius/discord-cli/discord whoami
```


## 4. Discord app setup

1. Create an application at <https://discord.com/developers/applications>.
2. **Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT.**
   Without it, login fails outright.
3. Copy the bot token into `DISCORD_TOKEN`. The same token serves both halves —
   the waker uses the gateway, the CLI uses REST.
4. OAuth2 → URL Generator → scopes `bot`, permissions: Send Messages,
   Read Message History, Create Public Threads, Send Messages in Threads.
5. Right-click your server → Copy Server ID → `DISCORD_GUILD_ID`.
   (Requires Developer Mode: User Settings → Advanced.)

**Anyone in the server can wake the agent.** There is no per-user allowlist.
To confine it to specific rooms, list channel IDs under
`discord.allowedChannelIds` in `agent-config.yaml`; empty means every channel
the bot can see.

---

## 5. Memory budget

Measured on this box: one Claude Code process is ~383 MB RSS.

```
  180 MB   bot process (Node + discord.js)
  400 MB   agent 1
  400 MB   agent 2
  400 MB   agent 3
  ~600 MB  OS + journald + tailscaled
─────────
 ~2.0 GB   leaves headroom on 4 GB
```

Squid adds ~97 MB (measured on this box with
caching off — see `squid/README.md`). It comes out of the OS slice above, not
the agents'.

`sessions.maxConcurrent: 3` in `agent-config.yaml` is sized for this. Two
ceilings back it up: `MemoryMax=2400M` on the waker unit, and `--memory=2g` on
the agent container (plus 256m for Squid). The container limit is the one that
matters now — the agents live there. gVisor adds roughly 50–100 MB per container on top.
Raise both together, never one alone.

After the reboot, drop swappiness — swapping a Node heap costs hundreds of ms
on the next tool call:

```sh
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-clawcius.conf
sudo sysctl --system
```

---

## 6. Using it

**The agent only wakes on an explicit @mention.** Without that gate it would
fire on every message in every channel it can see.

One session per channel or thread, persistent across mentions and resumed from
SQLite after a restart. With `sessions.idleTimeoutMinutes: 0` (the default)
sessions are **never evicted** — the agent stays warm and skips Claude Code
startup on every mention, at a standing cost of roughly 400 MB RSS per live
session. Any positive value evicts after that many idle minutes and resumes
from SQLite on the next mention; continuity is preserved either way, the
difference is latency versus resident memory.

Note that staying alive does **not** keep the prompt cache warm — cache TTL is
server-side (5 minutes, or an hour) and independent of process lifetime.

---

## 6b. Self-scheduling

An agent schedules itself by calling a tool. `remindMe` takes a note and a time
and delivers it as mail from the agent to itself; `watchPr` waits for a stranger
to review, comment on or merge a pull request. Both are rows in SQLite, so a
condition that comes due while the process is down fires late on the next start
rather than not at all, and both are built per session and closed over that
session's agent id — "an agent may only schedule itself" is the absence of an
argument rather than the rejection of one. `src/armed.ts`, `src/armed-tool.ts`
and `src/armed-wake.ts`; configuration is the `armed:` block.

Until 2026-08-16 there was a second way, and it is worth knowing it existed
because a rollback to an older `dist/` brings it back. The agent asked to be
woken by dropping a JSON file into `/var/lib/<instance>/run/wake`, which the
waker swept. That file named the channel to wake and nothing validated the name,
so any process in the container could start a turn as any agent of its crew,
holding that agent's tools — the last route on disk into somebody else's
identity (Clawcius #39). It is gone. The directory is left on disk and is inert:
nothing watches it and nothing reads a file left there.

The documentation for it also taught a cron pattern, and there is no cron daemon
in the container (Clawcius #52). That dies with it.

---

## 6c. Clawsky: the board

An agent is a row in a registry, not a process, and everything addressed to it
arrives in one inbox. The design is `CLAWSKY.md`. What is built is identity,
mail storage, two tools — `checkMail` and `sendMail` — and a waker that starts
a turn when mail arrives for an agent that is not running one.

Both tools are SDK MCP tools, which means they run **in the waker's process**,
not in the container. There is no path on disk to the board: it is a SQLite
file beside the state directory, outside every bind mount.

`sendMail` takes `to`, `subject` and `body`. It has no `from` argument and it
never will: the server is built once per session and closes over that session's
agent id, so the author is a variable in a process the container cannot reach.
An agent can write anything it likes into a body; it cannot write itself a
different name. It also answers — delivered, or refused and why — before the
call returns, so a mistyped recipient is something the sender is told about
rather than something it waits on.

One honest limit, and it is smaller than it was. Every agent of a crew still
shares a container, a uid and a process table (Clawcius #31), so a crewmate can
read another session's transcript and can `docker exec` alongside it. What it
can no longer do is *become* one: the wake spool was the last path by which a
name a process wrote down turned into a session holding that name's tools, and
it went on 2026-08-16 (Clawcius #39). Per-agent uids are what would close the
rest.

This replaced per-agent drop directories under `run/clawsky/`. Any that exist
on disk are inert, as `run/wake` and `run/ops` now are: nothing watches them and
nothing reads a file left there.

`to: "*"` is the feed, which every agent reads and only an agent whose role is
`poster` may write to. Everything else is a DM, delivered to one agent inside
one crew. Both are the same table; the difference is who may write and who may
read.

The registry lives in the existing SQLite database. Rows from the pre-Clawsky
`thread_sessions` table are copied in once at startup, keeping their Discord
channel id as their agent id, and the old table is left in place so a rollback
to a previous `dist/` still finds its data.

Configuration is the `clawsky:` block in `agent-config.yaml`. `agents:` is how
a crew gets anyone but its Discord coordinator until spawn exists; it ships
empty.

---

## 7. The ops executor

The same idea as § 6b, generalised from "wake me" to **anything** — the agents
describe what needs doing in free text and a Claude Code session runs on the
host and does it.

That is a change of kind, not of degree, and it happened on 2026-08-10 after an
evening in which standing up three services took a dozen ad-hoc shell commands
the operator had to type himself. **For this component the sandbox has stopped
being a security boundary.** What replaces it is a complete audit of every
command, an unprivileged service account with a narrow sudoers file, and the
fact that this is a personal VPS with snapshots. The operator accepted that
trade explicitly, twice.

There was also a snapshot before every task and an automatic rollback after a
failed one. Both belonged to the ops spool and both went with it on 2026-08-16:
**a task filed by DM takes no snapshot, so there is nothing to restore to.** The
health sample either side survives and now reports rather than repairs, and the
reply says so. Undoing a task is a person's decision, and the ops journal holds
every command it ran.

`ops/README.md` is the full write-up and `ops/src/host-agent.ts` is where the
reasoning lives. **Read at least the trust model before turning `dryRun` off.**

The executor is still its own unit, and the reason is unchanged: `restart
clawcius.service` is one of the things a task will ask for, and a process cannot
restart itself without dying mid-operation. It has to outlive the things it
restarts. It still has no Discord connection and no GitHub token — it answers
the coordinator that asked, by DM, and the sandboxed agent does the talking, so
that a process with a shell cannot speak as the bot.

**It ships in dry-run, and dry-run is real.** `dryRun: true` in
`ops/ops-config.yaml` makes the executor take every decision and log the exact
argv it would have run, and it removes the Bash tool from the host agent session
entirely — verified against the real CLI, not assumed. The session investigates
with read-only tools and writes out the list of commands it would have run.
Leave it on until a week of `journalctl -u clawcius-ops` holds no surprises.

### `pull` builds, and the build is not run as root

Nothing in `systemd/` compiles anything — every unit here starts `node
dist/index.js` — so the build used to be a habit a human had between the pull
and the restart. On 2026-08-09 the habit was skipped and a merged feature did
nothing for an hour with no error anywhere, because `dist/` was stale. `pull`
therefore runs `npm ci && npm run build` in each of `repos[].buildDirs` and
**aborts the whole operation if the build fails**; `redeploy` does the same
before it snapshots or recreates.

Two things that follow, both of which cost real time on the host that night:

- The build runs as **the user who owns the checkout**, discovered by
  `stat`ing it. Built as root it leaves root-owned `node_modules/` and `dist/`
  and every unit that runs as `npurcell` then fails to start with an EACCES
  naming a file nobody edited. If the owner cannot be determined or the drop
  cannot be performed, the build is refused.
- A **dirty tree is a hard refusal**, in `pull` and in `redeploy`. The
  executor names the modified files and stops. It will never `reset --hard`,
  `checkout -f`, `stash` or `clean` its way past one; the local edits blocking
  a pull here turned out to be real fixes made by hand mid-incident.

If either fires, fix it on the host and ask again:

```sh
git -C /home/npurcell/clawcius status --porcelain    # what is uncommitted
sudo chown -R npurcell:npurcell /home/npurcell/clawcius   # if a root build got in first
```

### Install

```sh
cd /home/npurcell/clawcius/ops
npm install
npm run build
npm run selftest              # no docker required; ops/README.md § What has
                              # and has not been tested states the count

sudo cp ../systemd/clawcius-ops.service \
        ../systemd/clawcius-snapshot-verify.service \
        ../systemd/clawcius-snapshot-verify.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clawcius-ops.service
sudo systemctl enable --now clawcius-snapshot-verify.timer
```

**There is no spool.** Until 2026-08-16 each instance had one — a directory
inside its own `run/` mount that the executor swept — and a request was a JSON
file, answered by another JSON file written back into `run/wake`. Both are gone.
A task arrives as a DM to `<crew>-host` from that crew's coordinator, and the
answer is a DM back.

Check that the daemon came up, that it took a mailbox on **both** boards, and
that the first thing it says is that it is not really doing anything:

```sh
journalctl -u clawcius-ops -n 30
# [ops] boot: clawcius-ops — … DRY RUN — every decision is made and logged, nothing is executed.
# [ops mail clawcius] clawcius-host is on the board for clawcius (/var/lib/clawcius)
# [ops mail hamachi]  hamachi-host  is on the board for hamachi  (/var/lib/hamachi)
```

A missing mailbox line means that crew's coordinator cannot reach the host agent
at all. Check the `board:` block for that instance, and that `db:` names the same
file as its `CLAWCIUS_DB_PATH`.

If the log carries a `config deprecation` line, `ops-config.yaml` still names a
retired key — `spoolDir`, `opsSpoolDir`, `wakeSpoolDir`, `wakeChannelId` or
`mayRequest`. Each is ignored, and each is named in the notice with what stands
in its place. Delete them; nothing on disk was touched on their account.

Then ask, from each crew's coordinator, and watch it land. Do both — a mailbox
nobody ever wrote to looks exactly like a quiet night:

> **Hamachi**, DM `hamachi-host`: *report the output of `systemctl is-active
> clawcius.service` and change nothing.*

```sh
journalctl -u clawcius-ops -n 40
# [ops mail hamachi] running a task for hamachi-coordinator: report the output of systemctl…
# [ops] request: task by mail from hamachi-coordinator (from hamachi-coordinator) — …
```

In dry-run the session has no Bash tool, so this proves the whole pipeline —
mailbox, the coordinator check, the lock, the session, the audit, the reply —
without anything running. Read what it says it would have done.

The `(from …)` is the mail row's author column, written by the waker from the
sending session's own `sendMail` closure. No argument anywhere reaches it and
nothing in a message body can change it.

### The status file each waker publishes

A task may recreate a container, and every live agent session is
a `docker exec` into it — doing that mid-turn kills someone's conversation. The
executor learns whether that would happen from a small JSON file each waker
writes:

```
/var/lib/clawcius/waker-status.json     # status.file in agent-config.yaml
/var/lib/hamachi/waker-status.json      # ditto, agent-config.hamachi.yaml
```

**Note the path.** It is a *sibling* of `run/`, not a child. `run/` is
bind-mounted read-write into the container, so a status file inside it would be
writable by the agent — and an agent that can publish "no turns in flight" can
talk a root process into believing a container is safe to recreate. Both config
loaders check the containment against **`<stateDir>/run` itself** and refuse to
start if it is violated. Until 2026-08-16 they checked against
`<stateDir>/run/wake`, one level below the directory that is actually mounted,
so `<stateDir>/run/waker-status.json` passed both while sitting somewhere the
agent could write it (Clawcius #55); the waker learns the path from the new
`container.stateDir` key, which must match `CLAWCIUS_STATE_DIR` in that
instance's container unit and `instances[].stateDir` in `ops/ops-config.yaml`.

Missing, stale, malformed or future-dated all read as *busy*, which is the safe
direction; a waker that crashed leaves a stale `liveCount: 0` behind, and that
is the one value that must never be believed.

**Nothing reads that verdict at present.** The executor consumed it in one
place — the wait for an idle turn before something destructive — and that wait
went with the ops spool. The file is still published, still validated and still
contained, because the containment is the expensive part to get right and the
consumer is the cheap part to add back.

### Where each turn's environment is written

The same reasoning, one directory over. Every turn is a `docker exec`, and the
session environment it carries includes `DISCORD_TOKEN` and `GITHUB_TOKEN`.
Those used to be `-e KEY=VALUE` arguments, which put both credentials in a
world-readable `/proc/<pid>/cmdline` for the length of every turn — readable by
`clawcius-ops`, by anything in `clawcius-dev`, by any account with a shell. They
now go in a file:

```
/var/lib/clawcius/exec-env/      # container.execEnvDir in agent-config.yaml
/var/lib/hamachi/exec-env/       # ditto, agent-config.hamachi.yaml
```

Mode `0600` in a `0700` directory, written per turn and unlinked when the exec
ends; orphans from a hard kill are swept when the waker next starts. Nothing
needs creating by hand — the waker makes the directory on first use.

**Note the path, again.** A sibling of `run/`, and outside every `-v` in
`docker/run-container.sh`. Two of those mounts (`.claude`, `discord-cli`) are
shared by *both* instances, so a file placed there would hand one deployment's
bot token to the other deployment's agent. The config loader refuses to start if
`container.execEnvDir` lands inside any mount it can see.

Restart the wakers after adding the `status:` block so they begin publishing:

```sh
sudo systemctl restart clawcius hamachi
cat /var/lib/clawcius/waker-status.json
```

### Going live

Before you do: install the sudoers file and **check it parses**, from a second
shell that already has root, because a syntax error in `/etc/sudoers.d` breaks
sudo for everybody:

```sh
sudo install -m 0440 -o root -g root ops/clawcius-sudoers /etc/sudoers.d/clawcius
sudo visudo -c -f /etc/sudoers.d/clawcius
sudo -u npurcell sudo -n journalctl -u clawcius --no-pager -n 1   # should work
sudo -u npurcell sudo -n sh -c id                                 # should NOT
```

`ops/README.md` § Sudoers says what each grant is for and what is deliberately
absent. Note that it does **not** grant docker: npurcell reaches docker through
group membership, which is root-equivalent, so the sudoers scoping is about
keeping the easy path the audited one rather than about containment.

Then set `dryRun: false` in `ops/ops-config.yaml` and restart the executor. Know
what that turns on: from that moment a task runs a shell with sudo on this host
and **nothing rolls it back**. The health sample either side reports; it does
not repair.

```sh
sudo systemctl restart clawcius-ops
```

### When it freezes

A frozen executor refuses every task and says so, loudly, in the journal and in
the reply to whoever asked.

**Nothing sets it any more.** The circuit breaker that did counted failed
recoveries on the spool task path — a missed check-in, or a task that had to be
rolled back — and that path went with the spools on 2026-08-16, taking the
snapshot, the deadline and the rollback with it. So a freeze you are looking at
predates that. The flag is still read, still persisted and still clearable,
because a host that is frozen today must not quietly unfreeze itself on the
next deploy:

```sh
sudo ops/unfreeze.sh                    # prints why, asks, then clears
sudo systemctl restart clawcius-ops
```

### The units, after the audit

Every unit in `systemd/` was read line by line on 2026-08-10 after
`MemoryDenyWriteExecute=true` in `clawcius-status.service` turned out to make
it impossible for Node to start at all (#7). `clawcius-ops.service` had a
directive of exactly the same character: `ProtectHome=read-only`, on a unit
whose entire job includes writing to a checkout in `/home/npurcell`. It is
gone; `MemoryMax` and `TasksMax` were raised to fit the build, since systemd's
cgroup limits apply to children too. `ops/README.md` § "The systemd units,
audited" has the table of what was checked, kept, and deliberately left out.

The rule that came out of both incidents: **do not add a hardening directive to
these units without loading the unit and running the affected verb.** A broken
executor looks exactly like an agent whose requests are being ignored.

---

## 8. The status page

`status/` is a separate, read-only service that shows what every agent on this
host has been doing — liveness, session timelines, and the subagent tree for
any session drawn over a time axis. It reads transcripts off local disk and
talks to nothing: not Docker, not Discord, not the agents. It deliberately has
no dependency on the rest of the stack, because a status page that goes down
with what it monitors is one you cannot use at the moment you need it.

```sh
cd status && npm install && npm run build

sudo cp systemd/clawcius-status.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clawcius-status
```

It binds `127.0.0.1:8477` and **refuses to start on any non-loopback address**.
Publishing it to the tailnet is one command:

```sh
sudo tailscale serve --bg 8477
```

That terminates HTTPS with a Tailscale-issued certificate, gives the page a
MagicDNS name (`https://<hostname>.<tailnet>.ts.net/`), and proxies to the
loopback port. No public port is opened and no firewall rule is needed. Check
with `tailscale serve status`; remove with
`sudo tailscale serve --bg --https=443 off`.

The loopback bind is the point rather than an implementation detail: if
tailscaled dies, the page becomes *unreachable* instead of becoming *public*.

Transcript roots default to the host side of the agent-home mount —
`/var/lib/clawcius/agent-home/projects` and `/var/lib/hamachi/agent-home/projects`.
Each instance also names its Clawsky board — its `CLAWCIUS_DB_PATH` — as
`boardDb`, opened read-only. That is where the *agents* are; the transcript
root only holds directories, and a directory is not an agent. Adding an
instance means a new entry under `agents:` in `status/status-config.yaml`
**and** matching `ReadOnlyPaths=` lines in the unit, one for the root and one
for the board.

One thing to know before you go looking: the boards are in WAL mode, and a
read-only reader needs the `-shm` wal-index that SQLite deletes on the last
clean close. The status unit runs `ProtectSystem=strict` and cannot create one,
so **while nothing holds a board open, that instance's agent list is
unreadable** and the page says so. In practice that means its waker is stopped
— but the ops daemon holds the same file wherever a `board:` block is
configured, so the page reports what it observed rather than naming a service.
Transcripts are unaffected; they never go through SQLite. Full detail,
including the security model, is in [`status/README.md`](status/README.md).

---

## 9. When the build says nothing at all

`npm run build` exiting **216** with no output means `tsc` could not walk the
tree, and by far the most likely reason is a `node_modules` **symlink pointing
at itself**. A git worktree has no install of its own, so the usual move is to
link the main clone's — and until 2026-08-16 `.gitignore` said `node_modules/`,
whose trailing slash matches a directory and not a symlink. One `git add -A`
and the link is committed, with an absolute path as its content; checked out on
the machine that path names, it resolves to itself. `NickPurcell/OJ` shipped
exactly this (Clawcius #60).

What makes it expensive is the second half. `npm test` is `build && node --test`,
so the suite never runs — but a test binary invoked directly returns **green
from a stale `dist/`**, and a passing count gets reported from the previous
commit's compiled output.

```sh
git check-ignore -v node_modules   # no output means it is NOT ignored
ls -l node_modules                 # a self-referential link is visible here
rm -rf dist && npm run build       # before believing a suspicious pass
```

Two habits that go with it:

- **`rm -rf dist` before trusting a green run** that follows a build you did
  not watch succeed.
- **Do not gate on `$?` after a pipe.** `npm run build 2>&1 | tail -3; echo $?`
  prints `tail`'s status, not the build's — it says `0` over a failed build.
  Use `${PIPESTATUS[0]}`, or do not pipe.

### Asking a running service which commit it is

Every unit that runs `node dist/…` prints its build identity as its **first**
line, before it loads config and before anything can stop it:

```sh
journalctl -u clawcius-status          -b | grep -m1 'build '
journalctl -u clawcius-ops             -b | grep -m1 'build '
journalctl -u clawcius                 -b | grep -m1 'build '
journalctl -u hamachi                  -b | grep -m1 'build '
journalctl -u clawcius-snapshot-verify -b | grep -m1 'build '
git -C /home/npurcell/clawcius rev-parse --short HEAD    # compare
```

It is printed from a module imported *before* the config loader, on purpose:
`clawcius-ops` failed to start 22,675 consecutive times inside its config
loader, and a banner emitted after the config parsed would have appeared on
none of them. `clawcius-ops` also writes the same identity into
`journal.jsonl`'s boot entry and into the `build` field of `ops-status.json`;
each waker writes it into its `waker-status.json`.

```
[status] build 84ec62e (main) built 2026-08-18T09:12:44.017Z from a clean tree
```

Three states, and the difference between them is the point:

| Line says | Means |
|---|---|
| `… from a clean tree` | The artefact is that commit. Compare the sha with `rev-parse` and you are done. |
| `… from a DIRTY tree — N uncommitted path(s): …` | The sha is where the tree started, not what was compiled. The line names the files and says outright that the artefact is not that commit. |
| `UNKNOWN — <reason>` | Git could not be asked at build time. Nothing is guessed and nothing "clean" is printed. The service still boots. |

The sha is **baked in by `scripts/build-info.mjs` at build time**, not read from
git at startup, and the whole value is in that distinction. On 2026-08-10 the
status page was deployed without a rebuild and served an eight-day-old `dist/`
while the checkout sat at the right commit: a runtime `git rev-parse` would have
printed a perfectly correct sha for code that was not running (Clawcius #90). In
the same week `clawcius-ops` failed to start 22,675 times on a `dist/` older
than its own config (#89). Both were found by listing a directory and eyeballing
timestamps, because **the journal is the only verification channel there is** —
the host agent can read journals and cannot make an HTTP request, by design, and
the container agents cannot reach the host at all.

The generator is wired into `build`, `typecheck` and `dev` in all three
packages, and writes an untracked `src/build-info.ts`.

**Not knowing is never a failure; not writing always is.** If git is missing or
the directory is not a checkout, it writes `UNKNOWN`, exits 0, and the service
boots. If it cannot *write* the file it stops the build with one sentence naming
the file — deliberately, because `&& tsc` continuing would compile against the
previous build's `build-info.ts` and the artefact would then report someone
else's commit. On this host the usual cause is a root-owned file from a build
that ran as root; the `chown -R` above is the fix.

**A bare `npx tsc` skips it** and will compile new code carrying an older sha —
use `npm run build`.

The uncommitted-path *count* is exact; the *list* keeps the first 20, each
elided past 100 characters. That is a size ceiling, not tidiness: the same
constant is published inside `waker-status.json`, and `ops/src/idle.ts` treats
that file as implausible above 8 KiB and therefore reads the instance as
**busy**. Because the value is compiled in, one oversized build would mean that
instance is never seen idle again for the life of the build, with the journal
blaming the waker rather than the field that grew. A 262-path dirty tree used to
produce 10098 bytes; it now produces 1878.

`status/` also prints, and re-probes on every `/healthz`, whether it can
actually read each configured root and board — with the errno, the mode and the
owning uid when it cannot. See [`status/README.md`](status/README.md).

---

## Known gaps

- **Not exercised end-to-end since the container migration.** Agent turns,
  egress enforcement, session resume and self-wake are each verified, but no
  Discord @mention has been served from inside the container yet.
- **The media allowlist is broad and unverified against live sites.** X,
  Instagram, TikTok and YouTube are allowed along with their CDN domains, but
  no download has been run through the proxy yet. Extractors change hostnames
  without notice; `docker logs clawcius-squid | grep TCP_DENIED` names whatever
  is missing.
- **`.fbcdn.net` is wider than Instagram.** It is Meta's shared CDN, and
  Instagram media genuinely lands there depending on which edge answers, so
  allowing only `.cdninstagram.com` gives intermittent failures. The cost is
  that other Meta-hosted content is reachable too.
- **The container's OAuth mount is a real exposure.** `.credentials.json` is
  mounted read-write so token refresh works, which means a compromised agent
  can use or exfiltrate it. Accepted deliberately to keep billing on the plan.
- **gVisor overhead is unmeasured.** `systrap` is the default platform; this
  host has nested virt so the `kvm` platform is also available. The agent is
  file-I/O heavy and no benchmark has been run.
- **Snapshots are untested as a restore path *on this host*.** This gap is
  what `clawcius-snapshot-verify.timer` exists to close: it restores the newest
  snapshot into a throwaway container nightly and fails the unit if it does not
  come up. The timer is written and its logic is covered by the ops self-test
  against stand-in binaries, but it has not yet run against real images here —
  so the gap stays open until the first green run at 05:30. Note that it *did*
  report green nightly for days over an image nothing had refreshed, which is
  the narrower gap below.
- **`hamachi-snapshot.timer` has never fired, and until it does hamachi's
  newest snapshot is 2026-08-14.** `systemd/hamachi-snapshot.{service,timer}`
  ship as of 2026-08-19; installing and enabling them is a deploy step (§ 3,
  *Install the units*) and nothing in the repo can do it. Between 2026-08-14
  and that unit, nothing on this host snapshotted `hamachi-agent` at all — not
  because a timer broke, but because the thing standing in for one was the ops
  executor's per-task snapshot, retired that day for unrelated reasons
  (Clawcius #87). **The check that closes this gap for good is the age check
  in `ops/src/verify.ts`, not the new timer**: if the units never get enabled,
  `clawcius-snapshot-verify` reports hamachi `stale` within two nights instead
  of reporting it healthy forever.
- **The ops executor has never executed anything, and has never started a host
  agent session.** Everything up to the spawn is tested against stand-ins (see
  `ops/README.md` § *What has and has not been tested*), and everything past it
  is not: no `claude` session started by the daemon, no `systemctl restart`
  performed, no container recreated, and no reply DM read by the coordinator
  that asked for it. It ships with `dryRun: true` for exactly this reason, and
  in that mode the session has no Bash tool at all.
- **The sandbox is no longer a security boundary for `clawcius-ops`.** Since
  2026-08-10 it starts a Claude Code session on the host with a shell and
  passwordless sudo. What replaces the old verb allowlist is **a complete audit
  log**, an unprivileged service account, and a narrow sudoers file — and that
  is now the whole list. It also said "a pre-task snapshot, an automatic
  rollback" until 2026-08-16; both belonged to the ops spool and went with it,
  so nothing undoes a task. This is a deliberate, documented trade and not an
  oversight; `ops/README.md` § *The trust model* is the honest version.
- **That session no longer runs as `npurcell` — and the migration to make that
  true has never been run.** Until 2026-08-11 it ran as the checkout's owner,
  which is `npurcell`, which is in the `docker` group, which the line above
  calls *"effectively root on the host"* — so the sudoers scoping was not a
  boundary and the audit was not tamper-proof. It now runs as an unprivileged
  system account (`clawcius-ops`) that the daemon refuses to start without, and
  **that account does not exist on this host yet**. Until
  [`MIGRATION.md`](MIGRATION.md) is executed, every ops task is refused with the
  reason and the fix — in a reply to the coordinator that asked. The daemon
  still boots, still takes its mailbox on each crew's board, still serves the
  unit desk and still publishes the status file. (It said "still honours its
  rollback deadlines" until 2026-08-16; there are no deadlines.)
- **`ops/clawcius-sudoers` has never been parsed by `visudo -c`.** It was
  written on a machine without sudo, and it was rewritten (larger, and against
  a different user) on 2026-08-11. Check it before installing, from a second
  shell that already holds root — `MIGRATION.md` § 3 has the sequence.
- **Nothing undoes a task.** This used to say the rollback covered containers
  only — `docker commit` captures an agent container's writable layer and not
  `/etc`, the checkout or unit files. Since 2026-08-16 it covers nothing: the
  snapshot went with the ops spool. The VPS snapshot and git are the undo, and
  a person operates both.
- **A task filed by DM cannot be undone.** The snapshot, the check-in deadline
  and the automatic rollback belonged to the ops spool and went with it on
  2026-08-16. The health sample either side reports and does not repair. Undoing
  a task is a person's decision, and `journal.jsonl` holds every command it ran.
- **The circuit breaker has no writer.** `frozen` is still read, still persisted
  and still cleared by `ops/unfreeze.sh`; nothing sets it. See § When it
  freezes.
