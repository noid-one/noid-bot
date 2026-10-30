# noid's shared computer: every computer bot works here, each in bots/<id>, with shared/ for work they share, on one
# real desktop (a window manager, a session bus) with one ordinary Chromium on it: the owner uses it there by hand, and
# bots reach it over DevTools while they work, a tab each. Pi's tools reach the computer through pi-env's daemon over
# `docker exec -i`.
#
# Adapted from rakazo's infra/sandboxes/computer/Dockerfile (Apache-2.0, see LICENSE-rakazo): its tool set, the pinned
# and checksummed uv and gh downloads, the UTF-8 locale, uv's folders in the home, and restoring ~/.local/bin on PATH.
# Also from rakazo: fluxbox and dbus for a real desktop, WebGL on SwiftShader, and the browser's launcher (noid-browser).
# hsetroot paints the desktop: without a wallpaper setter, fluxbox shows an error box at every start. tzdata: the
# computer keeps the owner's time zone (TZ, set when the container is made), its clock and its browser's both.
# Changed for noid: no VNC/noVNC stack (the owner sees the desktop through xdotool and scrot); tini as PID 1 so finished
# processes are reaped; pi-env's daemon (put beside this file by the build) at /opt/pi-env/pi-env.
# Homebrew: its prefix (/home/linuxbrew, a volume of its own) belongs to noid, so brew installs without sudo, and
# build-essential and file are what it needs on Linux; its bin/ is on PATH after the system's, so it adds tools
# without shadowing Debian's. ffmpeg from Debian, for audio and video work.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    tzdata \
    xvfb \
    fluxbox \
    dbus-x11 \
    hsetroot \
    xdotool \
    scrot \
    xterm \
    chromium \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    ca-certificates \
    procps \
    libatomic1 \
    bash \
    curl \
    git \
    jq \
    openssh-client \
    unzip \
    python3 \
    python-is-python3 \
    python3-openpyxl \
    poppler-utils \
    pandoc \
    ffmpeg \
    build-essential \
    file \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 noid \
  && useradd --uid 1000 --gid noid --create-home --shell /bin/bash noid \
  && install -d -o noid -g noid /home/linuxbrew
ARG TARGETARCH
ARG UV_VERSION=0.12.19
RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) uv_arch=x86_64; uv_sha256=23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8 ;; \
    arm64) uv_arch=aarch64; uv_sha256=0804e9b164c64b6914182d5920c08551958a095986f10a3731056df701126436 ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  archive="$(mktemp)"; \
  curl -fsSL "https://releases.astral.sh/github/uv/releases/download/${UV_VERSION}/uv-${uv_arch}-unknown-linux-gnu.tar.gz" -o "$archive"; \
  echo "$uv_sha256  $archive" | sha256sum -c -; \
  tar -xzf "$archive" -C /usr/local/bin --strip-components=1 "uv-${uv_arch}-unknown-linux-gnu/uv" "uv-${uv_arch}-unknown-linux-gnu/uvx"; \
  rm -f "$archive"; \
  uv --version
ARG GH_VERSION=2.100.0
RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) gh_arch=amd64; gh_sha256=e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be ;; \
    arm64) gh_arch=arm64; gh_sha256=ea4e7a581a32ccad6cc7923cb1576ac5859ba4b9a16ab22eb8f8a96e78e2e961 ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  archive="$(mktemp)"; \
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gh_arch}.tar.gz" -o "$archive"; \
  echo "$gh_sha256  $archive" | sha256sum -c -; \
  tar -xzf "$archive" -C /usr/local/bin --strip-components=2 "gh_${GH_VERSION}_linux_${gh_arch}/bin/gh"; \
  rm -f "$archive"; \
  gh --version
ENV LANG=C.UTF-8 \
    DISPLAY=:100 \
    HOME=/home/noid \
    PATH=/home/noid/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin \
    UV_TOOL_DIR=/home/noid/.local/share/uv/tools \
    UV_TOOL_BIN_DIR=/home/noid/.local/bin \
    UV_PYTHON_INSTALL_DIR=/home/noid/.local/share/uv/python \
    UV_CACHE_DIR=/home/noid/.cache/uv
COPY --chmod=755 pi-env /opt/pi-env/pi-env
COPY --chmod=755 start.sh /opt/noid/start.sh
COPY --chmod=755 cdp-bridge.py /opt/noid/cdp-bridge.py
COPY --chmod=755 noid-browser /usr/local/bin/noid-browser
COPY fluxbox/ /etc/noid/fluxbox/
# No save-password, address, or card prompts over the page: bots sign in with cookies brought from the owner's own
# browser, and the bubbles only covered what they look at (rakazo 9da068ea7). The folder first, so it stays traversable.
RUN mkdir -p /etc/chromium/policies/managed
COPY --chmod=644 browser-policy.json /etc/chromium/policies/managed/noid-browser.json
# Strip CR so the shebang works even from a CRLF checkout (rakazo does the same).
RUN sed -i 's/\r$//' /opt/noid/start.sh /opt/noid/cdp-bridge.py /usr/local/bin/noid-browser
USER 1000:1000
WORKDIR /home/noid
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/noid/start.sh"]
