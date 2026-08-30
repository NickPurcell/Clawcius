#!/usr/bin/env bash
# Lock the sandbox subnet down to "internet only": `--internal` leaves the
# host's bridge address and the other sandboxes reachable; this closes both and
# leaves Squid. Docker's DNS answers inside each namespace. Runs every boot.
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
# -I inserts at the top, so the DROP goes in first and the RETURNs land above
# it and win. DOCKER-USER is the chain Docker does not rewrite.
ensure DOCKER-USER -s "$SUBNET" -d "$SUBNET" -j DROP
ensure DOCKER-USER -s "$SUBNET" -d "$PROXY" -j RETURN
ensure DOCKER-USER -s "$PROXY" -d "$SUBNET" -j RETURN

echo "netguard: applied"
