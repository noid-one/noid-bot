#!/bin/sh
# The computer's main process: the display all bot windows share, and a local test site on port 8000.
# /tmp survives `docker restart`; a display that stopped hard leaves its lock behind, and Xvfb then refuses to start.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 3840x2160x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
cd /opt/noid/site && python3 -m http.server 8000 --bind 127.0.0.1 >/tmp/site.log 2>&1 &
exec sleep infinity
