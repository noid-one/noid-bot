#!/bin/sh
# The computer's main process (under tini): the folders bots work in, and its desktop. The desktop is a real one, as
# rakazo's: a window manager with a taskbar, a session bus, and the one browser (noid-browser), which the owner uses
# there by hand and bots reach over DevTools while they work.
mkdir -p "$HOME/bots" "$HOME/shared" "$HOME/.local/bin" /tmp/noid
# /tmp survives `docker restart`: a display that stopped hard leaves its lock, and Xvfb would refuse to start.
rm -f /tmp/.X100-lock /tmp/.X11-unix/X100
Xvfb :100 -screen 0 1280x800x24 -nolisten tcp >/tmp/noid/xvfb.log 2>&1 &

i=0
while [ ! -S /tmp/.X11-unix/X100 ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done

# Chromium expects a session bus; programs started later (the browser, from noid-browser) find it in this file.
eval "$(dbus-launch --sh-syntax)"
printf "export DBUS_SESSION_BUS_ADDRESS='%s'\n" "$DBUS_SESSION_BUS_ADDRESS" >/tmp/noid/dbus-session

# fluxbox writes its settings back: a copy of noid's in a home of its own.
mkdir -p /tmp/noid/fluxbox/.fluxbox
cp /etc/noid/fluxbox/init /tmp/noid/fluxbox/.fluxbox/init
HOME=/tmp/noid/fluxbox fluxbox -rc /tmp/noid/fluxbox/.fluxbox/init >/tmp/noid/fluxbox.log 2>&1 &

exec sleep infinity
