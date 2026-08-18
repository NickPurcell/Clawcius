#!/usr/bin/env bash
# Start (or restart) the persistent Clawcius agent container.
#
# The container is long-lived on purpose: the agent lives here, so cron jobs,
# daemons and its own Discord bots keep running between turns. The waker
# attaches per session with `docker exec`; this container only has to outlive
# them.
#
# An existing container is REUSED, not recreated. That is the whole point of a
# persistent sandbox: packages the agent apt-installed, crontabs it wrote and
# daemons it started live in the writable layer, and `docker rm` throws all of
# it away. This script used to `rm -f` unconditionally, which meant every boot
# silently reset the agent to the base image.
#
# Recreating is still the right answer for a wedged container — it is just a
# deliberate act now:
#
#     docker/run-container.sh --recreate
#
# The cost of reuse is that changes to the flags below (mounts, memory, env)
# do not reach a container that already exists. Env changes are the common
# case, so a stale .env is detected and reported rather than left to confuse.
set -euo pipefail

RECREATE=0
for arg in "$@"; do
  case "$arg" in
    --recreate) RECREATE=1 ;;
    *) echo "usage: $(basename "$0") [--recreate]" >&2; exit 2 ;;
  esac
done

# Every instance-specific value is overridable, defaulting to the original
# deployment. That is deliberate: a second instance is config, not a forked
# copy of this script, and the defaults mean instance 1 behaves exactly as it
# did before any of this was parameterised.
#
# A second instance shares the image, the Squid proxy and the clawcius-internal
# network — the egress policy is a property of the proxy, not of who is using
# it, so there is no per-instance version of it. What it must NOT share is the
# container, the workspaces or the state directory; those are the sandbox.
NAME=${CLAWCIUS_CONTAINER:-clawcius-agent}
IMAGE=${CLAWCIUS_IMAGE:-clawcius-agent:latest}
ENV_FILE=${CLAWCIUS_ENV_FILE:-/home/npurcell/clawcius/.env}
MEMORY=${CLAWCIUS_CONTAINER_MEMORY:-2g}

# Paths are mirrored host->container deliberately. Claude Code derives its
# transcript directory from cwd, so a workspace mounted anywhere else would
# silently start a new session instead of resuming.
CLAWCIUS_STATE=${CLAWCIUS_STATE_DIR:-/var/lib/clawcius}
WORKSPACES=$CLAWCIUS_STATE/workspaces
# The container's only read-write window onto the host filesystem.
#
# It used to hold two spools: `run/wake`, where the agent dropped a file to ask
# to be woken, and `run/ops`, where it dropped one to ask the host to do
# something. Both were retired on 2026-08-16 — `remindMe` replaced the first
# and a DM to <crew>-host replaced the second — and neither directory is read
# or written by anything now. They are NOT deleted here: files on disk are not
# a deployment's business, and an in-place rollback to the previous `dist/`
# must not find them missing.
#
# The mount stays for now because taking it away is a change to what the agent
# can do rather than to what the daemons read, and removing a -v only takes
# effect on --recreate, which destroys the writable layer. What it costs while
# it stays: this is the container's only writable window onto the host, and
# nothing on either side of it is using it. See Clawcius #65.
STATE_RUN=$CLAWCIUS_STATE/run
SKILLS=/home/npurcell/clawcius/.claude
DISCORD_CLI=/home/npurcell/clawcius/discord-cli
GWS_CLI=/home/npurcell/clawcius/gws-cli
BROWSER_CLI=/home/npurcell/clawcius/browser-cli

