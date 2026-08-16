#!/usr/bin/env bash
# Clear the ops executor's freeze.
#
# NOTHING SETS THE FREEZE ANY MORE. It was set by the circuit breaker, which
# counted consecutive failed recoveries — a missed check-in, or a task that had
# to be rolled back — and every one of those inputs went with the spools on
# 2026-08-16. There are no rollbacks to count and no check-in to miss, so the
# breaker has no writer left. It is worth knowing the mechanism existed, because
# a rollback to an older `dist/` brings it back.
#
# What survives is the read side: the flag is still persisted in state.json,
# still reported at boot, and a frozen executor still refuses every task. It is
# still cleared here and nowhere else. So a freeze anybody is looking at now
# PREDATES the retirement — read it as history rather than as something that
# just happened, and expect no second one. Clawcius #63 is the open issue
# deciding what to do about a flag that can be cleared but not set.
#
# There is deliberately no `unfreeze` verb. Unfreezing is a decision made after
# looking at WHY it froze, and an agent that can unfreeze the breaker holding
# back its own broken build is exactly where we started. So this is a script on
# the host, run by a person, and it prints what it is about to clear first.
#
# Since 2026-08-10 that argument is weaker and it is worth saying so here rather
# than letting somebody assume otherwise: a `task` is free text carried out by a
# session with a shell, and "run ops/unfreeze.sh" is a thing a task can say. The
# script asks for confirmation on a terminal, which a headless session does not
# have, and every command that session runs is in the audit log. That is the
# whole of the protection now — a speed bump and a record, not a lock.
#
# This script does not clear the quarantine list, and since 2026-08-16 it does
# not need to: nothing quarantines any more. The only caller was the automatic
# rollback after a missed check-in, which went with the spools, and the executor
# now clears whatever the retired path left behind on its first boot
# (`Executor.reportRetiredDeadlines`). So the list this prints below is either
# empty or about to be. It is still printed, because a row in it is evidence
# about what happened on this host before the retirement, and reading it is the
# point of running this script at all.
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
