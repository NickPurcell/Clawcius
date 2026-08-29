#!/bin/sh
# Container entrypoint: keep every bot in bots/manifest whose crew matches $CREW running.
# manifest lines: name|crews|command   (crews: comma-separated names, or *). $BOTS_DIR is this directory.
# SIGHUP restarts every bot (sent by deploy.sh after a deploy); SIGTERM stops them and exits.
set -u
BOTS_DIR=${BOTS_DIR:-$(cd "$(dirname "$0")" && pwd)}
export BOTS_DIR
RUN_ROOT=${BOTS_RUN:-/var/lib/${CREW:?CREW is not set}/workspaces/.bots}
MANIFEST=$BOTS_DIR/manifest
PIDS=""

# Each bot's restart loop is its own session, so killing the group takes the loop and the bot together.
start_bot() {   # start_bot <name> <command>
  dir=$RUN_ROOT/$1; mkdir -p "$dir"
  setsid sh -c 'cd "$1" && while :; do
      echo "$(date -u +%FT%TZ) bots: starting $2" >> supervise.log
      sh -c "$3"; code=$?
      echo "$(date -u +%FT%TZ) bots: $2 exited $code; restarting in 10s" >> supervise.log
      sleep 10
    done' bot-loop "$dir" "$1" "$2" &
  PIDS="$PIDS $!"
}

start_all() {
  while IFS='|' read -r name crews command; do
    case "$name" in ''|'#'*) continue;; esac
    case ",$crews," in *",$CREW,"*|*",*,"*) start_bot "$name" "$command";; esac
  done < "$MANIFEST"
}

stop_all() {
  for pid in $PIDS; do kill -TERM -"$pid" 2>/dev/null; done
  PIDS=""
}

trap 'stop_all; start_all' HUP
trap 'stop_all; exit 0' TERM INT
start_all
while :; do sleep 3600 & wait $!; done
