# Squid egress control for Clawcius

An access-control proxy for the agent's outbound traffic. Default-deny, with an
allowlist that must match `sandbox.allowedDomains` in `agent-config.yaml`.

This is an **alternative** to the SDK's own built-in proxy, not a replacement
for the sandbox. Set `sandbox.egress.mode` in `agent-config.yaml` to choose.
See SETUP.md § 1a for when to pick which.

---

## Why this is enforcement and not a suggestion

Setting `HTTPS_PROXY` on a process is advisory. Any program that ignores the
variable — or a shell that runs `unset HTTPS_PROXY`, or `curl --noproxy '*'` —
goes straight around it. On its own, that is not egress control.

What makes it enforcement here is the SDK sandbox underneath it:

```
                  bwrap --unshare-net
        ┌──────────────────────────────────────┐
        │  agent's network namespace           │
        │  NO route to the internet at all     │
        │                                      │
        │  HTTPS_PROXY=http://localhost:3128 ──┼──> socat TCP-LISTEN:3128
        └──────────────────────────────────────┘         │
                                                         │  (unix socket,
                                                         │   bind-mounted in)
                                                         ▼
             host:  socat UNIX-LISTEN:/tmp/claude-http-*.sock
                                                         │
                                                         ▼
                              Squid  127.0.0.1:3128   ── allowlist ──> internet
```

The agent's namespace has no default route and no DNS. Unsetting the proxy
variables does not reveal a second path out; it just breaks the only one. That
is the property being relied on, and it is why `sandbox.enabled: false` with
`egress.mode: squid` is **refused at startup** — that combination genuinely is
advisory-only, and it would look like protection while providing none.

### Two port 3128s

They are different sockets and it matters when debugging:

| Where | What | Set by |
|---|---|---|
| Inside the agent's namespace | `socat TCP-LISTEN:3128` | Hardcoded by the SDK |
| On the host | Squid's `http_port 127.0.0.1:3128` | `squid.conf` + `egress.httpProxyPort` |

Only the host one is configurable. If you move Squid to another port, change
`sandbox.egress.httpProxyPort` to match — the in-namespace 3128 stays as it is.

---

## Install

Everything below needs root. There is no passwordless sudo on this box, so run
these yourself.

```sh
# 1. Squid, plus socat — which the SDK sandbox needs for the bridge above and
#    which is NOT installed on this VM. Without socat the sandbox silently does
#    not apply and the agent cannot run bash at all. (See SETUP.md § Egress.)
sudo apt-get update
sudo apt-get install -y squid socat

# 2. Keep the distro's config around. Ours is standalone and replaces it
#    wholesale, so this is the only copy you get of the original.
sudo cp -n /etc/squid/squid.conf /etc/squid/squid.conf.dpkg-orig

# 3. Install the Clawcius config.
#    Standard paths are used throughout (/var/log/squid, /var/spool/squid,
#    /run/squid.pid) specifically so Ubuntu's AppArmor profile for squid keeps
#    working. Moving the logs elsewhere means editing that profile too.
sudo install -m 0644 -o root -g root \
  /home/npurcell/clawcius/squid/squid.conf /etc/squid/squid.conf

# 4. Check it parses BEFORE restarting. A bad config leaves squid dead, and a
#    dead squid means the agent has zero egress — it cannot even reach Discord.
sudo squid -k parse

# 5. Start it, and have it come back after reboot.
sudo systemctl enable --now squid

# 6. Confirm it is listening on loopback only. Expect exactly one line, bound
#    to 127.0.0.1 — if it says 0.0.0.0 you have published an open relay.
sudo ss -ltnp | grep 3128
```

### Cap Squid's memory (recommended on this VM)

**Measured on this box: ~97 MB RSS**, idle and under light load, with caching
off. That is not free on 1.6 GB — budget for it alongside the ~400 MB per agent
in SETUP.md § 5. Most of it is Squid's fixed footprint rather than anything
`cache_mem` controls, so tuning the config further will not move it much.

A ceiling stops it growing into the agents' headroom:

```sh
sudo systemctl edit squid
```

Add, save, then `sudo systemctl restart squid`:

```ini
[Service]
MemoryMax=192M
```

192M leaves roughly 2x measured headroom. Do not set it near 97M — Squid would
be OOM-killed under load, and a dead Squid means the agent has no egress at all.

### Start Squid before the bot

`preflight` refuses to boot the bot when Squid is not listening, so at reboot
the bot would crash-loop until Squid happened to come up. Ordering removes the
race:

```sh
sudo systemctl edit clawcius
```

