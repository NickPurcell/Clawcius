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

start_bot() {   # start_bot <name> <command>
  name=$1; command=$2
  dir=$RUN_ROOT/$name; mkdir -p "$dir"
  ( cd "$dir" && while :; do
      echo "$(date -u +%FT%TZ) bots: starting $name" >> "$dir/supervise.log"
      sh -c "$command"; code=$?
      echo "$(date -u +%FT%TZ) bots: $name exited $code; restarting in 10s" >> "$dir/supervise.log"
      sleep 10
    done ) &
  PIDS="$PIDS $!"
}

start_all() {
  while IFS='|' read -r name crews command; do
    case "$name" in ''|'#'*) continue;; esac
    case ",$crews," in *",$CREW,"*|*",*,"*) start_bot "$name" "$command";; esac
  done < "$MANIFEST"
}

stop_all() {
  for pid in $PIDS; do pkill -TERM -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; done
  PIDS=""
}

trap 'stop_all; start_all' HUP
trap 'stop_all; exit 0' TERM INT
start_all
while :; do sleep 3600 & wait $!; done
