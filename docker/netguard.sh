#!/usr/bin/env bash
# Lock the sandbox subnet down to "internet only".
#
# The Docker `--internal` flag gets you most of the way: clawcius-internal has
# no route off the subnet, so an agent cannot dial the internet directly and
# every outbound byte goes through Squid. Two holes remain inside the subnet,
# and neither is closable from squid.conf, because neither goes through Squid.
#
#   1. THE HOST. 172.31.250.1 is the bridge address, which is the host itself,
#      and it is *inside* the subnet — so the no-route-out rule does not cover
#      it. Verified from clawcius-agent on 2026-08-01:
#
#          172.31.250.1:22 -> SSH-2.0-OpenSSH_10.2p1 Ubuntu-2ubuntu3.5
#
#      The agent could reach the host's real sshd. sshd is the only thing this
#      host listens for on 0.0.0.0 today, but the rule below blocks the subnet
#      rather than the port, so anything bound later is covered without anyone
#      having to remember this file exists.
#
#   2. THE OTHER SANDBOX. Same bridge, so the agents can reach each other.
#      Today that probes as ConnectionRefused only because neither runs a
#      listener — the path is open, and these agents write daemons. Two
#      sandboxes that can reach each other are one sandbox.
#
# Squid stays reachable, and that exemption is the whole reason this is not
# simply "drop everything within the subnet": the proxy is the one peer an
# agent legitimately talks to.
#
# Not covered here, deliberately: DNS still works. Docker's resolver answers on
# 127.0.0.11 inside each container's own namespace and never crosses the
# bridge, so blocking subnet->host does not touch it.
#
# Idempotent — safe to re-run, and it runs on every boot via
# clawcius-netguard.service.
set -euo pipefail

SUBNET=172.31.250.0/24
PROXY=172.31.250.2

# `iptables -C` tests for a rule and exits non-zero when absent, so each pair
# is "add unless already there". Without it a reboot loop would stack
# duplicates until the chain is unreadable.
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
# DROP rather than REJECT. REJECT is friendlier to debug — it fails fast
# instead of hanging — but it also confirms to whatever is probing that
# something is there to refuse. A sandbox has no business learning the shape of
# the host's listeners.
ensure INPUT -s "$SUBNET" -j DROP

echo "netguard: sandbox isolation"
# Order matters and reads backwards: -I inserts at the top, so the LAST insert
# ends up FIRST. The DROP goes in before the RETURNs precisely so the RETURNs
# land above it and win for proxy traffic.
#
# DOCKER-USER is the chain Docker guarantees it will not rewrite, and it is
# consulted before Docker's own FORWARD rules.
ensure DOCKER-USER -s "$SUBNET" -d "$SUBNET" -j DROP
ensure DOCKER-USER -s "$SUBNET" -d "$PROXY" -j RETURN
ensure DOCKER-USER -s "$PROXY" -d "$SUBNET" -j RETURN

echo "netguard: applied"
