#!/usr/bin/env bash
# Snapshot the agent container's writable layer to an image.
#
# git covers what the agent *wrote* — bots, scripts, config in repos. It does
# not cover how the container *became* what it is: apt and pip packages, cron
# entries, anything dropped outside a repo. Those are exactly what wedges a
# machine, so they need their own recovery path.
#
# This runs on the HOST, from a systemd timer, writing to host-side storage.
# That placement is the point: a backup the agent could delete is not a backup.
# The agent has no docker socket and cannot reach this.
#
# Restore:  docker rm -f clawcius-agent
#           docker tag clawcius-agent:snap-<stamp> clawcius-agent:latest
#           docker/run-container.sh
set -euo pipefail

NAME=clawcius-agent
REPO=clawcius-agent
KEEP=${KEEP:-8}

docker inspect -f '{{.State.Running}}' "$NAME" >/dev/null 2>&1 || {
  echo "container $NAME is not running; nothing to snapshot" >&2
  exit 0
}

STAMP=$(date -u +%Y%m%d-%H%M%S)
docker commit -m "clawcius snapshot $STAMP" "$NAME" "$REPO:snap-$STAMP" >/dev/null
echo "snapshot: $REPO:snap-$STAMP"

# Retention. Snapshots accumulate a writable layer each; without a ceiling they
# quietly eat the disk.
mapfile -t OLD < <(docker images "$REPO" --format '{{.Tag}}' \
                     | grep '^snap-' | sort -r | tail -n +$((KEEP + 1)))
for tag in "${OLD[@]:-}"; do
  [ -n "$tag" ] || continue
  docker rmi "$REPO:$tag" >/dev/null 2>&1 && echo "  pruned $tag"
done

docker images "$REPO" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' | grep snap- | head -3
