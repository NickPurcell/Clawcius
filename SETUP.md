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

No bespoke scheduler. The agent has cron inside its container and asks to be
woken by writing a file:

```sh
0 9 * * *  echo '{"channel":"<id>","prompt":"post the briefing"}' \
             > /var/lib/clawcius/run/wake/$(date +%s).json
```

The waker watches that directory (`fs.watch`, plus a 5s sweep because gVisor's
gofer does not reliably deliver inotify for writes made inside the sandbox),
consumes each request, and starts a turn. `wake.maxPerHour` still applies — a
request is a request, not a command, so this cannot be used to escape the
concurrency cap.

A unix socket was the original design. gVisor blocks connections to host unix
sockets, correctly, since one would be a hole straight through the sandbox
boundary; a bind-mounted directory needs no such exception.

---

## 7. The ops executor

The same idea as § 6b, generalised from "wake me" to a short list of privileged
host operations, so the agents can maintain their own deployments without a
person having to log in and restart a service.

`ops/README.md` is the full write-up — the verb list, the trust model, and why
it is a separate daemon. The short version of the last one: `restart
clawcius.service` is one of the operations, and a process cannot restart itself
without dying mid-operation. The executor has to outlive the things it
restarts, so it is its own unit with no Discord connection, no credential and
no model.

**It ships in dry-run.** `dryRun: true` in `ops/ops-config.yaml` makes it take
every decision and log the exact argv it would have run, without running any of
it. Leave it on until a week of `journalctl -u clawcius-ops` holds no
surprises. This is a root process with docker and systemctl.

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
npm run selftest              # 82 tests, no docker required

sudo cp ../systemd/clawcius-ops.service \
        ../systemd/clawcius-snapshot-verify.service \
        ../systemd/clawcius-snapshot-verify.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clawcius-ops.service
sudo systemctl enable --now clawcius-snapshot-verify.timer
```

**One spool per instance, since 2026-08-10.** Each lives inside that
instance's own `run/` mount — the only part of its state directory that
`docker/run-container.sh` bind-mounts — because that is what makes it reachable
from that container and from no other. There used to be a single shared one at
`/var/lib/clawcius/run/ops`, and it was reachable from Clawcius's container and
simply absent from Hamachi's, which meant the agent the operator talks to most
could not file a request at all. `ops/README.md` has the whole account.

`docker/run-container.sh` creates them now, next to `run/wake`, running as
`npurcell` so the ownership matches the container's uid without a `chown`. The
executor also creates and chowns them at startup, so a fresh host works before
any container has been started. Neither needs a manual step, but if you want to
do it by hand ahead of time:

```sh
sudo install -d -m 0770 -o npurcell -g npurcell /var/lib/clawcius/run/ops
sudo install -d -m 0770 -o npurcell -g npurcell /var/lib/hamachi/run/ops
```

Check it is watching **both**, and that the first thing it says is that it is
not really doing anything:

```sh
journalctl -u clawcius-ops -n 30
# [ops] boot: clawcius-ops — … DRY RUN — every decision is made and logged, nothing is executed.
# [ops] watching /var/lib/clawcius/run/ops for clawcius (sweep 5s)
# [ops] watching /var/lib/hamachi/run/ops  for hamachi  (sweep 5s)
```

If the log carries a `config deprecation` line, `ops-config.yaml` still has the
old top-level `spoolDir:`. It has been accepted and attributed to the instance
that owns it — nothing has changed for that instance — and the line names the
replacement. Delete the key.

Then file a request from inside each container and watch it land. Do both:
the second one is the case that was broken, and it is the one worth proving.

```sh
for c in clawcius hamachi; do
  docker exec "$c-agent" sh -c "
    OPS=/var/lib/$c/run/ops; S=\$(date +%s)
    printf '%s' '{\"verb\":\"restart\",\"unit\":\"clawcius.service\",\"reason\":\"smoke test\"}' \
      > \$OPS/\$S.tmp && mv \$OPS/\$S.tmp \$OPS/\$S.json"
done
journalctl -u clawcius-ops -n 20
# [ops] request: restart clawcius.service (from clawcius) — filed by clawcius as …
# [ops] request: restart clawcius.service (from hamachi)  — filed by hamachi as …
```

The `(from …)` is the point of the change: with one shared spool those two
lines were identical, and the executor had no way to tell which agent had
asked.

### The status file each waker publishes

`redeploy` and `rollback` recreate a container, and every live agent session is
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
talk a root process into destroying a live session, or into believing a
rollback is safe. Both config loaders check the containment and refuse to start
if it is violated. Missing, stale, malformed or future-dated all read as
*busy*, which is the safe direction; a waker that crashed leaves a stale
`liveCount: 0` behind, and that is the one value that must never be believed.

Restart the wakers after adding the `status:` block so they begin publishing:

```sh
sudo systemctl restart clawcius hamachi
cat /var/lib/clawcius/waker-status.json
```

### Going live

Set `dryRun: false` in `ops/ops-config.yaml` and restart the executor. Set the
two `wakeChannelId` values first — they are placeholder zeros in the shipped
config, and they are where the "you were rebuilt, verify and check in" wake is
delivered. Without a real channel the agent never hears that it is on a
deadline, and fifteen minutes later it gets rolled back for not answering a
question it was never asked.

```sh
sudo systemctl restart clawcius-ops
```

### When it freezes

After two consecutive missed check-ins the executor stops accepting destructive
verbs and says so, loudly, in the journal. That is deliberate: something is
wrong that redeploying cannot fix, and continuing would mean reinstalling the
outage every fifteen minutes.

```sh
sudo ops/unfreeze.sh                    # prints why, asks, then clears
sudo systemctl restart clawcius-ops
```

The quarantine list is not cleared by that, and there is no verb for any of it.
An agent that can unfreeze the breaker holding back its own broken build is
back where we started.

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
Adding an instance means a new entry under `agents:` in
`status/status-config.yaml` **and** a matching `ReadOnlyPaths=` line in the
unit. Full detail, including the security model, is in
[`status/README.md`](status/README.md).

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
  so the gap stays open until the first green run at 05:30.
- **The ops executor has never executed anything.** Everything up to the
  `execFile` is tested (see `ops/README.md` § *What has and has not been
  tested*), and everything past it is not: no `systemctl restart` performed, no
  container recreated, no snapshot committed or restored, no post-rebuild wake
  picked up by a live waker. It ships with `dryRun: true` for exactly this
  reason.
- **The `wakeChannelId` values in `ops/ops-config.yaml` are placeholder
  zeros.** Until they are real channels the post-rebuild wake goes nowhere, and
  an instance would be rolled back for failing to answer a question it never
  received. Set them before turning `dryRun` off.
