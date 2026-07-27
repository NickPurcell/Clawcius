#!/usr/bin/env bash
# Start (or restart) the persistent Clawcius agent container.
#
# The container is long-lived on purpose: the agent lives here, so cron jobs,
# daemons and its own Discord bots keep running between turns. The waker
# attaches per session with `docker exec`; this container only has to outlive
# them.
#
# Treat it as disposable. Everything worth keeping is on the workspace mount or
# pushed to git — a wedged container should be replaced, not repaired.
set -euo pipefail

NAME=clawcius-agent
IMAGE=clawcius-agent:latest
ENV_FILE=/home/npurcell/clawcius/.env

# Paths are mirrored host->container deliberately. Claude Code derives its
# transcript directory from cwd, so a workspace mounted anywhere else would
# silently start a new session instead of resuming.
WORKSPACES=/var/lib/clawcius/workspaces
# The agent drops wake-request JSON here; the waker watches it.
WAKE_DIR=/var/lib/clawcius/run
SKILLS=/home/npurcell/clawcius/.claude
DISCORD_CLI=/home/npurcell/clawcius/discord-cli

# Two paths out of the host user's Claude home, rather than the whole thing.
#
# The operator asked to mount ~/.claude so the agent uses their OAuth login.
# Mounting it wholesale worked, but the agent's Claude Code immediately wrote
# a .claude.json into it — the agent and the host user would be sharing (and
# overwriting) one config directory: settings, shell snapshots, history, todos.
#
# These two give the same result with far less collateral:
#   .credentials.json  the OAuth login  (read-write; refresh rewrites it)
#   projects/          session transcripts, so the existing session resumes
#
# Everything else the agent's Claude Code wants stays inside the container.
#
# The security trade is unchanged and was accepted deliberately: whatever can
# compromise the agent can read and modify those credentials. gVisor contains
# the kernel, not a directory you hand it.
CLAUDE_CREDS=/home/npurcell/.claude/.credentials.json
CLAUDE_PROJECTS=/home/npurcell/.claude/projects
AGENT_CLAUDE=/home/agent/.claude-agent

mkdir -p "$WAKE_DIR"
[ -d "$WORKSPACES" ]      || { echo "missing $WORKSPACES" >&2; exit 1; }
[ -f "$CLAUDE_CREDS" ]    || { echo "missing $CLAUDE_CREDS — is the host logged in?" >&2; exit 1; }
[ -d "$CLAUDE_PROJECTS" ] || { echo "missing $CLAUDE_PROJECTS" >&2; exit 1; }

docker rm -f "$NAME" >/dev/null 2>&1 || true

# clawcius-internal has NO gateway to the outside. The only reachable thing
# with a route out is Squid, which enforces the domain allowlist. That is what
# makes the proxy enforcement rather than a suggestion: unsetting HTTPS_PROXY
# does not reveal a second path, it just removes the only one.
PROXY=http://172.31.250.2:3128

docker run -d \
  --name "$NAME" \
  --runtime=runsc \
  --restart unless-stopped \
  --network clawcius-internal \
  --env-file "$ENV_FILE" \
  -e HTTP_PROXY="$PROXY"  -e http_proxy="$PROXY" \
  -e HTTPS_PROXY="$PROXY" -e https_proxy="$PROXY" \
  -e NO_PROXY=localhost,127.0.0.1 -e no_proxy=localhost,127.0.0.1 \
  -e CLAUDE_CONFIG_DIR="$AGENT_CLAUDE" \
  -e HOME=/home/agent \
  -v "$WORKSPACES:$WORKSPACES:rw" \
  -v "$WAKE_DIR:$WAKE_DIR:rw" \
  -v "$CLAUDE_CREDS:$AGENT_CLAUDE/.credentials.json:rw" \
  -v "$CLAUDE_PROJECTS:$AGENT_CLAUDE/projects:rw" \
  -v "$SKILLS:$SKILLS:ro" \
  -v "$DISCORD_CLI:$DISCORD_CLI:ro" \
  -w "$WORKSPACES" \
  --memory=2g \
  --pids-limit=512 \
  "$IMAGE" >/dev/null

# Never mount the docker socket in here. It would let the agent start a
# privileged container mounting the host filesystem, which makes gVisor
# decorative. If it ever needs host-side work done, that goes through the
# waker's wake socket instead.

echo "started $NAME"
docker ps --filter "name=$NAME" --format '  {{.Names}}  {{.Status}}  runtime-isolated'
