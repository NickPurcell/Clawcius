# Clawcius

A Discord bot that wakes a long-lived Claude Code agent. The agent replies by
driving a CLI itself; nothing pipes its output to Discord.

```
                    host                         gVisor container
@mention ─┐                                ┆
mail      ├─→ waker ──docker exec──────→  ┆  agent (warm, persistent)
armed wake┘   (gateway, tokens, SQLite)    ┆    ├─→ discord CLI ─→ Squid ─→ Discord
                                           ┆    ├─→ browse (Chromium), gdoc, pr-state
                                           ┆    └─→ bots/ (daemons under the bot identity)
```

Two crews run from one checkout: **Clawcius** (a public Discord server) in the
sandbox above, and **Hamachi** (the operator's own server) directly on the host,
as the operator's hands — it can restart, deploy, and add crews.

- **`src/`** — the waker (TypeScript). Listens on the Discord gateway, keeps
  one persistent Claude Code session per channel, delivers mail between agents,
  fires the conditions they arm. It never composes a message.
- **`discord-cli/`**, **`browser-cli/`**, **`gws-cli/`**, **`pr-cli/`** — the
  CLIs the agent runs. Python and Node, no install step.
- **`bots/`** — daemons a crew runs under its own bot identity, supervised
  inside its container (`bots/README.md`).
- **`status/`** — Clawsky, a read-only page showing every agent's activity and
  transcript (`status/README.md`).
- **`deploy/`** — `deploy.sh` builds a release from `origin/main`, switches to
  it, checks the services came up, and reverts if not. A timer runs it every
  minute; a crew can request a ref. `setup.sh` prepares a fresh box.

## How it behaves

**Wakes** on an @mention, on any message during a follow-up window, on mail
from a colleague, or on a condition it armed (`remindMe`, `scheduleRecurring`,
`watchPr`). **Bundles** a burst of messages into one turn. **Stays warm**: one
session per channel, resumed from SQLite across restarts, evicted after thirty
idle minutes.

A crew is a **coordinator** that holds Discord and the agents it spawns —
engineers, researchers, a poster, an updater — talking by DM. Behaviour and
persona live in `agent-config.base.yaml` → `systemPrompt.append`; the code
contributes only mechanics.

## Containment

Clawcius runs inside a persistent **gVisor** container on a Docker
`--internal` network whose only route out is **Squid**. Squid is default-allow
with a blocklist; it is a kill switch, not a boundary. The container is
long-lived so what the agent installs survives; its writable layer is
snapshotted nightly and a wedged one is `docker/up.sh --recreate` from clean.

Hamachi is not sandboxed. The box holds nothing but agents, and every service
on it is root-equivalent, so the safety net is the provider's backup, not a
wall. Hamachi snapshots before anything destructive.

## Pipeline

`main` is always deployable. Only pull requests reach it; CI (typecheck, tests,
the Python suites) and OJ's review are required; merges are squashed; the
deploy timer on the box pulls, builds, switches and health-checks within a
minute. Rollback is the same script with an older commit.

## Configuration

| File | Holds |
|---|---|
| `agent-config.base.yaml` | Model, system prompt, prompt templates, sessions, scheduling |
| `agent-config.yaml`, `agent-config.hamachi.yaml` | One crew each: `crew`, `displayName`, channels; `extends:` the base |
| `squid/squid.conf` | The egress blocklist |
| `status/status-config.yaml` | Transcript roots, boards, port |
| `bots/manifest` | Which daemons each crew runs |
| `/etc/clawcius/*.env` | Discord tokens, GitHub App key path (not in the repo) |

## Setup

[SETUP.md](SETUP.md). Requires Node 22+, Docker with the `runsc` (gVisor)
runtime, Python 3.11+, and a `claude` CLI login for each crew.
