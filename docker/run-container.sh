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

NAME=clawcius-agent
IMAGE=clawcius-agent:latest
ENV_FILE=/home/npurcell/clawcius/.env

# Paths are mirrored host->container deliberately. Claude Code derives its
# transcript directory from cwd, so a workspace mounted anywhere else would
# silently start a new session instead of resuming.
WORKSPACES=/var/lib/clawcius/workspaces
# The agent drops wake-request JSON here; the waker watches it.
WAKE_DIR=/var/lib/clawcius/run
SKILLS=/home/npurcell/clawcius/.claude
DISCORD_CLI=/home/npurcell/clawcius/discord-cli

# Two paths out of the host user's Claude home, rather than the whole thing.
#
# The operator asked to mount ~/.claude so the agent uses their OAuth login.
# Mounting it wholesale worked, but the agent's Claude Code immediately wrote
# a .claude.json into it — the agent and the host user would be sharing (and
# overwriting) one config directory: settings, shell snapshots, history, todos.
#
# These two give the same result with far less collateral:
#   .credentials.json  the OAuth login  (read-write; refresh rewrites it)
#   projects/          session transcripts, so the existing session resumes
#
# Everything else the agent's Claude Code wants stays inside the container.
#
# The security trade is unchanged and was accepted deliberately: whatever can
# compromise the agent can read and modify those credentials. gVisor contains
# the kernel, not a directory you hand it.
CLAUDE_CREDS=/home/npurcell/.claude/.credentials.json
CLAUDE_PROJECTS=/home/npurcell/.claude/projects
AGENT_CLAUDE=/home/agent/.claude-agent

# The agent's home, persisted on the host.
#
# The container is here for isolation, not for ephemerality. Anywhere the agent
# naturally saves a file should still be there after a container recreate or a
# host reboot — otherwise the isolation costs it a memory, which is not a trade
# anyone asked for.
#
# Without this, /home/agent lives in the image's writable layer and is destroyed
# on every recreate. On 2026-08-03 that silently took six days of saved game
# state with it, and the only reason the session survived at all is that
# projects/ was already mounted separately.
#
# uid 1000 matches AGENT_UID in the Dockerfile. If that ever changes, this
# chown has to follow it or the agent cannot write to its own home.
AGENT_HOME=/var/lib/clawcius/agent-home
AGENT_UID=1000

mkdir -p "$WAKE_DIR"

# Seed the home directory before mounting over it. The image creates
# .claude-agent and chowns home; a bind mount hides all of that, so the
# structure has to exist on the host or the nested credential and projects
# mounts have nowhere to land.
mkdir -p "$AGENT_HOME/.claude-agent/projects"
chown -R "$AGENT_UID:$AGENT_UID" "$AGENT_HOME" 2>/dev/null || \
  echo "warning: could not chown $AGENT_HOME — the agent may not be able to write to its own home" >&2
[ -d "$WORKSPACES" ]      || { echo "missing $WORKSPACES" >&2; exit 1; }
[ -f "$CLAUDE_CREDS" ]    || { echo "missing $CLAUDE_CREDS — is the host logged in?" >&2; exit 1; }
[ -d "$CLAUDE_PROJECTS" ] || { echo "missing $CLAUDE_PROJECTS" >&2; exit 1; }

STATE=$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || echo missing)

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
  started=$(docker inspect -f '{{.State.StartedAt}}' "$NAME" 2>/dev/null) || return 0
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
  -v "$AGENT_HOME:/home/agent:rw" \
  -v "$WORKSPACES:$WORKSPACES:rw" \
  -v "$WAKE_DIR:$WAKE_DIR:rw" \
  -v "$CLAUDE_CREDS:$AGENT_CLAUDE/.credentials.json:rw" \
  -v "$CLAUDE_PROJECTS:$AGENT_CLAUDE/projects:rw" \
  -v "$SKILLS:$SKILLS:ro" \
  -v "$DISCORD_CLI:$DISCORD_CLI:ro" \
  -w "$WORKSPACES" \
  --memory=2g \
  --pids-limit=512 \
  "$IMAGE" >/dev/null

# Never mount the docker socket in here. It would let the agent start a
# privileged container mounting the host filesystem, which makes gVisor
# decorative. If it ever needs host-side work done, that goes through the
# waker's wake socket instead.

echo "created $NAME from $IMAGE"
docker ps --filter "name=$NAME" --format '  {{.Names}}  {{.Status}}  runtime-isolated'
