# Phase 0 spike B: the shared computer's first draft. Headful Chromium on one large Xvfb display, pi-env for Pi's tools,
# and a tiny local site for tests. The real image (Phase 1) starts from rakazo's infra/sandboxes/computer.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini chromium xvfb procps python3 ca-certificates fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -d /home/noid -u 1000 -s /bin/bash noid
COPY --chmod=755 pi-env /opt/pi-env/pi-env
COPY --chmod=755 start.sh /opt/noid/start.sh
COPY site /opt/noid/site
USER noid
WORKDIR /home/noid
ENV DISPLAY=:99
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/noid/start.sh"]
