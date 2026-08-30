#!/bin/bash
# deploy.sh <clawcius|oj> [ref]   — build the tip of origin/<ref> into a release, switch to it,
# restart the services, check they came up, revert if they did not. Idempotent: an already
# deployed sha is a no-op. Runs as root (deploy@.service, or Hamachi via sudo).
set -euo pipefail

REPO=${1:?usage: deploy.sh <clawcius|oj> [ref]}
REF=${2:-main}
ROOT=/srv/$REPO
BUILD_USER=hamachi
KEEP=5
case $REPO in
  clawcius) UNITS="clawcius-status clawcius hamachi"; CREWS="clawcius hamachi"; DM_OK="clawcius"; DM_FAIL="clawcius hamachi" ;;
  oj)       UNITS="oj";                              CREWS="";                DM_OK="hamachi";  DM_FAIL="hamachi" ;;
  *) echo "unknown repo $REPO" >&2; exit 2 ;;
esac

exec 9>/run/lock/deploy-$REPO.lock; flock -w 600 9
log() { echo "deploy[$REPO]: $*"; }

# Refuse to switch the services onto a box that is not ready for them.
if [ $REPO = clawcius ]; then
  for f in /etc/clawcius/clawcius.env /etc/clawcius/hamachi.env; do
    [ -s "$f" ] || { log "$f is missing or empty; put the crew's secrets there first (SETUP.md § 3)"; exit 3; }
  done
  [ "$(stat -c %U /var/lib/hamachi)" = hamachi ] || { log "/var/lib/hamachi is not owned by hamachi; chown -R hamachi:hamachi /var/lib/hamachi first"; exit 3; }
fi
as_builder() { runuser -u $BUILD_USER -- env PATH="/usr/local/bin:/usr/bin:/bin" "$@"; }

# A request file from a crew: the first line names a ref, later lines say why
# and ride into the result mail. The timer, with neither, deploys main.
REQUEST=/var/lib/hamachi/run/deploy-$REPO
TIMER=0; [ -z "${2:-}" ] && [ ! -f "$REQUEST" ] && TIMER=1
NOTE=""; HAD_REQUEST=0
if [ -f "$REQUEST" ]; then
  REF=$(head -1 "$REQUEST" | tr -cd 'A-Za-z0-9._/-')
  NOTE=$(tail -n +2 "$REQUEST" | tr -d '\r' | head -c 400)
  rm -f "$REQUEST"; HAD_REQUEST=1
fi
MAIN_SEEN=$ROOT/main-seen

