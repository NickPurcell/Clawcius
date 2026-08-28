#!/usr/bin/env bash
# Lock the sandbox subnet down to "internet only". `--internal` gives the
# subnet no route out, but two paths stay open inside it and neither goes
# through Squid: the bridge address 172.31.250.1 is the host itself, and the
# sandboxes can reach each other. Squid stays reachable, being the one peer an
# agent legitimately talks to. DNS is unaffected: Docker's resolver answers on
# 127.0.0.11 inside each container's own namespace and never crosses the bridge.
# Idempotent; runs on every boot via clawcius-netguard.service.
set -euo pipefail

SUBNET=172.31.250.0/24
PROXY=172.31.250.2

# `iptables -C` exits non-zero when the rule is absent, so each call is "add
# unless already there" and a reboot loop does not stack duplicates.
ensure() {
  local chain=$1; shift
  if ! iptables -C "$chain" "$@" 2>/dev/null; then
    iptables -I "$chain" "$@"
    echo "  added:  $chain $*"
  else
    echo "  present: $chain $*"
  fi
}

echo "netguard: host"
# DROP rather than REJECT: a REJECT confirms to the prober that something is there.
ensure INPUT -s "$SUBNET" -j DROP

echo "netguard: sandbox isolation"
# -I inserts at the top, so the last insert ends up first: the DROP goes in
# before the RETURNs so the RETURNs land above it and win for proxy traffic.
# DOCKER-USER is the chain Docker does not rewrite, consulted before its own
# FORWARD rules.
ensure DOCKER-USER -s "$SUBNET" -d "$SUBNET" -j DROP
ensure DOCKER-USER -s "$SUBNET" -d "$PROXY" -j RETURN
ensure DOCKER-USER -s "$PROXY" -d "$SUBNET" -j RETURN

echo "netguard: applied"
