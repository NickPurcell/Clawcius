#!/usr/bin/env bash
# Start (or restart) the persistent Clawcius agent container; the waker attaches
# per turn with `docker exec`. An existing container is reused with its writable
# layer and its original `docker run` flags; --recreate discards both.
set -euo pipefail

RECREATE=0
for arg in "$@"; do
  case "$arg" in
    --recreate) RECREATE=1 ;;
    *) echo "usage: $(basename "$0") [--recreate]" >&2; exit 2 ;;
  esac
done

# Every instance-specific value is overridable; the defaults are instance 1. A
# second instance must override all of them, or --recreate builds its container
# on instance 1's env and state.
NAME=${CLAWCIUS_CONTAINER:-clawcius-agent}
IMAGE=${CLAWCIUS_IMAGE:-clawcius-agent:latest}
ENV_FILE=${CLAWCIUS_ENV_FILE:-/etc/clawcius/clawcius.env}
MEMORY=${CLAWCIUS_CONTAINER_MEMORY:-2g}

# Paths are mirrored host->container: Claude Code derives its transcript
# directory from cwd, so a workspace mounted anywhere else would start a new
# session instead of resuming.
CLAWCIUS_STATE=${CLAWCIUS_STATE_DIR:-/var/lib/clawcius}
WORKSPACES=$CLAWCIUS_STATE/workspaces
# The GitHub App installation token the agents' git credential helper reads.
# The daemon serves it to the sandbox, so it sits outside every read-write
# mount and is mounted :ro below; the sandbox must not be able to replace it.
GITHUB_TOKEN_DIR=${CLAWCIUS_GITHUB_TOKEN_DIR:-$CLAWCIUS_STATE/github-token}
# The deployed checkout, mounted whole so `current` resolves inside the container after a deploy.
REPO=${CLAWCIUS_REPO_DIR:-/srv/clawcius}
BOTS=$REPO/current/bots
CREW=${CLAWCIUS_CREW:-${NAME%-agent}}
# Fixed address: Squid holds .2, and a container that restarts before Squid must not take it.
AGENT_IP=${CLAWCIUS_AGENT_IP:-172.31.250.3}

# Google Workspace service account key, mounted only if it exists: a missing
# file passed to `docker run -v` is created as an empty directory.
GWS_KEY=${GWS_KEY:-/etc/clawcius/gws-service-account.json}

# The agent's Claude home, on the state dir so --recreate does not log it out;
# the container is its only writer.
AGENT_HOME=$CLAWCIUS_STATE/agent-home
AGENT_CLAUDE=/home/agent/.claude-agent

# This runs as npurcell, uid 1000, the container's `agent` uid; no chown needed.
# Created, not asserted: a fresh instance has no workspaces directory yet. The
# parent is the instance unit's StateDirectory.
mkdir -p "$WORKSPACES"
# Created here so the :ro mount below has something to bind; Docker would
# create a missing source as root-owned.
mkdir -p "$GITHUB_TOKEN_DIR"
chmod 700 "$GITHUB_TOKEN_DIR"
# Created, not asserted: `claude auth login` inside the container populates it.
mkdir -p "$AGENT_HOME/projects"

# Existence and status asked separately: on a missing container `inspect -f`
# prints a newline before failing. `docker container inspect`, never bare
# `inspect`, which would match the image.
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

# Warn when .env has been edited since the container last started: the process
# inside still holds the old values, and a rotated token then looks like a
# permissions bug rather than a stale process.
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

# Printed to stdout, which is the unit's journal, readable without sudo: never
# print .Config.Env, .Config.Cmd or .Mounts here.
describe_container() {
  # `local` on its own line: `local raw=$(cmd)` takes local's exit status.
  local raw created id image imageid runtime init memory pids
  # Guarded: under systemd's `set -e`, a readback must not take the unit down.
  raw=$(docker container inspect -f \
    '{{.Created}}|{{.Id}}|{{.Config.Image}}|{{.Image}}|{{.HostConfig.Runtime}}|{{.HostConfig.Init}}|{{.HostConfig.Memory}}|{{.HostConfig.PidsLimit}}' \
    "$NAME" 2>/dev/null) || {
    echo "  (could not read this container's config back: docker container inspect failed)"
    return 0
  }
  IFS='|' read -r created id image imageid runtime init memory pids <<<"$raw" || return 0
  # HostConfig.Memory is bytes; 0 is docker's "no limit".
  case "$memory" in
    0) memory=unlimited ;;
    '' | *[!0-9]*) ;;
    *) memory="$((memory / 1024 / 1024))m" ;;
  esac
  # Docker spells "no pids limit" as 0 and as -1.
  case "$pids" in
    0 | -1) pids=unlimited ;;
  esac
  id=${id:0:12}
  imageid=${imageid#sha256:}
  imageid=${imageid:0:12}
  # Nanoseconds trimmed, the Z kept: this is UTC and `docker ps` beside it is local.
  created=${created/.*Z/Z}
  echo "  read back, in the fields that differ between deployments (not the whole config):"
  echo "  id $id  created $created  image $image ($imageid)"
  echo "  runtime $runtime  init $init  memory $memory  pids-limit $pids"
}

