#!/usr/bin/env bash
# Snapshot the agent container's writable layer (packages, cron entries) to an image the agent
# cannot reach. Restore: CLAWCIUS_IMAGE=clawcius-agent:snap-<stamp> docker/run-container.sh --recreate
set -euo pipefail

# Parameterised the same way as run-container.sh; the defaults are instance 1.
NAME=${CLAWCIUS_CONTAINER:-clawcius-agent}
REPO=${CLAWCIUS_SNAPSHOT_REPO:-$NAME}
KEEP=${KEEP:-8}

# `docker container inspect`, never bare `inspect`: the snapshot image is named after the container.
docker container inspect -f '{{.State.Running}}' "$NAME" >/dev/null 2>&1 || {
  echo "container $NAME is not running; nothing to snapshot" >&2
  exit 0
}

STAMP=$(date -u +%Y%m%d-%H%M%S)
docker commit -m "clawcius snapshot $STAMP" "$NAME" "$REPO:snap-$STAMP" >/dev/null
echo "snapshot: $REPO:snap-$STAMP"

# Each snapshot holds a writable layer; without a ceiling they eat the disk.
mapfile -t OLD < <(docker images "$REPO" --format '{{.Tag}}' \
                     | grep '^snap-' | sort -r | tail -n +$((KEEP + 1)))
for tag in "${OLD[@]:-}"; do
  [ -n "$tag" ] || continue
  docker rmi "$REPO:$tag" >/dev/null 2>&1 && echo "  pruned $tag"
done

docker images "$REPO" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' | grep snap- | head -3
