# Clawcius agent container.
#
# Long-lived and gVisor-isolated: the agent process lives here permanently
# rather than being wrapped per bash command. That is what lets it run daemons,
# cron jobs and its own Discord bots between turns, and what makes
# --dangerously-skip-permissions defensible — gVisor intercepts syscalls in
# userspace, so nothing the agent does reaches the host kernel.
#
# Treat this image as disposable. Everything worth keeping lives on the mounted
# workspace volume or in git; a wedged container should be fixed by replacing
# it, not by repairing it in place.

FROM debian:bookworm-slim

# Toolchain the agent is expected to reach for. yt-dlp and ffmpeg are here
# because "download a video and repost it" is a first-class use case, and
# discovering they are missing mid-task wastes a turn.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client \
      python3 python3-pip python3-venv \
      ripgrep jq ffmpeg \
      cron procps less nano \
    && rm -rf /var/lib/apt/lists/*

# Node for anything the agent writes in JS, and because Discord tooling
# generally assumes it. The claude binary itself is static and needs none of it.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

# Statically linked, so no glibc coupling to the base image. Verified to run
# correctly under runsc before this image existed.
COPY claude /usr/local/bin/claude
RUN chmod 0755 /usr/local/bin/claude

# uid/gid match the host's npurcell, so files on the mounted workspace keep
# consistent ownership either side of the boundary.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupadd -g ${AGENT_GID} agent \
    && useradd -m -u ${AGENT_UID} -g ${AGENT_GID} -s /bin/bash agent

# Paths mirror the host exactly. This is load-bearing rather than tidiness:
# Claude Code derives its transcript directory from cwd, so a workspace mounted
# anywhere else would silently start a new session instead of resuming.
RUN mkdir -p /var/lib/clawcius/workspaces /home/npurcell/clawcius \
    && chown -R ${AGENT_UID}:${AGENT_GID} /var/lib/clawcius

# The agent's own Claude home. Nothing here is shared with the host user: not
# settings, not history, and — as of 2026-08-04 — not the OAuth credential.
#
# The credential used to arrive from the host, first as a bind-mounted file and
# then as a symlink into a mounted ~/.claude. Both failed, for reasons worth
# recording so nobody reinstates them:
#
#   The file mount pinned an inode. A host token refresh writes a new file and
#   renames it into place, so the container stayed bolted to the old one.
#
#   The directory mount plus symlink was supposed to fix that by resolving
#   through the mount on each open. Under gVisor it does not. The gofer caches
#   the dentry, so a host-side rename is still invisible inside the sandbox —
#   measured on 2026-08-03, when hamachi-agent was reading a credential whose
#   sha256 did not match the host's, six days stale, while the host's was
#   current. Read-only made it worse: the container could not refresh for
#   itself either, so its credential could only ever decay.
#
# The fix is to stop propagating a credential across the boundary at all. This
# directory is bind-mounted from the instance's own state dir, read-write, and
# the container is its only writer. It runs `claude auth login --claudeai`
# once and from then on refreshes its own token exactly like Claude Code on any
# other machine — same subscription, no API billing, no shared refresh-token
# chain to invalidate anyone else's session.
ENV CLAUDE_CONFIG_DIR=/home/agent/.claude-agent
RUN mkdir -p ${CLAUDE_CONFIG_DIR} && chown -R ${AGENT_UID}:${AGENT_GID} /home/agent

USER agent
WORKDIR /var/lib/clawcius/workspaces

# The container's job is to stay up. The waker attaches per session with
# `docker exec`, so this process only has to outlive them.
CMD ["sleep", "infinity"]
