#!/usr/bin/env bash
# Stop the stack.
#
# The agent container is STOPPED, not removed. Its writable layer holds
# everything the agent installed and configured, so `docker rm` here would mean
# every `systemctl stop clawcius-container` — including every restart and every
# reboot — silently reset the agent to the base image.
#
# Squid is removed rather than stopped, because it has no state worth keeping:
# its config is baked into the image at build time, so it is reconstructed
# exactly by up.sh.
#
# Networks are left in place — they hold no state and recreating them on every
# boot only invites subnet churn.
#
# To actually discard the agent container:
#
#     docker/down.sh --destroy
#
set -uo pipefail
cd "$(dirname "$0")"

DESTROY=0
for arg in "$@"; do
  case "$arg" in
    --destroy) DESTROY=1 ;;
    *) echo "usage: $(basename "$0") [--destroy]" >&2; exit 2 ;;
  esac
done

if [ "$DESTROY" = 1 ]; then
  echo "--destroy: removing clawcius-agent and its writable layer"
  docker rm -f clawcius-agent >/dev/null 2>&1 || true
else
  # -t 10: give cron jobs and any daemons the agent started a chance to exit
  # cleanly before SIGKILL.
  docker stop -t 10 clawcius-agent >/dev/null 2>&1 || true
fi

docker rm -f clawcius-squid >/dev/null 2>&1 || true
echo "stopped clawcius stack"
