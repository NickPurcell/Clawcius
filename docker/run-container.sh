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
# network — the allowlist is a property of the egress policy, not of who is
# using it. What it must NOT share is the container, the workspaces or the
# state directory; those are the sandbox.
NAME=${CLAWCIUS_CONTAINER:-clawcius-agent}
IMAGE=${CLAWCIUS_IMAGE:-clawcius-agent:latest}
ENV_FILE=${CLAWCIUS_ENV_FILE:-/home/npurcell/clawcius/.env}
MEMORY=${CLAWCIUS_CONTAINER_MEMORY:-2g}

# Paths are mirrored host->container deliberately. Claude Code derives its
# transcript directory from cwd, so a workspace mounted anywhere else would
# silently start a new session instead of resuming.
CLAWCIUS_STATE=${CLAWCIUS_STATE_DIR:-/var/lib/clawcius}
WORKSPACES=$CLAWCIUS_STATE/workspaces
# The agent drops wake-request JSON here; the waker watches it.
WAKE_DIR=$CLAWCIUS_STATE/run
SKILLS=/home/npurcell/clawcius/.claude
DISCORD_CLI=/home/npurcell/clawcius/discord-cli
GWS_CLI=/home/npurcell/clawcius/gws-cli

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

mkdir -p "$WAKE_DIR"
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
# with a route out is Squid, which enforces the domain allowlist. That is what
# makes the proxy enforcement rather than a suggestion: unsetting HTTPS_PROXY
# does not reveal a second path, it just removes the only one.
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
  -v "$WAKE_DIR:$WAKE_DIR:rw" \
  -v "$AGENT_HOME:$AGENT_CLAUDE:rw" \
  -v "$SKILLS:$SKILLS:ro" \
  -v "$DISCORD_CLI:$DISCORD_CLI:ro" \
  -v "$GWS_CLI:$GWS_CLI:ro" \
  "${GWS_MOUNT[@]}" \
  -w "$WORKSPACES" \
  --memory="$MEMORY" \
  --pids-limit=512 \
  --security-opt=no-new-privileges:true \
  --cap-drop=NET_RAW --cap-drop=MKNOD --cap-drop=AUDIT_WRITE \
  --cap-drop=NET_BIND_SERVICE --cap-drop=SYS_CHROOT \
  "$IMAGE" >/dev/null

# Never mount the docker socket in here. It would let the agent start a
# privileged container mounting the host filesystem, which makes gVisor
# decorative. If it ever needs host-side work done, that goes through the
# waker's wake socket instead.

echo "created $NAME from $IMAGE"
docker ps --filter "name=$NAME" --format '  {{.Names}}  {{.Status}}  runtime-isolated'
