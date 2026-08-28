#!/usr/bin/env bash
# Snapshot the agent container's writable layer to an image. git covers what
# the agent wrote; this covers how the container became what it is (apt and
# pip packages, cron entries). Runs on the host from a systemd timer, writing
# to host-side storage the agent cannot reach.
#
# Restore:  docker rm -f clawcius-agent
#           docker tag clawcius-agent:snap-<stamp> clawcius-agent:latest
#           docker/run-container.sh
set -euo pipefail

# Parameterised the same way as run-container.sh; the defaults are instance 1.
NAME=${CLAWCIUS_CONTAINER:-clawcius-agent}
REPO=${CLAWCIUS_SNAPSHOT_REPO:-$NAME}
KEEP=${KEEP:-8}

# `docker container inspect`, never bare `docker inspect`: the bare form
# resolves any object type, and the snapshot repo is named after the
# container, so it can match the image, which has no .State.
docker container inspect -f '{{.State.Running}}' "$NAME" >/dev/null 2>&1 || {
  echo "container $NAME is not running; nothing to snapshot" >&2
  exit 0
}

STAMP=$(date -u +%Y%m%d-%H%M%S)
docker commit -m "clawcius snapshot $STAMP" "$NAME" "$REPO:snap-$STAMP" >/dev/null
echo "snapshot: $REPO:snap-$STAMP"

# Retention: each snapshot holds a writable layer, so without a ceiling they
# eat the disk.
mapfile -t OLD < <(docker images "$REPO" --format '{{.Tag}}' \
                     | grep '^snap-' | sort -r | tail -n +$((KEEP + 1)))
for tag in "${OLD[@]:-}"; do
  [ -n "$tag" ] || continue
  docker rmi "$REPO:$tag" >/dev/null 2>&1 && echo "  pruned $tag"
done

docker images "$REPO" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' | grep snap- | head -3