# BROWSE_LOG is set on the container rather than left to browse's own default,
# and the reason is durability, not taste.
#
# That default is under $HOME, which is the container's writable layer, and
# --recreate destroys the writable layer. $WORKSPACES is a mounted volume, so
# this survives both restart and recreate.
#
# What the log is worth keeping for: a browser is the first tool here whose
# reach is second-order — a screenshot of one URL can contact thirty hosts, and
# none of them appear in anything the agent typed. Now that Squid is a
# blocklist rather than an allowlist, that record is the only account of where
# a page went, and one a redeploy silently erased would be no account at all.
#
# BE PRECISE ABOUT WHAT IT PROVES. It is a complete record of what `browse`
# contacted, not of what the agent reached: --log is an ordinary flag, this
# variable is an ordinary variable, the file sits in a directory the agent owns
# read-write, and curl exists. It is evidence about a cooperating agent's
# browser, which is genuinely worth the mount — it is not an enforcement
# boundary and a decision about egress should not treat it as one.
# browser-cli/README.md carries the full version.
#
# One file for the whole container, shared by every agent in the crew, which is
# the right grain: what is being recorded is what left this sandbox, and the
# sandbox is the container. The file is opened O_APPEND and written one line
# per write(), so concurrent writers cannot overwrite each other's records.
# `browse` creates the directory on first use.

# Google Workspace service account key, mounted only if it exists.
#
# Optional on purpose: the repo ships gws-cli whether or not anyone has set up
# Google credentials, and a missing file passed to `docker run -v` would be
# created as an empty *directory*, which fails confusingly at first use rather
# than at startup.
GWS_KEY=${GWS_KEY:-/home/npurcell/clawcius/secrets/gws-service-account.json}

# The agent's Claude home, owned entirely by this instance.
#
# The host's ~/.claude is NOT mounted any more. Sharing one OAuth credential
# across the sandbox boundary was tried twice — bind-mounted file, then
# directory-plus-symlink — and both left the container reading a stale
# credential under gVisor while the host's was current. The Dockerfile carries
# the full post-mortem.
#
# Now each instance keeps its own login here, read-write, with the container as
# the only writer, so it refreshes its own token the way any Claude Code
# install does. Still the user's Claude subscription via
# `claude auth login --claudeai` — this is not API billing.
#
# Two things fall out of that which are worth having on purpose:
#
#   The agent can no longer read the host's ~/.claude at all — not the
#   credential, not the host user's session transcripts. That mount was a real
#   widening and it is gone.
#
#   The agent's own transcripts stop being written into the host user's
#   projects directory, where they were showing up alongside their own work.
#
# Persisted on the instance state dir rather than the container's writable
# layer so `--recreate` does not log the agent out.
AGENT_HOME=$CLAWCIUS_STATE/agent-home
AGENT_CLAUDE=/home/agent/.claude-agent

# This script runs as npurcell (the container units are User=npurcell) and the
# Dockerfile builds the agent user with AGENT_UID=1000 to match, so a plain
# `mkdir -p` lands with the uid the container runs as, by construction. No
# chown needed and none here.
mkdir -p "$STATE_RUN"
# Created rather than asserted. This used to hard-fail, which was right when
# the path was a constant: /var/lib/clawcius comes from the unit's
# StateDirectory, so its absence meant something was wrong. Now that it is
# derived from CLAWCIUS_STATE_DIR, a fresh instance legitimately has no
# workspaces directory yet, and failing would make the first start of every new
# deployment a manual step.
#
# The parent still has to exist and be ours — /var/lib is root-owned, so each
# instance's unit declares StateDirectory and systemd creates the top level.
mkdir -p "$WORKSPACES"
# Created, not asserted: a brand-new instance has no agent home until its first
# start, and `claude auth login` inside the container populates it. Asserting
# would make the first start of every deployment a manual step.
#
# No credential check here any more. Whether this instance is logged in is a
# question for `claude auth status` inside the container, not for the host —
# the host's own login is no longer involved.
mkdir -p "$AGENT_HOME/projects"