```ini
[Unit]
Wants=squid.service
After=squid.service
```

---

## Turn it on in Clawcius

Squid does nothing for the agent until the bot is told to use it. In
`agent-config.yaml`:

```yaml
sandbox:
  enabled: true          # required — see "Why this is enforcement" above
  egress:
    mode: squid
    httpProxyPort: 3128
```

Then rebuild and restart:

```sh
cd /home/npurcell/clawcius && npm run build
sudo systemctl restart clawcius
journalctl -u clawcius -n 30
```

Startup fails loudly, naming the problem, if Squid is not listening, if the
config file is missing, or if the two allowlists disagree.

---

## Changing the allowlist

The allowlist exists in **two files** and they must stay identical. The bot
refuses to start if they drift, so you cannot get this half-done silently — but
you do have to edit both.

1. `agent-config.yaml` → `sandbox.allowedDomains`
2. `/etc/squid/squid.conf` → the block between the
   `clawcius-allowlist-begin` / `-end` markers, one `acl clawcius_allowed
   dstdomain <host>` line per entry.

Then:

```sh
sudo squid -k parse        # validate first; never reconfigure into a syntax error
sudo squid -k reconfigure  # apply without dropping established tunnels
sudo systemctl restart clawcius
```

Keep the repo copy (`squid/squid.conf`) in step as well — that is the file
`sandbox.egress.confPath` points at and the one preflight actually reads. If
you edit only `/etc/squid/squid.conf`, preflight will compare against a stale
file and can pass while the live proxy differs.

**Matching rules.** An entry with no leading dot is an exact host match, so
`github.com` does not cover `raw.githubusercontent.com`. For a whole subtree
write `.example.com`, which also matches `example.com` itself. Prefer exact
hosts; a wildcard is a much larger surface than it looks.

---

## Logs

| File | Contents |
|---|---|
| `/var/log/squid/access.log` | One line per request — this is where denials appear |
| `/var/log/squid/cache.log` | Startup, config errors, DNS failures |

```sh
sudo tail -f /var/log/squid/access.log
```

### Reading a denial

```
1784962949.444  40 127.0.0.1 TCP_DENIED/403 1510 CONNECT example.com:443 - HIER_NONE/- text/html
                               ^^^^^^^^^^^^^^          ^^^^^^^^^^^^^^^^^      ^^^^^^^^^
                               blocked, 403            what was wanted        never contacted
```

- `TCP_DENIED/403` — an ACL refused it. `HIER_NONE` confirms Squid never opened
  an upstream connection, so nothing left the box.
- `CONNECT example.com:443` — the requested host. For HTTPS the target always
  appears as `CONNECT host:port`; there is no path, because Squid never decrypts.

An allowed request looks like this instead:

```
1784962948.422 154 127.0.0.1 TCP_TUNNEL/200 6782 CONNECT api.github.com:443 - HIER_DIRECT/140.82.116.6 -
```

`TCP_TUNNEL/200` plus `HIER_DIRECT/<ip>` means the tunnel was established to
that address.

Only-the-denials, live:

```sh
sudo tail -f /var/log/squid/access.log | grep --line-buffered TCP_DENIED
```

### Benign warnings

Two appear at every startup on this host and neither is a fault:

- `WARNING: HTTP requires the use of Via` — that is `via off` in the config,
  chosen so the proxy does not announce itself upstream.
- `WARNING: BCP 177 violation. Detected non-functional IPv6 loopback` and
  `aclIpParseIpData: IPv6 has not been enabled. acl name: clawcius_private_dst`
  — loopback IPv6 is disabled here, so Squid disables IPv6 entirely and the
  `fc00::/7` / `fe80::/10` entries in the pivot guard are inert. They are kept
  so the guard is still complete if IPv6 is ever enabled.

---

## Verifying it works

Run these **after** installing Squid. Steps 1–2 need no bot; step 3 is the one
that actually proves the agent is contained.

### 1. Squid alone

```sh
# Allowed — expect 200
curl -sS -x http://127.0.0.1:3128 -o /dev/null -w '%{http_code}\n' https://api.github.com/

# Denied — expect: curl: (7) CONNECT tunnel failed, response 403
curl -sS -x http://127.0.0.1:3128 -o /dev/null -w '%{http_code}\n' https://example.com/

# Pivot guards — all expect 403
curl -sS -x http://127.0.0.1:3128 -o /dev/null -w '%{http_code}\n' http://169.254.169.254/
curl -sS -x http://127.0.0.1:3128 -o /dev/null -w '%{http_code}\n' http://192.168.1.1/

# Tunnel to a non-443 port on an allowed host — expect 403
curl -sS -x http://127.0.0.1:3128 -o /dev/null -w '%{http_code}\n' https://github.com:22/
```

