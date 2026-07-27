# Squid egress control for Clawcius

An access-control proxy for the agent's outbound traffic. Default-deny, and
`squid/squid.conf` is the **only** copy of the allowlist — nothing in
`agent-config.yaml` mirrors it any more.

It runs as its own container (`clawcius-squid`) straddling two Docker
networks: `clawcius-internal`, which the agent is on and which has no gateway
out, and `clawcius-egress`, which does. See SETUP.md § 1a.

---

## Why this is enforcement and not a suggestion

Setting `HTTPS_PROXY` on a process is advisory. Any program that ignores the
variable — or a shell that runs `unset HTTPS_PROXY`, or `curl --noproxy '*'` —
goes straight around it. On its own, that is not egress control.

What makes it enforcement here is the network topology underneath it:

```
        clawcius-internal (--internal: no gateway, no route out)
        ┌────────────────────────────────┐
        │  clawcius-agent                │
        │  gVisor; no default route      │
        │  HTTPS_PROXY=172.31.250.2:3128 ┼──┐
        └────────────────────────────────┘  │
                                            ▼
                             clawcius-squid  172.31.250.2:3128
                                            │  allowlist
                                            ▼
        clawcius-egress (ordinary bridge) ──────────────> internet
```

`clawcius-internal` is a `--internal` Docker network: it has no gateway, so
the agent container has no default route to anything but the other containers
on it. Unsetting `HTTP_PROXY`/`HTTPS_PROXY` does not reveal a second path out;
it just breaks the only one. Passing `--noproxy '*'` and dialling raw IPs fail
the same way. That topology, not any setting, is what makes this enforcement.

Squid listens on `172.31.250.2:3128` — a fixed address on the internal
network, pinned so the agent's proxy variables cannot drift out from under it.

---

## Install

Nothing to install. Squid runs as a container built from
`docker/Dockerfile.squid`, and `docker/up.sh` builds it, wires both networks
and starts it:

```sh
docker/up.sh
```

The config is baked into the image at build time from `squid/squid.conf`, so
there is no `/etc/squid/squid.conf` on the host to keep in step and no
`squid -k reconfigure` to run — changing the allowlist means rebuilding, which
`up.sh` does for you.

Check it came up and is enforcing:

```sh
docker ps --filter name=clawcius-squid
docker logs clawcius-squid | tail -20
```

---

## Turn it on in Clawcius

Nothing to turn on. There is no setting that selects Squid — the agent is on a
network whose only route out is the proxy, so it is either reachable or the
agent has no egress at all. `src/preflight.ts` refuses to start the bot when
the proxy container is down, because that state reads in Discord as a bot that
wakes and never speaks.

After an allowlist change:

```sh
cd /home/npurcell/clawcius && npm run build
sudo systemctl restart clawcius
journalctl -u clawcius -n 30
```

Startup fails loudly, naming the problem, if Squid is not listening, if the
config file is missing, or if the two allowlists disagree.

---

## Changing the allowlist

The allowlist exists in exactly one place: the block between the
`clawcius-allowlist-begin` / `-end` markers in `squid/squid.conf`, one
`acl clawcius_allowed dstdomain <host>` line per entry.

`docker/squid.conf` is a gitignored copy taken at build time and baked into
the image, so an edit is inert until the image is rebuilt. `docker/up.sh` does
the copy and the rebuild itself, so the whole workflow is:

```sh
$EDITOR squid/squid.conf
docker/up.sh                 # re-copies, rebuilds, restarts both containers
sudo systemctl restart clawcius
```

`src/preflight.ts` warns at startup if the source and the build copy have
drifted anyway.

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
**not** controlled. Stop and check that the agent container is actually on
`clawcius-internal`:

```sh
docker inspect -f '{{json .NetworkSettings.Networks}}' clawcius-agent | jq keys
```

It must list `clawcius-internal` and nothing else. A second network is a
second route, and the allowlist stops meaning anything.

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
- Reaching the proxy from off-box — it is published on no host port, only on
  the two Docker networks.

**Not prevented:**

- **The waker's own traffic.** The bot process (`src/`) is not sandboxed and
  talks to Discord's gateway directly. Squid governs the agent only.
- **Nothing about the agent is exempt.** This used to carve out `WebFetch` and
  `WebSearch`, which ran in the parent process outside the per-bash sandbox.
  The whole Claude Code process now runs inside the container, so every tool it
  has goes through the same network and the same proxy.
- **Domain fronting.** Filtering is on the CONNECT target hostname and there is
  no TLS interception, so a client that CONNECTs to an allowlisted host and then
  presents a different SNI inside the tunnel is not caught. Closing this needs
  `ssl_bump peek` with an `ssl::server_name` ACL — which needs no CA if you only
  splice, but does need a Squid built against OpenSSL. Ubuntu's stock `squid`
  package is built `--with-gnutls` (verified on this box), so it is not
  available without switching to the `squid-openssl` package.
- **Content.** An allowlisted host is allowed entirely. `github.com` means all
  of GitHub, including pushing whatever the agent likes to a repo.
- **What is mounted in.** The proxy governs the network, not the filesystem.
  The OAuth credentials and the workspace are bind-mounted into the container
  and Squid has no view of them; never bind-mount a Docker socket.

---

## Troubleshooting

**Bot will not start, "the egress proxy is exited/missing".**
Squid is down, so the agent would have zero egress. `docker logs
clawcius-squid` — almost always a config error, which a dead container shows
as a `FATAL` line at the end of the log. Fix `squid/squid.conf` and rerun
`docker/up.sh`.

**A site fails and you think it is allowlisted.**
`docker logs clawcius-squid | grep TCP_DENIED` names the exact host that was
refused. This is usually a CDN hostname rather than the site itself — the page
loads and the media fetch is denied.

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
