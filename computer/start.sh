#!/bin/sh
# The computer's main process (under tini): the folders bots work in, and the display their browser windows share.
mkdir -p "$HOME/bots" "$HOME/shared" "$HOME/.local/bin"
# /tmp survives `docker restart`: a display that stopped hard leaves its lock, and Xvfb would refuse to start.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 3840x2160x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
exec sleep infinity
