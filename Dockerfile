FROM node:22-bookworm@sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Install core audio and music player dependencies
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      mpd \
      mpc \
      alsa-utils \
      pulseaudio-utils && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Configure MPD for container use (runs as 'node' user)
  # Install gog CLI (Google Workspace CLI for Gmail, Calendar, Drive, etc.)
  RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    curl ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* && \
    LATEST_TAG=$(curl -s https://api.github.com/repos/steipete/gogcli/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4) && \
    if [ -n "$LATEST_TAG" ]; then \
    DOWNLOAD_URL="https://github.com/steipete/gogcli/releases/download/${LATEST_TAG}/gogcli_${LATEST_TAG#v}_linux_amd64.tar.gz" && \
    curl -L "$DOWNLOAD_URL" -o /tmp/gog.tar.gz 2>&1 && \
    cd /tmp && \
    tar -xzf gog.tar.gz && \
    if [ -f "gog" ]; then \
    chmod +x gog && \
    mv gog /usr/local/bin/gog && \
    rm -f /tmp/gog.tar.gz; \
    else \
    echo "Warning: Could not extract gog binary from archive"; \
    fi; \
    else \
    echo "Warning: Could not determine latest gog version"; \
    fi

  # Configure MPD for container use (runs as 'node' user)
# Configuration will be in /home/node/.mpd/
RUN mkdir -p /home/node/.mpd/playlists && \
    echo 'music_directory     "/music"' > /home/node/.mpd/mpd.conf && \
    echo 'playlist_directory  "/home/node/.mpd/playlists"' >> /home/node/.mpd/mpd.conf && \
    echo 'db_file             "/home/node/.mpd/database"' >> /home/node/.mpd/mpd.conf && \
    echo 'log_file            "/home/node/.mpd/mpd.log"' >> /home/node/.mpd/mpd.conf && \
    echo 'pid_file            "/home/node/.mpd/pid"' >> /home/node/.mpd/mpd.conf && \
    echo 'state_file          "/home/node/.mpd/state"' >> /home/node/.mpd/mpd.conf && \
    echo 'sticker_file        "/home/node/.mpd/sticker.sql"' >> /home/node/.mpd/mpd.conf && \
    echo 'bind_to_address     "localhost"' >> /home/node/.mpd/mpd.conf && \
    echo 'port                "6600"' >> /home/node/.mpd/mpd.conf && \
    echo 'auto_update         "yes"' >> /home/node/.mpd/mpd.conf && \
    echo 'audio_output {' >> /home/node/.mpd/mpd.conf && \
    echo '    type        "pulse"' >> /home/node/.mpd/mpd.conf && \
    echo '    name        "PulseAudio Output"' >> /home/node/.mpd/mpd.conf && \
    echo '}' >> /home/node/.mpd/mpd.conf && \
    chown -R node:node /home/node/.mpd

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after pnpm install so playwright-core is available in node_modules.
ARG OPENCLAW_INSTALL_BROWSER=""
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
#
# Start MPD daemon, then gateway
CMD ["/bin/bash", "-c", "mpd /home/node/.mpd/mpd.conf 2>/dev/null || true && mpc update 2>/dev/null || true && exec node openclaw.mjs gateway --allow-unconfigured"]
