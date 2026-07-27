#!/usr/bin/env bash
# Bring up the whole agent stack: networks, Squid, then the agent container.
#
# Idempotent by design — it tears down and recreates rather than trying to
# reconcile, so an unclean shutdown does not leave a half-state that needs a
# human to untangle.
set -euo pipefail
cd "$(dirname "$0")"

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

# Squid straddles both networks: reachable from the agent, and the only thing
# on that side with a route out.
docker rm -f clawcius-squid >/dev/null 2>&1 || true
docker run -d --name clawcius-squid \
  --restart unless-stopped \
  --network "$INTERNAL" --ip "$SQUID_IP" \
  --memory=256m \
  clawcius-squid:latest >/dev/null
docker network connect "$EGRESS" clawcius-squid

./run-container.sh
