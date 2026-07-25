# Clawcius — setup

An @mention in Discord wakes a long-lived, sandboxed Claude Code agent. The
agent replies by invoking the `discord` CLI itself.

```
@mention → [waker] → wakes agent with context
                          ↓
                   agent reasons, then
                   bash: discord reply -c <channel> -m <msg> -t …
                          ↓
                      Discord
```

The waker is deliberately thin: it authorizes the mention, hands the agent
context, and gets out of the way. It never composes or sends replies. The one
exception is the no-reply fallback — if a turn ends without the agent having
called the CLI, the waker posts a notice, because from the user's side silence
is indistinguishable from a dead bot.

**Two halves.** `discord-cli/` (Python, stdlib-only) is yours; the waker and
agent wiring (`src/`, TypeScript) is here. `.claude/skills/discord-cli/SKILL.md`
is the single source of truth for the CLI's interface — `src/prompt.ts`
deliberately does not restate any of it, so the two cannot drift.

`src/` typechecks and builds against the installed SDK
(`@anthropic-ai/claude-agent-sdk@0.1.77`, `discord.js@14.27.0`). What remains
needs root, a reboot, or the CLI.

---

## 1. The sandbox decision — read this first

There is one architectural choice still open, and it changes what you install.

**The Agent SDK spawns Claude Code as a child process of the bot.** It does not
containerize anything by itself. So "put the agent in gVisor" resolves to one of
three shapes:

### Option A — SDK sandbox only (no gVisor)

The SDK ships its own sandbox: `sandbox.enabled` plus
`network.allowedDomains`, an egress allowlist enforced per agent. Paired with
`autoAllowBashIfSandboxed`, the agent runs bash freely *because* it is
contained — a materially better posture than blanket `bypassPermissions`.

- **Requires `bwrap` and `socat` on PATH.** `bwrap` is present on this VM;
  `socat` is not. Startup preflight refuses to boot without both — see
  § Egress below for why this is fatal rather than a warning.
- On by default via `sandbox.enabled: true` in `agent-config.yaml`.
- Weakest isolation of the three, but a real egress allowlist and no kernel-level
  trust in the agent's syscalls.
- **Start here.** Get the bot working, then decide if you want more.

### Option B — one gVisor container for the whole bot

Run bot + all agents inside a single `--runtime=runsc` container.

- Simple; one container to manage.
- All threads share a kernel boundary — thread isolation is only the SDK
  sandbox and separate `cwd`s.
- Nesting the SDK sandbox inside gVisor may require
  `sandbox.weakerNested: true`, which weakens the inner sandbox. Either accept
  that, or set `sandbox.enabled: false` and let gVisor + Docker network policy
  be the only boundary.

### Option C — one gVisor container per agent

The SDK exposes `spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess`
in `Options`. That hook lets you launch each agent via
`docker run --runtime=runsc …` instead of a local subprocess.

- Strongest isolation: per-thread kernel boundary, per-thread network policy.
- Most work, and container start cost lands on the first message of each thread
  (this is what a warm pool would amortize).
- Not implemented yet — the hook is the integration point when you want it.

**Recommendation:** ship Option A, measure, then move to C if you want real
per-thread isolation. B is a middle ground that costs most of C's complexity
without its main benefit.

---

## 1a. Egress — how it actually works

**Verified empirically on this VM, not inferred from the types.**

The SDK sandbox does not police outbound traffic with environment variables. On
Linux it runs the agent under `bwrap` with `--unshare-net`, so the process has
**no route to the internet at all**, then uses `socat` to bridge a Unix socket
inside the namespace to a host-side HTTP/SOCKS proxy that enforces
`sandbox.allowedDomains`.

That design is why it holds up: there is no network to bypass the proxy *to*.
Connecting to a raw IP does not evade the allowlist, because no route exists.
Nor does `unset HTTPS_PROXY` — that does not uncover a second way out, it just
breaks the only one.

**Which proxy sits on the far end of that bridge is configurable.** The SDK's
`SandboxNetworkConfig` takes an `httpProxyPort`, documented as "port of an
external HTTP proxy to use instead of starting a local one… the external proxy
must handle domain filtering". Setting it makes the SDK skip its own proxy and
bridge to yours. That is the whole Squid integration — see § 1c.

### The failure mode that bit us

`socat` is **not installed on this VM**, and the SDK does not raise when its
sandbox dependencies are missing — it silently declines to sandbox. Because
`autoAllowBashIfSandboxed` only auto-allows bash *when the sandbox genuinely
applied*, every bash call then blocks on a permission prompt with nothing there
to answer it. Confirmed by running an agent turn: the tool call came back
`blocked pending approval` and never executed.

