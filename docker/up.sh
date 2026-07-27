#!/usr/bin/env bash
# Bring up the whole agent stack: networks, Squid, then the agent container.
#
# Idempotent, and safe to run on a live stack.
#
# Squid is recreated every time: its config is baked into the image, so this is
# how an allowlist edit takes effect, and it has no state to lose.
#
# The agent container is REUSED if it exists — see run-container.sh. Its
# writable layer is where the agent's packages, crontabs and daemons live, so
# recreating it on every boot would make "persistent sandbox" a fiction. Pass
# --recreate to force a clean one.
set -euo pipefail
cd "$(dirname "$0")"

AGENT_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --recreate) AGENT_ARGS+=(--recreate) ;;
    *) echo "usage: $(basename "$0") [--recreate]" >&2; exit 2 ;;
  esac
done

INTERNAL=clawcius-internal
EGRESS=clawcius-egress
SUBNET=172.31.250.0/24
SQUID_IP=172.31.250.2

# clawcius-internal has no gateway to the outside. That is what makes the proxy
# enforcement rather than a suggestion: there is no second route to find.
docker network inspect "$INTERNAL" >/dev/null 2>&1 \
  || docker network create --internal --subnet "$SUBNET" "$INTERNAL" >/dev/null
docker network inspect "$EGRESS" >/dev/null 2>&1 \
  || docker network create "$EGRESS" >/dev/null

# The allowlist lives in squid/squid.conf and is baked into the image, so an
# edit there is inert until the image is rebuilt. Syncing and rebuilding on
# every up.sh removes that failure mode rather than documenting it: the layer
# cache makes this ~a second when the config has not changed.
cp ../squid/squid.conf ./squid.conf
docker build -q -f Dockerfile.squid -t clawcius-squid:latest . >/dev/null

# Squid straddles both networks: reachable from the agent, and the only thing
# on that side with a route out.
docker rm -f clawcius-squid >/dev/null 2>&1 || true
docker run -d --name clawcius-squid \
  --restart unless-stopped \
  --network "$INTERNAL" --ip "$SQUID_IP" \
  --memory=256m \
  clawcius-squid:latest >/dev/null
docker network connect "$EGRESS" clawcius-squid

./run-container.sh "${AGENT_ARGS[@]+"${AGENT_ARGS[@]}"}"