# mail_result <true|false> <reason> — single quotes doubled: the values land in a SQL literal.
mail_result() {
  local now title subject body crews crew db owner
  now=$(date +%s%3N)
  title=""; [ -n "${SHA:-}" ] && title=" — $(as_builder git -C $ROOT/src log -1 --format=%s $SHA)"
  subject="deploy $REPO ${SHA:0:8}: $2"
  body="$REPO at $REF (${SHA:0:8}) $2$title.${NOTE:+ Requested: $NOTE.} $(date -u +%FT%TZ)"
  subject=${subject//\'/\'\'}; body=${body//\'/\'\'}
  # Only a timer success narrows: a requested deploy mails its requester (Hamachi) on every outcome.
  crews=$DM_FAIL; [ "$1" = true ] && [ $HAD_REQUEST = 0 ] && crews=$DM_OK
  for crew in $crews; do
    db=/var/lib/$crew/$crew.db; owner=$(stat -c %U $db)
    runuser -u "$owner" -- sqlite3 "$db" "INSERT INTO mail (author, recipient, subject, body, sent_at) SELECT 'deploy', id, '$subject', '$body', $now FROM agents WHERE role='coordinator' AND status='live';" || log "could not DM $crew"
  done
  log "deploy $REPO ${SHA:0:8}: $2"
}

as_builder git -C $ROOT/src fetch -q --prune origin
SHA=$(as_builder git -C $ROOT/src rev-parse --verify -q "origin/$REF^{commit}" || as_builder git -C $ROOT/src rev-parse --verify -q "$REF^{commit}") \
  || { SHA=""; [ $HAD_REQUEST = 1 ] && mail_result false "no such ref on origin: $REF"; log "no such ref on origin: $REF"; exit 3; }
[ -n "$(as_builder git -C $ROOT/src branch -r --contains $SHA)" ] || { log "$REF is not on any origin branch"; exit 3; }
CURRENT=$(readlink -e $ROOT/current 2>/dev/null || true)
if [ "$CURRENT" = "$ROOT/releases/$SHA" ]; then
  for u in $UNITS; do
    [ "$(systemctl is-active $u.service)" = active ] || { log "already at ${SHA:0:8}; starting $u.service"; systemctl reset-failed $u.service 2>/dev/null; systemctl start $u.service || true; }
  done
  [ $REF = main ] && echo $SHA > $MAIN_SEEN
  [ $HAD_REQUEST = 1 ] && mail_result true "already deployed; nothing changed"
  exit 0
fi
[ $TIMER = 1 ] && [ "$(cat $MAIN_SEEN 2>/dev/null)" = "$SHA" ] && exit 0
log "deploying $REF at ${SHA:0:8} (was ${CURRENT##*/})"

# Build in a new directory; nothing that is running is touched until the switch.
RELEASE=$ROOT/releases/$SHA
if [ ! -d "$RELEASE" ]; then
  as_builder git -C $ROOT/src worktree add -q --detach "$RELEASE" "$SHA"
fi
as_builder bash -c "cd '$RELEASE' && npm ci --silent && npm run build --silent"
if [ $REPO = clawcius ]; then
  as_builder bash -c "cd '$RELEASE/status' && npm ci --silent && npm run build --silent"
fi

switch_to() {   # switch_to <release dir>
  ln -sfn "$1" $ROOT/current.new && mv -T $ROOT/current.new $ROOT/current
  if [ $REPO = clawcius ]; then
    install -m 0644 -o root -g root "$1"/systemd/*.service "$1"/systemd/*.timer "$1"/systemd/*.path /etc/systemd/system/ 2>/dev/null || true
    install -d -m 0755 /usr/local/lib/clawcius
    install -m 0755 -o root -g root "$1"/docker/netguard.sh /usr/local/lib/clawcius/netguard.sh
  else
    install -m 0644 -o root -g root "$1"/systemd/oj.service /etc/systemd/system/
  fi
  install -m 0755 -o root -g root "$1/deploy/deploy.sh" /usr/local/sbin/deploy   # the next run uses the release's own copy
  systemctl daemon-reload
  for u in $UNITS; do systemctl restart $u.service || true; done   # the health check decides
  # Reload the bots supervisor if the container runs one; an older container has none to signal.
  [ $REPO = clawcius ] && docker exec clawcius-agent pkill -HUP -f bots/supervise.sh >/dev/null 2>&1 || true
}

healthy() {     # healthy <sha> — every unit active, not restarting, and reporting <sha>
  local sha=$1 deadline=$((SECONDS + 90))
  while [ $SECONDS -lt $deadline ]; do
    sleep 5; local ok=1
    for u in $UNITS; do
      [ "$(systemctl show -p ActiveState --value $u.service)" = active ] || ok=0
      [ "$(systemctl show -p NRestarts --value $u.service)" = 0 ] || ok=0
    done
    for c in $CREWS; do
      grep -q "\"commit\": *\"$sha\"" /var/lib/$c/waker-status.json 2>/dev/null || ok=0
      [ $(( $(date +%s) - $(stat -c %Y /var/lib/$c/waker-status.json 2>/dev/null || echo 0) )) -lt 60 ] || ok=0
    done
    [ $ok = 1 ] && return 0
  done
  return 1
}

for u in $UNITS; do systemctl reset-failed $u.service 2>/dev/null || true; done
switch_to "$RELEASE"
if healthy "$SHA"; then
  OK=true; REASON="live"
else
  OK=false; REASON="failed the health check"
  if [ -n "$CURRENT" ] && [ -d "$CURRENT" ]; then
    log "reverting to ${CURRENT##*/}"; switch_to "$CURRENT"; REASON="failed the health check; reverted to ${CURRENT##*/}"
  else
    log "no previous release to revert to; the services are left on $SHA — read journalctl -u $UNITS"
  fi
fi

# Prune old releases; keep the current, the previous, and the newest few.
for old in $(ls -1dt $ROOT/releases/* 2>/dev/null | tail -n +$((KEEP + 1))); do
  case "$old" in "$RELEASE"|"$CURRENT") continue;; esac
  as_builder git -C $ROOT/src worktree remove --force "$old" || rm -rf "$old"
done

mail_result $OK "$REASON"
[ $REF = main ] && echo $SHA > $MAIN_SEEN
[ $OK = true ]