# A reused container keeps the flags it was created with; say so, then report.
warn_flags_inert() {
  echo "  NOTE: reused, not created — this run did not apply the docker run flags"
  echo "        below; whatever it has, it got when it was created. --recreate"
  echo "        applies the current ones, and discards the writable layer."
  describe_container
}

case "$STATE" in
  running)
    echo "reusing $NAME (already running)"
    warn_flags_inert
    warn_stale_env
    docker ps --filter "name=$NAME" --format '  {{.Names}}  {{.Status}}  runtime-isolated'
    exit 0
    ;;
  paused)
    docker unpause "$NAME" >/dev/null
    echo "unpaused $NAME"
    warn_flags_inert
    warn_stale_env
    exit 0
    ;;
  missing)
    ;;
  dead)
    echo "$NAME is in the 'dead' state and cannot be started." >&2
    # The advice below discards the writable layer, so print the container's
    # age and image first. describe_container returns 0 on every path.
    describe_container >&2
    echo "Recreate it (this discards its writable layer):" >&2
    echo "    docker/run-container.sh --recreate" >&2
    exit 1
    ;;
  *)
    # exited or created — start it back up with its layer intact.
    docker start "$NAME" >/dev/null
    echo "restarted $NAME (writable layer preserved)"
    warn_flags_inert
    warn_stale_env
    docker ps --filter "name=$NAME" --format '  {{.Names}}  {{.Status}}  runtime-isolated'
    exit 0
    ;;
esac

# clawcius-internal has no gateway out; Squid is the only route.
PROXY=http://172.31.250.2:3128

# A named zone, never a fixed offset: the agent schedules its own cron jobs in
# local time, and a zone that observes DST keeps "9am" at 9am.
AGENT_TZ="${AGENT_TZ:-America/Los_Angeles}"

GWS_MOUNT=()
if [ -f "$GWS_KEY" ]; then
  GWS_MOUNT=(-v "$GWS_KEY:/home/agent/.config/gws/service-account.json:ro")
else
  echo "note: no Google Workspace key at $GWS_KEY — gdoc will report it is unconfigured"
fi

# Not --cap-drop=ALL: root execs here run apt, and dpkg needs CHOWN,
# SETUID/SETGID, DAC_OVERRIDE and FOWNER.
docker run -d \
  --name "$NAME" \
  --runtime=runsc \
  --restart unless-stopped \
  --network clawcius-internal --ip "$AGENT_IP" \
  --env-file "$ENV_FILE" \
  -e HTTP_PROXY="$PROXY"  -e http_proxy="$PROXY" \
  -e HTTPS_PROXY="$PROXY" -e https_proxy="$PROXY" \
  -e NO_PROXY=localhost,127.0.0.1 -e no_proxy=localhost,127.0.0.1 \
  -e CLAUDE_CONFIG_DIR="$AGENT_CLAUDE" \
  -e HOME=/home/agent \
  -e TZ="$AGENT_TZ" \
  -v "$WORKSPACES:$WORKSPACES:rw" \
  -v "$AGENT_HOME:$AGENT_CLAUDE:rw" \
  -v "$REPO:$REPO:ro" \
  -v "$GITHUB_TOKEN_DIR:$GITHUB_TOKEN_DIR:ro" \
  -e BOTS_DIR="$BOTS" -e CREW="$CREW" \
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

# Never mount the docker socket here: a privileged container would make gVisor
# decorative.

echo "created $NAME from $IMAGE"
describe_container
docker ps --filter "name=$NAME" --format '  {{.Names}}  {{.Status}}  runtime-isolated'
