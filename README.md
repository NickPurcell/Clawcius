# Clawcius

A Discord bot that wakes a long-lived, sandboxed Claude Code agent. The agent
replies by driving a CLI itself — nothing pipes its output to Discord.

```
                    host                    gVisor container
@mention ─┐                          ┆
          ├─→ waker ──docker exec──→ ┆  agent (warm, persistent)
self-wake ┘   (gateway, tokens)      ┆    │
                                     ┆    ├─→ discord CLI ─┐
                                     ┆    └─→ cron, daemons ┤
                                     ┆                      ▼
                                     ┆              Squid allowlist ─→ Discord
```

Two halves:

- **`src/`** — the waker (TypeScript). Listens on the Discord gateway, decides
  when to wake, keeps one persistent Claude Code session per channel, and owns
  the timers for self-scheduling. It never composes or sends messages.
- **`discord-cli/`** — the CLI the agent runs (Python, stdlib only, no install
  step). Read, send, search, react, edit, delete. Structured exit codes so the
  agent branches on status rather than parsing prose.

And one thing that only watches:

- **`status/`** — a read-only observability page for every agent instance on
  the host. Reads transcripts off local disk; shows liveness, session timelines
  and the subagent tree over a time axis. Binds loopback only and is published
  to the tailnet with `tailscale serve`. See [`status/README.md`](status/README.md).

## How it behaves

**Wakes** on an @mention, on any message during a follow-up window after it has
been addressed, or on a wake it scheduled for itself.

**Bundles** rapid messages — each new message restarts a short debounce, with a
ceiling so continuous typing cannot defer it forever, so a burst of three lines
arrives as one turn rather than three.

**Stays warm.** One session per channel, never evicted by default, resumed from
SQLite across restarts. Nothing obliges it to reply; silence is a normal
outcome.

**Schedules itself.** No bespoke scheduler: the agent has cron inside its
container and asks to be woken by dropping a JSON file in a watched directory.
A rate limit still applies — a request is a request, not a command.

## Containment

The agent process lives inside a persistent **gVisor** container. gVisor
intercepts syscalls in userspace, so nothing the agent does reaches the host
kernel — and because the whole process is inside, the boundary covers every
tool rather than only shell commands.

Egress is enforced by topology rather than configuration. The container sits on
a Docker `--internal` network with no route to the outside; **Squid** is the
only reachable thing that has one, and it enforces a domain allowlist on the
CONNECT target with no TLS interception. Unsetting the proxy variables, passing
`--noproxy '*'`, or connecting by raw IP all simply fail — there is no second
route to find.

The container is long-lived on purpose: cron jobs, daemons and Discord bots the
agent writes keep running between turns, with no model in the loop.

There is no docker socket and no host socket inside, so the agent cannot touch
its own deployment directly. What it has instead is a conversation: a crew's
**coordinator** DMs `<crew>-host` with a **task** — free text,
"clawcius.service has been restarting every 30s since the deploy, find out why
and fix it" — and a separate root daemon hands it to a Claude Code session
running on the host, with a shell and sudo. The answer comes back as a DM.

Until 2026-08-10 that path carried a closed list of seven verbs, and the
argument for it was that a finite, enumerated set of operations is a safety
property. It is, and it was given up deliberately: a closed set can only hold
what somebody imagined in advance, and every gap in it turned the operator into
the agent's hands. **For that one component the sandbox is no longer a security
boundary.** What replaces it is a complete audit of every command the session
runs, written before each command's result is known; the fact that only a
coordinator can ask at all, checked twice against a column no message body can
reach; and the fact that this is a personal VPS with snapshots. Since 2026-08-11
it also runs as an unprivileged system account of its own (`clawcius-ops`)
rather than as the operator — who is in the `docker` group, which is root, which
made every other control in `ops/` decoration. The daemon refuses to start a
session as an account that is missing, is uid 0, is in a root-equivalent group,
or can read the operator's secrets.

**There used to be more, and it is worth knowing what went.** Until 2026-08-16
the way in was a bind-mounted spool directory, and around it stood a snapshot
before every task, an automatic rollback if the task failed or a service stopped
being healthy, a deadline the agent had to answer or be reverted, and a circuit
breaker that froze the whole mechanism after two failed recoveries. All of it
was retired with the spool. **Nothing undoes a task now.** The health sample
either side of a task survives and it reports; it does not repair. Undoing is a
person's decision, with the VPS snapshot and git.

See [`ops/README.md`](ops/README.md) — the trust model section is the honest
account — and [`MIGRATION.md`](MIGRATION.md), which is how the host gets from
one to the other and has not been run yet. It ships in dry-run, and in dry-run
the session has no shell at all.

## Configuration

| File | Holds | Committed |
|---|---|---|
| `agent-config.yaml` | Model, turn cap, system prompt, sessions, scheduling | yes |
| `squid/squid.conf` | The egress allowlist — the only copy | yes |
| `ops/ops-config.yaml` | The ops executor's health manifest, limits and instances — *not* an allowlist of what it may do | yes |
| `ops/clawcius-sudoers` | What the host agent may do with sudo, by exact command and exact unit name, and why | yes |
| `MIGRATION.md` | Creating the host agent's service account, the shared group, the deploy key — with a rollback path. **Not yet executed.** | yes |
| `status/status-config.yaml` | Transcript roots, port, liveness thresholds | yes |
| `.env` | Discord token, guild id, optional API key | **no** |

Behaviour and persona live in `systemPrompt.append`. The code contributes only
mechanics — that the agent's stdout is invisible and which command makes words
appear.

By default there is no API key: the agent inherits the environment and
authenticates with the same OAuth login as Claude Code.

## Setup

See [SETUP.md](SETUP.md) — prerequisites, authentication, the systemd units,
and the memory budget. [`squid/README.md`](squid/README.md) covers the egress
proxy and how to change the allowlist.

Requires Node 22+, Docker with the `runsc` (gVisor) runtime, and Python 3.11+.

## Recovery

The container is persistent, and resetting it is deliberate. `up.sh` reuses an
existing container and `down.sh` stops rather than removes it, so packages the
agent installed and crontabs it wrote survive restarts and reboots — otherwise
"persistent sandbox" would be a fiction.

Code the agent writes lives in git; the writable layer is snapshotted nightly
by a host-side timer the agent cannot reach. A wedged container is one flag
from clean, with the workspace mount untouched:

```sh
docker/up.sh --recreate   # discard the writable layer, rebuild from the image
```

Those snapshots are now restore-tested rather than trusted:
`clawcius-snapshot-verify.timer` boots the newest one in a throwaway container
nightly and fails loudly if it does not come up. The usual cause of a failed
rollback is a restore path nobody ever ran.
