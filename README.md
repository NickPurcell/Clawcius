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
its own deployment directly. What it has instead is a spool: it files a request
for one of a short list of operations — restart a service, pull a checkout,
recreate or roll back a container — and a separate root daemon reads it. Every
argument is matched against an allowlist by exact string, nothing is ever
handed to a shell, and after anything destructive the agent has a deadline to
say it came back or it is rolled back automatically. See
[`ops/README.md`](ops/README.md); it ships in dry-run.

## Configuration

| File | Holds | Committed |
|---|---|---|
| `agent-config.yaml` | Model, turn cap, system prompt, sessions, scheduling | yes |
| `squid/squid.conf` | The egress allowlist — the only copy | yes |
| `ops/ops-config.yaml` | What the ops executor is allowed to do, by exact name | yes |
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