### 2. The bot's own checks

```sh
cd /home/npurcell/clawcius && npm run build && sudo systemctl restart clawcius
journalctl -u clawcius -n 30 --no-pager
```

Then, in Discord, `@bot !status` should report:

```
Egress: Squid allowlist (127.0.0.1:3128), 8 domains
```

### 3. A real agent turn — the one that counts

Steps 1 and 2 prove Squid is correct and configured. Neither proves the *agent*
cannot go around it. For that, ask the agent to try, in Discord:

```
@bot run these two commands and tell me the exact output of each:
curl -sS -o /dev/null -w "A=%{http_code}" --max-time 20 https://api.github.com/
curl -sS -o /dev/null -w "B=%{http_code}" --max-time 20 https://example.com/
```

Expected: `A=200`, and B failing with `CONNECT tunnel failed, response 403`.

Then confirm the traffic was really Squid's rather than a direct connection:

```sh
sudo tail -5 /var/log/squid/access.log
```

Both requests must appear — the allowed one as `TCP_TUNNEL/200`, the blocked
one as `TCP_DENIED/403`. If the agent reported success for `example.com`, or if
neither line is in the log, the traffic did not go through Squid and egress is
**not** controlled. Stop and check that `sandbox.enabled` is `true`.

---

## What this does and does not prevent

**Prevented:**

- The agent's bash commands reaching any host not on the allowlist.
- Reaching an allowed host on a port other than 443 (or 80 in cleartext).
- Using the proxy to pivot to `127.0.0.0/8`, RFC1918, or `169.254.169.254`
  (cloud instance metadata) — enforced on the *resolved* address, so an
  allowlisted name that resolves into private space is blocked too.
- Connecting to a raw IP to dodge the name check: there is no matching
  `dstdomain`, so it is denied.
- Reaching the proxy from anywhere but this host — it binds loopback only.

**Not prevented:**

- **The waker's own traffic.** The bot process (`src/`) is not sandboxed and
  talks to Discord's gateway directly. Squid governs the agent only.
- **`WebFetch` / `WebSearch`.** Those run in the parent Claude Code process, not
  in sandboxed bash, so they never touch Squid. They are governed by permission
  rules instead — the SDK's own docs say so. Only Bash egress is proxied.
- **Domain fronting.** Filtering is on the CONNECT target hostname and there is
  no TLS interception, so a client that CONNECTs to an allowlisted host and then
  presents a different SNI inside the tunnel is not caught. Closing this needs
  `ssl_bump peek` with an `ssl::server_name` ACL — which needs no CA if you only
  splice, but does need a Squid built against OpenSSL. Ubuntu's stock `squid`
  package is built `--with-gnutls` (verified on this box), so it is not
  available without switching to the `squid-openssl` package.
- **Content.** An allowlisted host is allowed entirely. `github.com` means all
  of GitHub, including pushing whatever the agent likes to a repo.
- **Unix sockets.** This SDK build ships no seccomp helper, so the sandbox runs
  in `allowAllUnixSockets` mode. Nothing here changes that; keep privileged
  sockets such as a Docker socket off this host.

---

## Troubleshooting

**Bot will not start, "nothing is listening on 127.0.0.1:3128".**
Squid is down. `systemctl status squid`, then `sudo tail -30
/var/log/squid/cache.log`. Almost always a config error caught by
`sudo squid -k parse`.

**Bot will not start, "the egress allowlists disagree".**
The message names the exact domains and which file each is missing from. Fix
both files, `sudo squid -k reconfigure`, restart the bot.

**Squid will not start: `FATAL: http_port: IPv6 is not available`.**
This host has `net.ipv6.conf.lo.disable_ipv6 = 1`, so binding `[::1]` is fatal.
The shipped config keeps that line commented for exactly this reason — do not
uncomment it unless `sysctl net.ipv6.conf.lo.disable_ipv6` returns `0`.

**Agent turns hang, then fail.**
An allowlisted host that will not resolve. `connect_timeout` is 15s to keep this
from stalling a turn for two minutes. Check `cache.log` for DNS errors.

**Everything is denied, including `discord.com`.**
The agent reacts 👀 and never speaks. Check `access.log` — if requests are
arriving and being denied, the allowlist block is wrong; if nothing arrives at
all, the bridge is not reaching Squid and the port is the thing to check.