In Discord that presents as a bot that reacts 👀 to your mention and then never
speaks — a very long way from its actual cause.

Both configured paths were therefore broken:

| Config | Behaviour on this VM |
|---|---|
| `sandbox.enabled: true` | Sandbox silently inactive, bash blocked, **agent cannot reply at all** |
| `sandbox.enabled: false` + `bypassPermissions` | Bash runs, **egress completely uncontrolled** — verified reaching a non-allowlisted host, HTTP 200 |

### Fix

```sh
sudo apt-get install -y socat
```

`src/preflight.ts` now refuses to start when `sandbox.enabled` is true and
either binary is missing, so this cannot recur silently.

### Remaining caveat once socat is installed

This SDK build ships no `vendor/seccomp/{x64,arm64}/apply-seccomp` binary, so
seccomp filtering is unavailable and the sandbox runs in `allowAllUnixSockets`
mode. Its own warning describes this as "less restrictive but still provides
filesystem and network isolation" — domain egress control is intact; what is
lost is blocking of arbitrary Unix-socket connections. Worth knowing if you
later expose something like a Docker socket on this host.

### What is *not* covered

Egress control applies to the **agent** only. The waker process itself has
unrestricted network access, and there is no host firewall or gVisor layer
beneath either. Under Option A the SDK sandbox is the entire boundary.

More precisely, it applies to the agent's **bash commands**. The sandbox is a
command wrapper — the SDK wraps each Bash invocation in `bwrap`. Claude Code's
own process is not wrapped, so `WebFetch` and `WebSearch`, which run in that
parent process, do not pass through the allowlist or through Squid. The SDK's
own type docs say as much: network access for those is governed by `WebFetch`
permission rules, not by sandbox settings. If you need them constrained, that
is a permissions job, not an egress one.

---

## 1c. Egress — choosing the proxy

`sandbox.egress.mode` in `agent-config.yaml` selects which proxy enforces
`allowedDomains`. Both modes are equally *enforcing*, because in both the
enforcement comes from `--unshare-net` rather than from the proxy. What differs
is operability.

| | `sdk` (default) | `squid` |
|---|---|---|
| Setup | None | `apt-get install squid`, one config file |
| Allowlist lives in | `agent-config.yaml` only | Both files, pinned equal at startup |
| Access log | None | `/var/log/squid/access.log`, per request |
| Blocks pivot to localhost / RFC1918 / cloud metadata | No | Yes |
| Blocks CONNECT to non-443 ports | No | Yes |
| Extra moving part that can fail | No | Yes — a dead Squid means zero egress |

**Choose `sdk` when** you want the fewest moving parts, or you are still getting
the bot working at all. It is the default for that reason.

**Choose `squid` when** you want an audit trail of what the agent actually
reached, or an allowlist reviewable and changeable without touching the bot's
config, or the SSRF guards. The instance-metadata block is the strongest single
argument: `169.254.169.254` is usually the most valuable thing an
egress-restricted process can still reach, and `sdk` mode does not block it.

Install and verification: **`squid/README.md`**.

### The one configuration that is refused

`egress.mode: squid` with `sandbox.enabled: false` fails at startup rather than
running. Without the namespace there is no bridge, `HTTP_PROXY` reverts to being
advisory, and the agent can step around it with `unset HTTPS_PROXY` or
`curl --noproxy '*'`. That setup reads as egress control in the config file and
in `!status` while providing none — worse than no proxy at all, because it is
believed. Startup names the contradiction and exits.

### HTTPS is filtered without decryption

The agent's traffic is essentially all TLS, which arrives as `CONNECT
host:443`. Squid matches the allowlist against that hostname and then splices
bytes; it never decrypts, and there is no CA key on this box.

The tradeoff: a client that CONNECTs to an allowlisted host and then sends a
different SNI inside the tunnel is not detected. Catching that needs `ssl_bump
peek` with an `ssl::server_name` ACL — which still requires no CA if you only
splice, but does require a Squid built against OpenSSL. Ubuntu's stock `squid`
is built `--with-gnutls` (verified on this VM), so it would mean switching to
the `squid-openssl` package. Not worth it for the current threat model.

### Startup guards

`src/preflight.ts` refuses to boot on each of these, because every one of them
presents in Discord as a bot that reacts 👀 and then never speaks:

- `bwrap` or `socat` missing while the sandbox is on.
- Squid not listening on `egress.httpProxyPort`. The sandbox leaves no route
  but the bridge, so a dead proxy is **total** egress loss — including
  `discord.com`. Verified: with Squid stopped, even an allowlisted domain fails.
- `squid.conf` and `sandbox.allowedDomains` listing different domains. The two
  are enforced by different proxies — Squid on HTTP/HTTPS, the SDK's own on the
  SOCKS path, which stays active because Squid speaks no SOCKS — so drift is a
  real gap in whichever direction it runs.

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

## 3. Post-reboot install (needs sudo)

The VM has no passwordless sudo, so these are yours to run. Nothing here is
needed for Option A, except `socat` — which the sandbox does need:

```sh
sudo apt-get install -y socat
```

### Squid (only for `egress.mode: squid`)

Full runbook, with each command explained, in **`squid/README.md`**. In short:

```sh
sudo apt-get install -y squid socat
sudo cp -n /etc/squid/squid.conf /etc/squid/squid.conf.dpkg-orig
sudo install -m 0644 /home/npurcell/clawcius/squid/squid.conf /etc/squid/squid.conf
sudo squid -k parse            # validate before restarting — a dead squid = no egress
sudo systemctl enable --now squid
```

### Docker + gVisor (Options B and C only)

```sh
# Docker
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io

