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
#
# That restore path is now exercised on a timer rather than trusted —
# clawcius-snapshot-verify.timer starts a throwaway container from the newest
# snapshot and proves it comes up. It exists because these images had been
# produced nightly for weeks without one of them ever having been booted, which
# is not a backup, it is 2 GB of optimism.
#
# It also checks the DATE on the tag it picks, which it did not until 2026-08-19
# — and that omission is why this script's own coverage gap went unnoticed for
# days. One instance had no timer calling this script at all, its newest image
# never moved, and the verifier booted that frozen image every night and
# reported the rollback path healthy. See ops/README.md and Clawcius #87.
set -euo pipefail

# Parameterised the same way as run-container.sh, and for the same reason: a
# second instance is config, not a forked copy of this script. The defaults are
# instance 1, so clawcius-snapshot.service and anything else calling this with
# no environment behaves exactly as it did before.
#
# The ops executor sets both when it snapshots an instance before recreating
# it. It passes them as environment on an argv-array exec — there is no shell
# involved on that path, and the values come from its own config allowlist,
# never from the request that triggered it.
NAME=${CLAWCIUS_CONTAINER:-clawcius-agent}
REPO=${CLAWCIUS_SNAPSHOT_REPO:-$NAME}
KEEP=${KEEP:-8}

# `docker container inspect`, never bare `docker inspect`. The bare form
# resolves ANY object type, and the snapshot repo is named after the container
# — so on a host that has ever taken a snapshot, bare inspect can match the
# IMAGE, whose JSON has no .State, and the whole check fails into the "not
# running" branch. That branch exits 0, so the failure mode was a nightly timer
# reporting success and silently taking no backups. run-container.sh was fixed
# for the same reason on 2026-08-08; this copy was missed.
docker container inspect -f '{{.State.Running}}' "$NAME" >/dev/null 2>&1 || {
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
