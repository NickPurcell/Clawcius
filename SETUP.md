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
docker/up.sh        # networks + squid + agent container
docker/down.sh      # stop both containers
docker/snapshot.sh  # commit the agent container's writable layer to an image
```

`runtime: container` in `agent-config.yaml` selects this path. `runtime: host`
exists for debugging only and confines nothing but shell commands.

Startup **refuses** `runtime: container` together with `sandbox.enabled: true`:
the SDK sandbox is redundant inside gVisor and cannot work anyway, because
`apply-seccomp` needs a nested user namespace that this host's
`kernel.apparmor_restrict_unprivileged_userns=1` denies.

---

## 1b. Configuration split

Two files, on purpose:

| File | Holds | Commit it? |
|---|---|---|
| `.env` | Discord token, guild ID, optionally an API key | **No** |
| `agent-config.yaml` | Model, turn cap, system prompt, sandbox, sessions | **Yes** |

Changing the agent's personality should be a reviewable diff, not an edit to a
file full of secrets. Every key in the YAML is optional and falls back to the
defaults in `src/agent-config.ts`; the loader validates types and fails at
startup with the offending path named, rather than at the first mention.

One validation is deliberately fatal: `sandbox.allowedDomains` must contain
`discord.com`. Without it the agent starts, runs, and silently cannot speak —
a miserable thing to debug from the Discord side.

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

## Known gaps

- **Not exercised end-to-end since the container migration.** Agent turns,
  egress enforcement, session resume and self-wake are each verified, but no
  Discord @mention has been served from inside the container yet.
- **`rules.yaml` is empty and arguably redundant.** The deterministic rule
  engine predates the container; the agent can now write a real daemon with a
  gateway connection instead. The engine stays because it is a zero-latency
  path that needs no agent involvement at all, but it is no longer the obvious
  answer.
- **The `sandbox:` block in `agent-config.yaml` is vestigial** in container
  mode. `allowedDomains` there is not what enforces egress — `squid/squid.conf`
  is. Keeping them in sync is currently manual.
- **The container's OAuth mount is a real exposure.** `.credentials.json` is
  mounted read-write so token refresh works, which means a compromised agent
  can use or exfiltrate it. Accepted deliberately to keep billing on the plan.
- **gVisor overhead is unmeasured.** `systrap` is the default platform; this
  host has nested virt so the `kvm` platform is also available. The agent is
  file-I/O heavy and no benchmark has been run.
- **Snapshots are untested as a restore path.** `docker/snapshot.sh` produces
  images (~2 GB each, 8 retained), but restoring from one has never been
  rehearsed.
