# Clawcius — setup

## 1. What runs where

| Unit | Runs as | From | Does |
|---|---|---|---|
| `clawcius-netguard` | root | `/usr/local/lib/clawcius/netguard.sh` | iptables: the sandbox cannot reach the host or other containers |
| `clawcius-container` | npurcell + docker | `/srv/clawcius/current/docker/up.sh` | networks, Squid, the `clawcius-agent` gVisor container |
| `clawcius` | npurcell | `/srv/clawcius/current` | the Clawcius waker; `docker exec`s into the container per turn |
| `hamachi` | hamachi | `/srv/clawcius/current` | the Hamachi waker; agents run on the host as `hamachi` |
| `clawcius-status` | npurcell | `/srv/clawcius/current/status` | Clawsky, loopback only; `tailscale serve` fronts it |
| `clawcius-snapshot.timer` | npurcell + docker | `docker/snapshot.sh` | nightly `docker commit` of the sandbox, eight kept |
| `deploy@clawcius.timer`, `deploy@oj.timer` | root | `/usr/local/sbin/deploy` | every minute: is `origin/main` a sha the timer has not deployed? deploy |
| `deploy@*.path` | root | same | a crew wrote `/var/lib/hamachi/run/deploy-<repo>` naming a ref |

State: `/var/lib/clawcius` and `/var/lib/hamachi` (SQLite board, workspaces,
`agent-home` with the Claude login, `waker-status.json`). Secrets:
`/etc/clawcius/{clawcius,hamachi}.env`, the GitHub App PEMs, the Google
service-account key. Code: `/srv/clawcius/{src,releases/<sha>,current}` and the
same under `/srv/oj`, owned by `hamachi`; nobody edits them.

## 2. A fresh box

**On a box that already runs the stack, skip to the repo's own setup below** — the
commands here replace Ubuntu's `docker.io` with Docker's packages, which stops every
container and needs `systemctl enable --now docker.socket` afterwards.

Ubuntu, root. Docker and gVisor first:

```sh
sudo apt-get update && sudo apt-get install -y ca-certificates curl gnupg git python3 sqlite3
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io
( set -e; cd "$(mktemp -d)"; URL=https://storage.googleapis.com/gvisor/releases/release/latest/$(uname -m)
  curl -fsSL --remote-name-all ${URL}/runsc ${URL}/runsc.sha512 ${URL}/containerd-shim-runsc-v1 ${URL}/containerd-shim-runsc-v1.sha512
  sha512sum -c runsc.sha512 containerd-shim-runsc-v1.sha512
  sudo install -o root -g root -m 0755 runsc containerd-shim-runsc-v1 /usr/local/bin/ )
sudo /usr/local/bin/runsc install && sudo systemctl restart docker
sudo usermod -aG docker npurcell        # docker group is root on the host
```

Node 22 from the NodeSource apt repository, at `/usr/bin/node`; `setup.sh` installs it when it is missing.

Then the repo's own setup, which creates the `hamachi` account, `/srv`, `/etc/clawcius`, the deploy units and timers:

```sh
git clone https://github.com/NickPurcell/Clawcius.git /tmp/clawcius && sudo /tmp/clawcius/deploy/setup.sh
```

## 3. Secrets

`/etc/clawcius/clawcius.env` and `hamachi.env`, one per crew, each `0640` and group-owned by the user
that crew's units run as (`npurcell` for Clawcius, `hamachi` for Hamachi); the crew's App PEM the same.
The directory is `0755`: it lists names, the files keep their own mode.

```
DISCORD_TOKEN=            # the crew's bot token; the waker uses the gateway, the CLI uses REST
DISCORD_GUILD_ID=
CLAWCIUS_DB_PATH=/var/lib/<crew>/<crew>.db
GITHUB_APP_ID=            # optional: agents open PRs as the App instead of a PAT
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY_PATH=/etc/clawcius/<crew>-app.pem
# ANTHROPIC_API_KEY=      # unset: the crew uses its Claude Code login in /var/lib/<crew>/agent-home
```

Discord app: create it at discord.com/developers, enable **Message Content
Intent**, invite with scopes `bot` and permissions Send Messages, Read Message
History, Create Public Threads, Send Messages in Threads. Anyone in the server
can wake the agent; `discord.allowedChannelIds` in the crew's config names the
channels it answers in, and must name at least one.

Claude login: once per crew, as the service user, with `CLAUDE_CONFIG_DIR`
pointing at the crew's `agent-home` (`claude auth`); verify with
`claude -p 'say ok'`.

## 4. The image and first deploy

```sh
cd /srv/clawcius/src && cp node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude docker/claude   # after npm ci
docker build -t clawcius-agent:latest docker/
sudo deploy clawcius && sudo deploy oj
sudo systemctl enable --now clawcius-netguard clawcius-container clawcius clawcius-status hamachi clawcius-snapshot.timer
```

