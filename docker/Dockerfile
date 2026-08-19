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
      tzdata \
    && rm -rf /var/lib/apt/lists/*

# Node for anything the agent writes in JS, and because Discord tooling
# generally assumes it. The claude binary itself is static and needs none of it.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

# Headless Chromium, so an agent can see the pages it builds. `browser-cli/`
# drives it; that directory is bind-mounted and needs no rebuild, this does.
#
# The argument for the size is Clawcius #11. `status/` was built end to end
# without anyone ever looking at it, and the one real defect in it was found by
# the operator sending a screenshot back. An agent can read a PNG directly, so
# a rendered page is evidence it can produce for itself instead of asking.
#
# This is the largest thing in the image: roughly 650 MB of browser and 150 MB
# of the X, GTK and font libraries chromium links against. Two of those 650 are
# installed because `playwright install chromium` fetches both the full browser
# and `chrome-headless-shell`; the shell alone is 260 MB and is all `browse`
# actually launches. Dropping to `playwright install chromium-headless-shell`
# is the first thing to try if the image size ever bites, and it is not done
# here because the two-browser form is the supported path and a missing full
# chromium would only be discovered by needing another rebuild.
#
# PLAYWRIGHT_BROWSERS_PATH is set BEFORE the install, and that ordering is
# load-bearing. Playwright's default location is per-user
# (~/.cache/ms-playwright); this RUN executes as root and the agent runs as
# `agent`, so without it the browser lands in root's home where the agent
# cannot reach it, and the failure appears at first use rather than at build.
#
# The pip version is pinned because that is what makes a rebuild reproducible.
# `playwright install` downloads the browser revision the installed package
# expects, so pinning the package pins the browser; unpinned, two builds of the
# same commit could ship different chromiums. To bump: raise the version,
# rebuild, and run `python3 browser-cli/test_browse.py`.
#
# Fonts are named explicitly rather than left to `--with-deps`. Without them a
# page does not fail, it renders every glyph as a hollow box — a screenshot
# that is worse than none, because it looks like a bug in the page.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN apt-get update \
    && pip3 install --no-cache-dir --break-system-packages playwright==1.62.0 \
    && playwright install --with-deps chromium \
    && apt-get install -y --no-install-recommends \
         fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX ${PLAYWRIGHT_BROWSERS_PATH}

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
#
# `sleep infinity` never calls wait(), which is why it is the wrong thing to
# have at pid 1: every orphaned process in a PID namespace is reparented to
# pid 1, so anything orphaned there becomes a zombie that nothing will ever
# reap, against --pids-limit=512. Measured in the running container on
# 2026-08-17, before the fix: 92 of 99 processes were zombies, every one with
# PPid 1, across fifteen different programs.
#
# It is not pid 1 WHEN THE CONTAINER IS CREATED BY docker/run-container.sh,
# which passes --init (Clawcius #74): Docker's tini is pid 1, it reaps orphans,
# and this runs as its child. Every word of that qualifier is load-bearing.
# `docker run` of this image from anywhere else gets no init — ops/src/verify.ts
# builds its own, and is fine only because it removes the container each run.
# Nor does it reach a container that already exists, since that script reuses
# by design and a run flag applies only at creation; the two long-lived
# instances predate #74 and leak until each is recreated (#84).
#
# THAT LAST CLAUSE IS DATED, BECAUSE IT IS ABOUT A CONTAINER AND NOT ABOUT THIS
# FILE. On 2026-08-17 both reported HostConfig.Init null. On 2026-08-18
# hamachi-agent had been recreated and reported /proc/1/comm = docker-init with
# a zombie count of 0; clawcius-agent had not. Neither sentence can stay true by
# itself, and a recreate that happens after this line is written will not come
# back and edit it. `docker exec <name> cat /proc/1/comm` settles which case you
# are looking at, for the container you are actually asking about.
#
# DO NOT DROP THAT FLAG ON THE ASSUMPTION THAT THIS LINE IS HARMLESS. Nothing
# in this image reaps anything, and the only thing stopping the leak is a flag
# in a script in another directory. Fixing it here instead — an ENTRYPOINT
# that reaps — would mean shipping and maintaining an init in the image to get
# what Docker already ships.
CMD ["sleep", "infinity"]