# gVisor
(
  set -e
  cd "$(mktemp -d)"
  ARCH=$(uname -m)
  URL=https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}
  curl -fsSLO ${URL}/runsc ${URL}/runsc.sha512 \
             ${URL}/containerd-shim-runsc-v1 ${URL}/containerd-shim-runsc-v1.sha512
  sha512sum -c runsc.sha512 -c containerd-shim-runsc-v1.sha512
  sudo install -o root -g root -m 0755 runsc containerd-shim-runsc-v1 /usr/local/bin/
)

# Register runsc as a Docker runtime and restart the daemon
sudo /usr/local/bin/runsc install
sudo systemctl restart docker

# Verify
docker run --rm --runtime=runsc alpine uname -a
```

Add your user to the `docker` group if you go with Option C:

```sh
sudo usermod -aG docker npurcell
```

### gVisor platform choice

This VM has nested virt (`/dev/kvm` present, AMD-V exposed), so both platforms
are available:

- `systrap` — runsc's default, no KVM dependency
- `kvm` — often faster for syscall-heavy work, which Claude Code is

Benchmark both against a real agent run before committing:

```sh
sudo runsc install -- --platform=kvm    # then restart docker and compare
```

Keep `sessions.workspaceRoot` on the local VM disk. gVisor's file I/O overhead
stacked on an NFS/SMB mount back to the pool will make every `grep` and `read`
visibly slow.

---

## 3. Install the service

```sh
sudo cp systemd/clawcius.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clawcius
journalctl -u clawcius -f
```

`Type=notify` means `systemctl start` blocks until the Discord gateway is
actually connected — a failed login shows up as a failed start, not a
"running" unit that does nothing.

---

## 3b. How the agent reaches the `discord` CLI

`dcli` is pure stdlib — no typer, no httpx, no venv. The `discord-cli/discord`
shim runs straight from the checkout, so **there is no install step**. The agent
invokes it by absolute path (`paths.discordCli`, defaulting to the checkout).

Three pieces have to line up, and all three are wired already:

**1. Environment.** The waker passes `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, and
`DISCORD_CLI_HOME` (`<workspace>/.discord-cli`) into the agent. Your `config.py`
precedence — env first, then file — means no config file is needed.

**2. Skill discovery.** The agent's `cwd` is its per-channel workspace, not this
repo, and the SDK defaults to isolation mode where *no* filesystem settings load
at all. So two things are set: `settingSources: ['project']` in `agent.ts`, and
a `.claude` symlink created in each workspace pointing at this repo's. Without
both, the agent never sees `discord-cli/SKILL.md` and has no idea how to speak.

**3. Egress.** `discord.com` is in `sandbox.allowedDomains`.
Removing it leaves an agent that runs fine and can never say anything.

Verify the whole chain:

```sh
sudo -u npurcell /home/npurcell/clawcius/discord-cli/discord whoami
```

Under Option B or C, the CLI and the skill both need to exist in the container
image, and `paths.discordCli` / `paths.skillsDir` point at their paths there.

---

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

## 5. Memory budget (4 GB VM)

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

Add **~97 MB** for Squid under `egress.mode: squid` (measured on this box with
caching off — see `squid/README.md`). It comes out of the OS slice above, not
the agents'.

`sessions.maxConcurrent: 3` in `agent-config.yaml` is sized for this, with
`MemoryMax=2800M` in the unit as a backstop. Add ~50–100 MB per agent for gVisor under Option C.
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

The Agent SDK ships no `ScheduleWakeup`/`CronCreate` equivalent — those are
harness capabilities, not model capabilities. `src/scheduler.ts` plus
`src/tools.ts` supply that piece as in-process MCP tools:

| Tool | Purpose |
|---|---|
| `schedule_wake` | One-shot wake after a delay |
| `schedule_repeating` | Recurring, by `interval_seconds` or `daily_at` (HH:MM) |
| `list_schedules` | Pending wakes for this channel |
| `cancel_schedule` | Cancel by id |

