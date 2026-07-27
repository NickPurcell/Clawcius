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

## Configuration

| File | Holds | Committed |
|---|---|---|
| `agent-config.yaml` | Model, turn cap, system prompt, sandbox, sessions, scheduling | yes |
| `.env` | Discord token, guild id, optional API key | **no** |

Behaviour and persona live in `systemPrompt.append`. The code contributes only
mechanics — that the agent's stdout is invisible and which command makes words
appear.

By default there is no API key: the agent inherits the environment and
authenticates with the same OAuth login as Claude Code.

## Setup

See [SETUP.md](SETUP.md) — prerequisites, the sandbox decision, authentication,
the systemd unit, and the memory budget. [`squid/README.md`](squid/README.md)
covers the optional external proxy.

Requires Node 22+, Docker with the `runsc` (gVisor) runtime, and Python 3.11+.

## Recovery

The container is disposable. Code the agent writes lives in git; the container's
own state — packages, cron entries — is snapshotted nightly by a host-side timer
the agent cannot reach. A wedged container is `docker rm` plus `docker/up.sh`
away from clean, with the workspace volume untouched.
