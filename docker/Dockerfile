# Clawcius agent container: long-lived, gVisor-isolated, disposable. Everything
# worth keeping lives on the mounted workspace volume or in git.

FROM debian:bookworm-slim

# Toolchain the agent is expected to reach for; yt-dlp and ffmpeg because
# "download a video and repost it" is a first-class use case.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client \
      python3 python3-pip python3-venv \
      ripgrep jq ffmpeg \
      cron procps less nano \
      tzdata \
    && rm -rf /var/lib/apt/lists/*

# Node for anything the agent writes in JS. The claude binary is static and needs none of it.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

# Headless Chromium for `browser-cli/`, which is bind-mounted and needs no
# rebuild; this does. PLAYWRIGHT_BROWSERS_PATH is set before the install
# because this RUN executes as root and the agent runs as `agent`, so the
# per-user default would land where the agent cannot reach it. The pip version
# is pinned because the package pins the browser revision. Fonts are named
# explicitly: without them a page renders every glyph as a hollow box.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN apt-get update \
    && pip3 install --no-cache-dir --break-system-packages playwright==1.62.0 \
    && playwright install --with-deps chromium \
    && apt-get install -y --no-install-recommends \
         fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX ${PLAYWRIGHT_BROWSERS_PATH}

# Statically linked, so no glibc coupling to the base image.
COPY claude /usr/local/bin/claude
RUN chmod 0755 /usr/local/bin/claude

# uid/gid match the host's npurcell, so files on the mounted workspace keep
# consistent ownership either side of the boundary.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupadd -g ${AGENT_GID} agent \
    && useradd -m -u ${AGENT_UID} -g ${AGENT_GID} -s /bin/bash agent

# Paths mirror the host: Claude Code derives its transcript directory from cwd,
# so a workspace mounted anywhere else would start a new session instead of
# resuming.
RUN mkdir -p /var/lib/clawcius/workspaces /srv/clawcius \
    && chown -R ${AGENT_UID}:${AGENT_GID} /var/lib/clawcius

# The agent's own Claude home, bind-mounted read-write from the instance's
# state dir. The container is its only writer and refreshes its own OAuth
# token; nothing here is shared with the host user.
ENV CLAUDE_CONFIG_DIR=/home/agent/.claude-agent
RUN mkdir -p ${CLAUDE_CONFIG_DIR} && chown -R ${AGENT_UID}:${AGENT_GID} /home/agent

USER agent
WORKDIR /var/lib/clawcius/workspaces

# The container's only job is to stay up; the waker attaches with `docker exec`.
# `sleep` never calls wait(), so it must not be pid 1: run-container.sh passes
# --init, which makes Docker's tini pid 1 to reap orphans against --pids-limit.
CMD ["sh", "-c", "if [ -n \"$BOTS_DIR\" ]; then exec \"$BOTS_DIR/supervise.sh\"; else exec sleep infinity; fi"]
