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

# The agent's own Claude home — deliberately not the host user's. Session
# transcripts get copied in; the host's OAuth credentials stay out.
ENV CLAUDE_CONFIG_DIR=/home/agent/.claude-agent
RUN mkdir -p ${CLAUDE_CONFIG_DIR} && chown -R ${AGENT_UID}:${AGENT_GID} /home/agent

USER agent
WORKDIR /var/lib/clawcius/workspaces

# The container's job is to stay up. The waker attaches per session with
# `docker exec`, so this process only has to outlive them.
CMD ["sleep", "infinity"]