# Existence and status asked separately, deliberately.
#
# The obvious one-liner is wrong:
#
#     STATE=$(docker inspect -f '{{...}}' "$NAME" 2>/dev/null || echo missing)
#
# On a container that does not exist, `docker inspect -f` still prints a
# newline to stdout before failing, so the fallback appends to it and STATE
# becomes "\nmissing". Command substitution strips trailing newlines, not
# leading ones, so `case` never matches `missing` and falls through to the
# start-an-existing-container branch — which then fails with "No such
# container" on the one path that was supposed to create it.
#
# It stayed hidden because --recreate assigns STATE=missing directly; only a
# genuinely first-time start reaches this.
# `docker container inspect`, never bare `docker inspect`: the bare form
# resolves ANY object type, and an image named after the container (exactly
# what a migrated deployment has) matches — then .State.Status explodes on a
# map with no State. Bare inspect only worked before because the container
# always already existed on the original host.
if docker container inspect "$NAME" >/dev/null 2>&1; then
  STATE=$(docker container inspect -f '{{.State.Status}}' "$NAME")
else
  STATE=missing
fi

if [ "$RECREATE" = 1 ] && [ "$STATE" != missing ]; then
  echo "--recreate: destroying the existing container and its writable layer"
  docker rm -f "$NAME" >/dev/null
  STATE=missing
fi

# Warn when .env has been edited since the container last started. Reuse means
# the process inside is still holding the old values — a rotated token or a new
# PAT will not have reached it, and that failure looks like a permissions bug
# rather than a stale process.
warn_stale_env() {
  local started env_epoch started_epoch
  started=$(docker container inspect -f '{{.State.StartedAt}}' "$NAME" 2>/dev/null) || return 0
  started_epoch=$(date -d "$started" +%s 2>/dev/null) || return 0
  env_epoch=$(stat -c %Y "$ENV_FILE" 2>/dev/null) || return 0
  if [ "$env_epoch" -gt "$started_epoch" ]; then
    echo "  WARNING: $ENV_FILE changed after this container started."
    echo "           It is still running with the old environment."
    echo "           Apply it with:  docker/run-container.sh --recreate"
  fi
}

case "$STATE" in
  running)
    echo "reusing $NAME (already running)"
    warn_stale_env
    docker ps --filter "name=$NAME" --format '  {{.Names}}  {{.Status}}  runtime-isolated'
    exit 0
    ;;
  paused)
    docker unpause "$NAME" >/dev/null
    echo "unpaused $NAME"
    warn_stale_env
    exit 0
    ;;
  missing)
    ;;
  dead)
    echo "$NAME is in the 'dead' state and cannot be started." >&2
    echo "Recreate it (this discards its writable layer):" >&2
    echo "    docker/run-container.sh --recreate" >&2
    exit 1
    ;;
  *)
    # exited or created — start it back up with its layer intact.
    docker start "$NAME" >/dev/null
    echo "restarted $NAME (writable layer preserved)"
    warn_stale_env
    docker ps --filter "name=$NAME" --format '  {{.Names}}  {{.Status}}  runtime-isolated'
    exit 0
    ;;
esac

# clawcius-internal has NO gateway to the outside. The only reachable thing
# with a route out is Squid. That is what makes the proxy enforcement rather
# than a suggestion: unsetting HTTPS_PROXY does not reveal a second path, it
# just removes the only one.
#
# What Squid then DECIDES is a smaller thing than that topology suggests, and
# has been since 2026-08-01: egress is default-allow, filtered by a blocklist
# whose only entry is `.invalid`, which can never resolve and is there to keep
# the config parseable — so nothing is blocked today (squid/squid.conf §5).
# The route is still the only route; it is no longer a gate.
PROXY=http://172.31.250.2:3128

# The agent's wall clock. A named zone, never a fixed offset: the agent
# schedules its own recurring work, and cron expressions are interpreted in
# local time. On UTC, "9am" had to be written as 16:04 and would silently
# become 8am for the operator when daylight saving ended. With a zone that
# observes DST, 9am stays 9am through November without anyone remembering.
#
# It also stops the agent reporting timestamps in a clock nobody else is
# reading, which cost an evening of confusion when 23:47 UTC was taken for
# 23:47 local -- a seven-hour error in the middle of a timing investigation.
AGENT_TZ="${AGENT_TZ:-America/Los_Angeles}"

