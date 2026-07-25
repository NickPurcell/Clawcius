# Clawcius

A Discord bot that wakes a long-lived, sandboxed Claude Code agent. The agent
replies by driving a CLI itself — nothing pipes its output to Discord.

```
@mention ─┐
          ├─→ waker ─→ warm agent session ─→ bash: discord reply … ─→ Discord
schedule ─┘
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

**Schedules itself.** The Agent SDK ships no `ScheduleWakeup` equivalent, so
four in-process MCP tools supply it, bounded by a delay floor, a pending cap,
and a per-day ceiling re-checked at fire time.

## Containment

The agent runs under `bwrap --unshare-net` — no route to the internet at all.
The only way out is a socat bridge to a proxy that enforces a domain allowlist,
which is why the allowlist is enforcement rather than advice: there is no
network to bypass the proxy *to*. Either the SDK's own proxy or an external
Squid can answer on the far end (`sandbox.egress.mode`).

Known gap: `WebFetch` and `WebSearch` run in the parent process, outside the
per-bash sandbox, and do not pass through the proxy.

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

Requires Node 22+, `bwrap`, `socat`, and Python 3.11+.