`deploy` fetches, builds `releases/<sha>`, flips `current`, installs the units,
restarts, waits up to 90 s for every unit to be active without restarts and
for each waker's `waker-status.json` to report the new commit, and reverts to
the previous release if not. A timer success DMs the crew it redeployed
(Hamachi for OJ); a failure, and every requested deploy, DMs Hamachi too. The
timers run every minute when `origin/main` moves; a crew requests a specific
ref with one write — `printf 'main\nwhy\n' > /var/lib/hamachi/run/deploy-<repo>`
— first line the ref, later lines a note that returns in the result mail.

## 5. Adding a crew

Copy `agent-config.yaml`: set `crew`, `displayName` and the channel ids, keep
`extends:`. Everything else derives from `crew` (container name, state dir,
status file, git identity). A crew in a sandbox needs `<crew>-container.service`
(copy `clawcius-container.service`, set `CLAWCIUS_CONTAINER`, `CLAWCIUS_STATE_DIR`,
`CLAWCIUS_ENV_FILE`) and a snapshot timer; a crew on the host needs only a waker
unit like `hamachi.service`. Both need a Discord application, an env file, a
Claude login in their `agent-home`, and a spool for mail from other crews'
coordinators: `/var/spool/clawcius/<crew>`, mode 1733, owned by the crew's user. Hamachi can do all of it but the Discord
application.

## 6. Memory

A Claude Code session is 400–700 MB RSS. The sandbox's `--memory` (2 GB
default) bounds Clawcius's agents; `hamachi.service`'s `MemoryMax` bounds
Hamachi's. Sessions are evicted after `sessions.idleTimeoutMinutes` (30) and
resume from SQLite on the next wake.

## 7. Operating

- **Deploy**: merge to `main`. **Roll back**: `sudo deploy clawcius <older-sha>`, which holds until `main` next moves.
- **Watch**: `journalctl -u clawcius -f`, `-u hamachi`, `-u deploy@clawcius`; Clawsky on the tailnet.
- **Wedged sandbox**: `docker/up.sh --recreate` (nightly snapshots: `docker images clawcius-agent`).
- **Disaster**: restore the VPS from the provider's backup.
- `!status`, `!stop`, `!reset` in a channel: what's running, interrupt the turn, drop the session.
- **Login page**: `https://vmi3493307.tail872bb7.ts.net/login` (Clawcius) and `/hamachi-login`
  (Hamachi), tailnet only. Loading it runs nothing — it reports the credential on disk. The button
  starts a login, the field takes the code it gives back, and it confirms with `claude auth status`
  and a real turn before it says the crew is back. `LOGIN_PAGE_PORT` and `LOGIN_PAGE_URL` in each
  crew's unit; publish with `tailscale serve --bg --set-path /login 8479`.
- **Dead Claude credential**: the daemon posts one message to the crew's first `allowedChannelIds`
  channel, then every four hours while it stays dead, naming the fault and both ways back in.
  It runs in the waker, so it does not need a working model. The page needs the tailnet; the
  commands need only Discord, which is the difference the message states. `@bot !auth` reports `claude auth status` and
  posts an authorize link; `@bot !auth <code>` feeds the code in and confirms. Anyone in the
  channel may use either, with any Claude account. The login runs inside the container for a crew
  that has one and on the host (`paths.claudeCli`) for a crew that does not.

## 8. Cutover from the previous layout (one-time)

Docker and gVisor are already on this box; skip § 2's install commands.

1. `chmod 600 ~/.env ~/.env.hamachi`; stop and disable `clawcius-ops`; stop `oj`.
2. `sudo deploy/setup.sh` from a clone of `main`. It creates the `hamachi` account, `/srv/{clawcius,oj}`,
   `/etc/clawcius` placeholders and the two spools, and installs the deploy units without enabling them.
3. Copy `~/.env` → `/etc/clawcius/clawcius.env`, `~/.env.hamachi` → `/etc/clawcius/hamachi.env`, the
   App PEMs into `/etc/clawcius/`; `chmod 0640`, Clawcius's files `chgrp npurcell`, Hamachi's `chgrp hamachi`.
4. `systemctl stop hamachi-container.service hamachi-snapshot.timer`; `chown -R hamachi:hamachi /var/lib/hamachi`.
5. `sudo deploy clawcius`. It refuses until 3 and 4 are done. It builds, installs the new units, restarts
   `clawcius-status`, `clawcius` and `hamachi`, and health-checks them; on the first run there is no
   previous release to revert to, so read `journalctl -u hamachi` if it reports a failure. Then `sudo deploy oj`
   (OJ's live `oj-config.yaml` must be the repo's).
6. `systemctl enable --now deploy@clawcius.timer deploy@oj.timer deploy@clawcius.path deploy@oj.path`.
7. Rebuild the image and `docker/up.sh --recreate` for Clawcius so the bots supervisor is the entrypoint;
   copy vidbot's `state.json` into `/var/lib/clawcius/workspaces/.bots/vidbot/` first.
8. `userdel clawcius-ops`, `groupdel clawcius-dev`, `rm /etc/sudoers.d/clawcius`, revoke the OJ deploy key,
   log out the `clawcius-ops` Claude seat, `chmod 750 /home/npurcell`; remove the old unit files for
   `clawcius-ops`, `clawcius-snapshot-verify`, `hamachi-container`, `hamachi-snapshot`.
9. Branch protection back on (CI + OJ) for both repos; start `oj`.
