#!/usr/bin/env bash
# Stop the stack. The agent container is stopped, not removed: its writable
# layer is the agent's installed packages, crontabs and daemons. Squid is
# removed (no state; up.sh rebuilds it) and the networks are left in place.
# --destroy removes the agent container and its writable layer too.
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
  # -t 10: cron jobs and daemons the agent started get a chance to exit before SIGKILL.
  docker stop -t 10 clawcius-agent >/dev/null 2>&1 || true
fi

docker rm -f clawcius-squid >/dev/null 2>&1 || true
echo "stopped clawcius stack"
