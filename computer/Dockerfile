# noid's shared computer: every computer bot works here, each in bots/<id>, with shared/ for work they share, and one
# headful Chromium on one display (a window per bot). Pi's tools reach it through pi-env's daemon over `docker exec -i`.
#
# Adapted from rakazo's infra/sandboxes/computer/Dockerfile (Apache-2.0, see LICENSE-rakazo): its tool set, the pinned
# and checksummed uv and gh downloads, the UTF-8 locale, uv's folders in the home, and restoring ~/.local/bin on PATH.
# Changed for noid: no VNC/noVNC stack, screen capture library, or fluxbox (the browser is driven over CDP); tini as
# PID 1 so finished processes are reaped; pi-env's daemon (put beside this file by the build) at /opt/pi-env/pi-env.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    xvfb \
    chromium \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-noto-cjk \
    ca-certificates \
    procps \
    bash \
    curl \
    git \
    jq \
    openssh-client \
    unzip \
    python3 \
    python3-openpyxl \
    poppler-utils \
    pandoc \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 noid \
  && useradd --uid 1000 --gid noid --create-home --shell /bin/bash noid
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
    DISPLAY=:99 \
    HOME=/home/noid \
    PATH=/home/noid/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    UV_TOOL_DIR=/home/noid/.local/share/uv/tools \
    UV_TOOL_BIN_DIR=/home/noid/.local/bin \
    UV_PYTHON_INSTALL_DIR=/home/noid/.local/share/uv/python \
    UV_CACHE_DIR=/home/noid/.cache/uv
COPY --chmod=755 pi-env /opt/pi-env/pi-env
COPY --chmod=755 start.sh /opt/noid/start.sh
# Strip CR so the shebang works even from a CRLF checkout (rakazo does the same).
RUN sed -i 's/\r$//' /opt/noid/start.sh
USER 1000:1000
WORKDIR /home/noid
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/noid/start.sh"]
