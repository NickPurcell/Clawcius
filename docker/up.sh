#!/usr/bin/env bash
# Bring up the agent stack: networks, Squid, then the agent container.
# Idempotent. Squid is recreated every time (its config is baked into the
# image and it has no state); the agent container is reused unless --recreate
# is passed, because its writable layer is the agent's packages, crontabs and
# daemons.
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

# clawcius-internal has no gateway out, so the proxy is the only route.
docker network inspect "$INTERNAL" >/dev/null 2>&1 \
  || docker network create --internal --subnet "$SUBNET" "$INTERNAL" >/dev/null
docker network inspect "$EGRESS" >/dev/null 2>&1 \
  || docker network create "$EGRESS" >/dev/null

# squid.conf is baked into the image, so rebuild on every up; the layer cache
# makes this about a second when the config has not changed.
# Build context in a temp dir: the deployed checkout is read-only to this user.
CTX=$(mktemp -d); trap 'rm -rf "$CTX"' EXIT
cp ../squid/squid.conf Dockerfile.squid "$CTX"/
docker build -q -f "$CTX/Dockerfile.squid" -t clawcius-squid:latest "$CTX" >/dev/null

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
