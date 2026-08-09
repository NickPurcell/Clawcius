#!/usr/bin/env bash
# Clear the ops executor's freeze.
#
# The executor freezes after `breaker.maxConsecutiveFailedRecoveries`
# consecutive missed check-ins: something is wrong that redeploying cannot fix,
# and continuing would mean reinstalling the outage on a timer.
#
# There is deliberately no `unfreeze` verb. Unfreezing is a decision made after
# looking at WHY it froze, and an agent that can unfreeze the breaker holding
# back its own broken build is exactly where we started. So this is a script on
# the host, run by a person, and it prints what it is about to clear first.
#
# The quarantine list is NOT cleared. A build that failed to come back does not
# become trustworthy because someone unfroze the executor — commit a fix, and
# the new sha goes through on its own.
set -euo pipefail

STATE=${OPS_STATE_DIR:-/var/lib/clawcius-ops}/state.json

if [ ! -f "$STATE" ]; then
  echo "no state file at $STATE — nothing to unfreeze" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Edit $STATE by hand: set frozen to false, frozenReason" >&2
  echo "to \"\", frozenAt and consecutiveFailedRecoveries to 0." >&2
  exit 1
fi

FROZEN=$(jq -r '.frozen' "$STATE")
if [ "$FROZEN" != "true" ]; then
  echo "not frozen; nothing to do"
  jq -r '"consecutive failed recoveries: \(.consecutiveFailedRecoveries)"' "$STATE"
  exit 0
fi

echo "Frozen since: $(jq -r '.frozenAt | if . > 0 then (./1000 | todate) else "unknown" end' "$STATE")"
echo "Reason:       $(jq -r '.frozenReason' "$STATE")"
echo
echo "Quarantined builds (NOT cleared by this script):"
jq -r '.quarantined[] | "  \(.instance)  \(.build[0:12])  \(.reason)"' "$STATE"
echo
read -r -p "Clear the freeze? [y/N] " answer
case "$answer" in
  y|Y) ;;
  *) echo "left frozen"; exit 0 ;;
esac

TMP=$(mktemp "${STATE}.XXXXXX")
jq '.frozen = false | .frozenReason = "" | .frozenAt = 0 | .consecutiveFailedRecoveries = 0' \
  "$STATE" > "$TMP"
chmod --reference="$STATE" "$TMP" 2>/dev/null || chmod 0640 "$TMP"
mv "$TMP" "$STATE"

echo "cleared. Restart the executor so it re-reads the state:"
echo "    sudo systemctl restart clawcius-ops"