# Dropped caps are the classic abuse set the agent has no use for. Not
# --cap-drop=ALL: root execs in here run apt, and dpkg needs CHOWN,
# SETUID/SETGID, DAC_OVERRIDE and FOWNER — dropping those breaks the
# persistent-sandbox package story the snapshot timer exists to protect.

GWS_MOUNT=()
if [ -f "$GWS_KEY" ]; then
  GWS_MOUNT=(-v "$GWS_KEY:/home/agent/.config/gws/service-account.json:ro")
else
  echo "note: no Google Workspace key at $GWS_KEY — gdoc will report it is unconfigured"
fi

# --init makes pid 1 a real init (Docker's tini) instead of `sleep infinity`,
# and the whole point of that is reaping.
#
# Every orphaned process in a PID namespace is reparented to pid 1. `sleep`
# never calls wait(), so nothing in this container has ever reaped an orphan:
# each one becomes a zombie that persists until the container is replaced. A
# zombie holds no memory, which is why this does not look like the leak it is.
# It is a PID leak, and --pids-limit below is 512. Measured inside the live
# container on 2026-08-17: 92 of 99 processes were zombies, every one with
# PPid 1, spread across fifteen different programs — node, timeout, python3,
# systemctl, git, docker, curl. Twenty-eight are the chromium ones that led to
# #74; the other sixty-four are everything else, which is the argument.
# `browser-cli/browse` fixed its own by making itself a subreaper and wait()ing
# them, and that cannot generalise — a process cannot reap another process's
# children, so every tool whose children outlive it would have to do the same
# by hand and nobody will remember to.
#
# Measured under --runtime=runsc rather than assumed, on throwaway containers
# on this host: with --init, /proc/1/comm is docker-init and orphans made the
# way `docker exec` makes them are reaped; the identical probe without it left
# two zombies for the life of the container. `docker stop` returned 143 in
# ~0.2s either way, so tini's signal forwarding costs nothing measurable, and
# the host reports InitBinary=docker-init — no missing binary waiting on the
# first --recreate.
#
# What it costs: one more process, and tini rather than `sleep` receives the
# signals and forwards them on.
#
# THREE THINGS IT DOES NOT DO.
#
# It does not clear the zombies already here. Their parent is pid 1, so only
# replacing the container disposes of them — which --recreate does anyway.
#
# It does not reach a container that already exists. `docker run` flags apply
# at creation and this script reuses by default, so on every path that returns
# above this line the flag is inert and pid 1 is still `sleep infinity`.
# Nothing says so out loud: warn_stale_env compares .env's mtime against the
# container's start time and has no opinion about flags, so `up.sh` prints
# "reusing" and looks exactly as it did before. Until somebody runs
# `docker/run-container.sh --recreate`, this changed the script and not the
# deployment. See Clawcius #84.
#
# THAT IS TWO CONTAINERS, NOT ONE. systemd/hamachi-container.service runs this
# same script with CLAWCIUS_CONTAINER=hamachi-agent, and on 2026-08-17 both it
# and clawcius-agent reported HostConfig.Init null. Each needs its own
# --recreate, and confirming docker-init in one says nothing about the other:
#
#     docker container inspect -f '{{.Name}} {{.HostConfig.Init}}' \
#         clawcius-agent hamachi-agent
#
# DO NOT RECREATE THE SECOND BY OVERRIDING ONLY THE NAME. The command that
# comes to mind,
#
#     CLAWCIUS_CONTAINER=hamachi-agent docker/run-container.sh --recreate
#
# is destructive: every other value above falls back to its instance-1
# default, so hamachi-agent returns built from clawcius's image, holding
# clawcius's .env, with /var/lib/clawcius/workspaces mounted and
# /var/lib/clawcius/agent-home as its Claude credential — two agents on one
# login and one workspace, which is the state the AGENT_HOME paragraph above
# exists to prevent. The `docker rm -f` has already run by the time any of
# that is visible.
#
# The five values it needs live in systemd/hamachi-container.service. They are
# deliberately NOT copied here, because a second copy is a thing that drifts;
# read them from the unit at the moment you need them:
#
#     systemctl show hamachi-container -p Environment
#
# And it does not come free, because --recreate destroys the writable layer
# this file's header exists to protect. It restarts from $IMAGE, which
# defaults to :latest, and docker/snapshot.sh commits to :snap-<stamp> without
# ever retagging latest — so the default genuinely does discard everything
# installed since the image was built.
#
# There are two forms and neither is the default answer:
#
#     docker/run-container.sh --recreate                       # from :latest
#     CLAWCIUS_IMAGE=<repo>:snap-<stamp> docker/run-container.sh --recreate
#
# If you take the second, take a snapshot FIRST rather than reaching for the
# newest existing tag. clawcius-snapshot.timer is the only snapshot timer on
# this host and clawcius-snapshot.service passes no environment, so it covers
# instance 1 and nothing else — hamachi's newest tag is 2026-08-14, and even
# instance 1's is up to a day old (#87). snapshot.sh reads the same
# CLAWCIUS_CONTAINER, so it is one command per instance and it prints the tag
# it wrote:
#
#     CLAWCIUS_CONTAINER=<name> docker/snapshot.sh
#
# The second when the layer holds work that is not in the image yet. The first
# when losing the layer is the POINT — a rebuild that ships what was being
# staged by hand makes the reset the outcome you wanted, not the price you
# paid. That is a question about what is in the layer and what the current
# image already ships, and the answer changes; do not read either line here as
# the standing recommendation.
#
# Then confirm it landed here, which is a different question from whether the
# flag works: `docker exec "$NAME" cat /proc/1/comm` should print docker-init,
# and the zombie count should stay flat across a few `browse` runs instead of
# climbing by two each time.
docker run -d \
  --name "$NAME" \
  --runtime=runsc \
  --restart unless-stopped \
  --network clawcius-internal \
  --env-file "$ENV_FILE" \
  -e HTTP_PROXY="$PROXY"  -e http_proxy="$PROXY" \
  -e HTTPS_PROXY="$PROXY" -e https_proxy="$PROXY" \
  -e NO_PROXY=localhost,127.0.0.1 -e no_proxy=localhost,127.0.0.1 \
  -e CLAUDE_CONFIG_DIR="$AGENT_CLAUDE" \
  -e HOME=/home/agent \
  -e TZ="$AGENT_TZ" \
  -v "$WORKSPACES:$WORKSPACES:rw" \
  -v "$STATE_RUN:$STATE_RUN:rw" \
  -v "$AGENT_HOME:$AGENT_CLAUDE:rw" \
  -v "$SKILLS:$SKILLS:ro" \
  -v "$DISCORD_CLI:$DISCORD_CLI:ro" \
  -v "$GWS_CLI:$GWS_CLI:ro" \
  -v "$BROWSER_CLI:$BROWSER_CLI:ro" \
  -e BROWSE_LOG="$WORKSPACES/.browse/navigation.jsonl" \
  "${GWS_MOUNT[@]}" \
  -w "$WORKSPACES" \
  --memory="$MEMORY" \
  --init \
  --pids-limit=512 \
  --security-opt=no-new-privileges:true \
  --cap-drop=NET_RAW --cap-drop=MKNOD --cap-drop=AUDIT_WRITE \
  --cap-drop=NET_BIND_SERVICE --cap-drop=SYS_CHROOT \
  "$IMAGE" >/dev/null

# Never mount the docker socket in here. It would let the agent start a
# privileged container mounting the host filesystem, which makes gVisor
# decorative. If it ever needs host-side work done, its coordinator asks the
# host agent for it by DM, and a Claude Code session on the host does it under
# a narrow sudoers file with every command audited.

echo "created $NAME from $IMAGE"
docker ps --filter "name=$NAME" --format '  {{.Names}}  {{.Status}}  runtime-isolated'