Built this way rather than as cron for three reasons: it sidesteps the setgid
`crontab` + `NoNewPrivileges` + sandbox-namespace problem entirely; it wakes the
**existing warm session** instead of spawning a cold headless agent; and the
limits live in the same process that already enforces concurrency.

Firing is a 15-second poll over SQLite rather than one `setTimeout` per
schedule — timers do not survive a restart, and delays beyond ~24.8 days
overflow `setTimeout`'s 32-bit millisecond argument and fire immediately.

The MCP server is constructed **per channel**, closing over the channel id, so
the agent cannot schedule a wake into a channel it is not currently serving.

### Limits, and why they matter here

With `maxTurns: 0`, no budget cap, sessions that never die, and 24/7 uptime, a
self-scheduling agent is the exact shape that runs up an unattended bill. Three
guards, all in `agent-config.yaml`:

| Key | Default | Guards against |
|---|---|---|
| `minDelaySeconds` | 60 | Tight self-wake loops |
| `maxPending` | 20 | Unbounded schedule accumulation |
| `maxWakesPerDay` | 48 | Sustained burn — re-checked at fire time, not only at creation, so yesterday's schedule cannot outrun today's budget |

A rejected call returns the reason to the agent, and the system prompt tells it
not to route around the limit by chaining short wakes or switching channels.

### A scheduled wake has no message to reply to

`discord reply` needs a message id, and a scheduled wake has none. The wake
message says so explicitly and directs the agent to `discord send -c <channel>`.
`WakeContext` is a discriminated union (`kind: 'mention' | 'schedule'`) so this
cannot be got wrong silently.

Commands are handled by the waker, not the agent — mention the bot, then:

| Command                 | Effect                                       |
|-------------------------|----------------------------------------------|
| `@bot !stop`            | Interrupt the current turn                   |
| `@bot !reset`           | Drop the session; next mention starts fresh  |
| `@bot !status`          | Sessions, model, turn cap, eviction, sandbox |
| `@bot !schedules`       | Pending self-scheduled wakes in this channel |
| `@bot !unschedule <id>` | Cancel one                                   |

Reactions give immediate feedback before the agent has produced anything:
👀 woken, 🚫 channel not in `discord.allowedChannelIds`.

---

## Known gaps

- **Never run end-to-end.** Agent turns have been exercised directly — the
  egress tests above, and a live agent successfully calling `schedule_wake` and
  `list_schedules` with the row verified in SQLite — but no Discord mention has
  ever reached one. First mention is the real test.
- **`daily_at` uses the server's local timezone.** Set `Environment=TZ=...` in
  the unit file to change it; there is no per-schedule timezone.
- **`socat` must be installed** before the bot will start with the sandbox on.
  See § Egress.
- **Squid mode is unverified against the installed package.** The config, the
  allowlist behaviour, the SSRF guards, the socat bridge chain, and a real agent
  turn were all verified against Squid 7.2 unpacked into a scratch directory and
  run as an unprivileged user, because there is no sudo here. What that does not
  cover is the packaged install path: AppArmor, the `proxy` user's ownership of
  `/var/log/squid`, and the systemd unit. Run `squid/README.md` § Verifying it
  works after installing.
- **`WebFetch` / `WebSearch` bypass the allowlist entirely** — they run in the
  parent process rather than in sandboxed bash. See § 1a.
- **`pyproject.toml` declares stale deps** — `typer` and `httpx` are listed but
  nothing imports them since the move to argparse + urllib. Harmless for the
  shim; wrong for anyone who `pip install`s the package.
- **Send-detection is a regex** (`(^|[\s/])discord\s+(reply|send)\b` in
  `src/agent.ts`) driving the no-reply fallback. Verified against absolute-path,
  bare, and piped invocations. If the CLI gains an alias or the agent wraps the
  call in a script, the pattern needs updating — otherwise the fallback fires on
  a turn that did in fact reply.
- **Threads are unsupported by the CLI.** A mention inside a thread passes the
  thread ID as `channel_id`, which Discord's REST API may accept, but it is
  untested — treat thread replies as unverified.
- **Warm sandbox pool** — the biggest remaining latency win. Only relevant
  under Option C.
- **Option C spawn hook** — `spawnClaudeCodeProcess` is unimplemented.
- **No effort control.** `Options` has no `effort` field and the bundled Claude
  Code CLI exposes no `--effort` flag, so there is nothing to wire it to. The
  knob was removed rather than left as dead config. Revisit if a future SDK
  release adds it.
- **Prompt caching is not verified.** Long-lived sessions should be getting
  cache reads; check `usage` on the result messages before assuming.
