#!/usr/bin/env bash
# Stop the stack. Networks are left in place — they hold no state and
# recreating them on every boot only invites subnet churn.
set -uo pipefail
cd "$(dirname "$0")"
docker rm -f clawcius-agent  >/dev/null 2>&1 || true
docker rm -f clawcius-squid  >/dev/null 2>&1 || true
echo "stopped clawcius stack"
